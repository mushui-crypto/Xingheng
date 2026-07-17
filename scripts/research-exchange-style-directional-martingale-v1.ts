import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import { BinanceVisionHistoricalDataSource, dayRange, monthRange } from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  EXCHANGE_MARTINGALE_CONFIG,
  simulateExchangeStyleDirectionalMartingale,
  type ExchangeMartingaleConfig,
  type ExchangeMartingaleCycle,
  type ExchangeMartingaleSimulation,
} from "../server/modules/strategy/research/ExchangeStyleDirectionalMartingaleEngine";
import { MARTINGALE_GRID_SYMBOLS, type MartingaleGridSymbol } from "../server/modules/strategy/runtime/MartingaleGridPaperEngine";

const evaluationStart = Date.parse("2024-01-01T00:00:00Z") / 1000;
const throughExclusive = Date.parse("2026-07-16T00:00:00Z") / 1000;
const auditDays = 60;
const auditSeed = "exchange-style-directional-v1-audit-2026-07-17";
const auditStart = selectAuditStart(evaluationStart, throughExclusive, auditDays, auditSeed);
const auditEnd = auditStart + auditDays * 86_400;
const source = new BinanceVisionHistoricalDataSource(undefined, path.resolve(".cache/strategy/binance-vision"));
const candlesBySymbol = {} as Record<MartingaleGridSymbol, Candle[]>;
const dataQuality = {} as Record<MartingaleGridSymbol, unknown>;

for (const symbol of MARTINGALE_GRID_SYMBOLS) {
  const monthly = await source.loadMonths(monthRange("2023-12", "2026-06", symbol));
  const daily = await source.loadDays(dayRange("2026-07-01", "2026-07-15", symbol));
  const candles = normalize([...monthly.candles, ...daily.candles]).filter((candle) => candle.time >= Date.parse("2023-12-02T00:00:00Z") / 1000 && candle.time < throughExclusive);
  const missing = missingBars(candles);
  if (missing !== 0) throw new Error(`${symbol} directional martingale history contains ${missing} missing bars.`);
  candlesBySymbol[symbol] = candles;
  const auditCandles = candles.filter((candle) => candle.time >= auditStart && candle.time < auditEnd);
  dataQuality[symbol] = {
    candleCount: candles.length,
    missingBarCount: missing,
    checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
    first: iso(candles[0]?.time ?? null),
    last: iso(candles.at(-1)?.time ?? null),
    auditCandleCount: auditCandles.length,
    auditFirst: iso(auditCandles[0]?.time ?? null),
    auditLast: iso(auditCandles.at(-1)?.time ?? null),
  };
  console.info(JSON.stringify({ event: "exchange_martingale_data_ready", symbol, candles: candles.length, auditCandles: auditCandles.length }));
}

const base = run(EXCHANGE_MARTINGALE_CONFIG);
const doubleCost = run({ ...EXCHANGE_MARTINGALE_CONFIG, takerFeeRate: EXCHANGE_MARTINGALE_CONFIG.takerFeeRate * 2, slippageRate: EXCHANGE_MARTINGALE_CONFIG.slippageRate * 2 });
const report = {
  routeId: "binance-usdm-exchange-style-directional-martingale-v1-research",
  generatedAt: new Date().toISOString(),
  status: qualifies(base, doubleCost) ? "historical_candidate_pending_future_paper" : "rejected",
  datasetRole: "historical_recalculation_seen_history_with_deterministic_60_day_audit",
  range: { from: "2024-01-01", through: "2026-07-15", warmupStart: "2023-12-02" },
  auditSelection: {
    seed: auditSeed,
    method: "fnv1a_modulo_valid_start_days",
    attributionField: "entryTime",
    days: auditDays,
    from: iso(auditStart),
    throughExclusive: iso(auditEnd),
  },
  assumptions: { leverageSelection: 20, noPendingOrderExpiry: true, noHoldingTimeout: true, automaticOrdersEnabled: false, fundingIgnored: true, markPriceAndDynamicLiquidationIgnored: true },
  dataQuality,
  base,
  doubleCost,
};
const output = path.resolve(process.env.EXCHANGE_MARTINGALE_HISTORY_REPORT_PATH ?? "server/data/strategy/research-exchange-style-directional-martingale-v1.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.info(JSON.stringify({ event: "exchange_martingale_research_complete", status: report.status, output, audit: report.auditSelection, base: base.full.combined, auditBase: base.audit.combined }));

function run(config: ExchangeMartingaleConfig) {
  const simulations = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, simulateExchangeStyleDirectionalMartingale(symbol, candlesBySymbol[symbol], { forwardStart: evaluationStart, config })])) as Record<MartingaleGridSymbol, ExchangeMartingaleSimulation>;
  return {
    config,
    years: Object.fromEntries([2024, 2025, 2026].map((year) => [year, summarize(simulations, Date.UTC(year, 0, 1) / 1000, Math.min(Date.UTC(year + 1, 0, 1) / 1000, throughExclusive))])),
    full: summarize(simulations, evaluationStart, throughExclusive),
    audit: summarize(simulations, auditStart, auditEnd, true),
    diagnostics: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, simulations[symbol].diagnostics])),
    terminalState: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, { selectedMode: simulations[symbol].selectedMode, open: simulations[symbol].open }])),
  };
}

function summarize(simulations: Record<MartingaleGridSymbol, ExchangeMartingaleSimulation>, start: number, end: number, includeSamples = false) {
  const bySymbol = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => {
    const cycles = simulations[symbol].completed.filter((cycle) => cycle.entryTime >= start && cycle.entryTime < end);
    const curve = simulations[symbol].equityCurve.filter((point) => point.time >= start && point.time < end);
    return [symbol, metrics(cycles, curve, includeSamples)];
  })) as Record<MartingaleGridSymbol, ReturnType<typeof metrics>>;
  const cycles = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].completed).filter((cycle) => cycle.entryTime >= start && cycle.entryTime < end).sort((left, right) => left.entryTime - right.entryTime);
  const btcCurve = simulations.BTCUSDT.equityCurve.filter((point) => point.time >= start && point.time < end);
  const ethCurve = simulations.ETHUSDT.equityCurve.filter((point) => point.time >= start && point.time < end);
  return {
    combined: metrics(cycles, btcCurve.map((point, index) => ({ time: point.time, equity: point.equity + (ethCurve[index]?.equity ?? EXCHANGE_MARTINGALE_CONFIG.initialEquity) })), includeSamples),
    bySymbol,
  };
}

function metrics(cycles: ExchangeMartingaleCycle[], curve: Array<{ equity: number }>, includeSamples: boolean) {
  const profit = cycles.filter((cycle) => cycle.netPnl > 0).reduce((sum, cycle) => sum + cycle.netPnl, 0);
  const loss = -cycles.filter((cycle) => cycle.netPnl < 0).reduce((sum, cycle) => sum + cycle.netPnl, 0);
  const result: Record<string, unknown> = {
    completedCycles: cycles.length,
    longCycles: cycles.filter((cycle) => cycle.side === "long").length,
    shortCycles: cycles.filter((cycle) => cycle.side === "short").length,
    takeProfits: cycles.filter((cycle) => cycle.exitReason === "cycle_take_profit").length,
    stops: cycles.filter((cycle) => cycle.exitReason === "cycle_stop").length,
    netPnl: cycles.reduce((sum, cycle) => sum + cycle.netPnl, 0),
    profitFactor: loss > 0 ? profit / loss : null,
    averageR: cycles.length ? cycles.reduce((sum, cycle) => sum + cycle.rMultiple, 0) / cycles.length : 0,
    fees: cycles.reduce((sum, cycle) => sum + cycle.fees, 0),
    averageLayers: cycles.length ? cycles.reduce((sum, cycle) => sum + cycle.fills.length, 0) / cycles.length : 0,
    maximumLayerCycles: cycles.filter((cycle) => cycle.fills.length === 12).length,
    averageHoldingMinutes: cycles.length ? cycles.reduce((sum, cycle) => sum + cycle.holdingMinutes, 0) / cycles.length : 0,
    maximumHoldingMinutes: cycles.length ? Math.max(...cycles.map((cycle) => cycle.holdingMinutes)) : 0,
    maxMarkToMarketDrawdownFraction: maxDrawdown(curve),
  };
  if (includeSamples) result.samples = cycles.slice(0, 12).map((cycle) => ({
    id: cycle.id,
    symbol: cycle.symbol,
    side: cycle.side,
    signalTime: iso(cycle.signalTime),
    entryTime: iso(cycle.entryTime),
    exitTime: iso(cycle.exitTime),
    exitReason: cycle.exitReason,
    referencePrice: cycle.referencePrice,
    averageEntryPrice: cycle.averageEntryPrice,
    exitPrice: inferExitPrice(cycle),
    layers: cycle.fills.length,
    fillTriggers: cycle.fills.map((fill) => fill.triggerPrice),
    netPnl: cycle.netPnl,
    rMultiple: cycle.rMultiple,
    fees: cycle.fees,
    holdingMinutes: cycle.holdingMinutes,
  }));
  if (includeSamples) result.stopSamples = cycles.filter((cycle) => cycle.exitReason === "cycle_stop").slice(0, 12).map(sampleCycle);
  if (includeSamples) result.deepestSamples = cycles.slice().sort((left, right) => right.fills.length - left.fills.length || left.entryTime - right.entryTime).slice(0, 12).map(sampleCycle);
  return result;
}

function qualifies(base: ReturnType<typeof run>, doubled: ReturnType<typeof run>) {
  const b = base.full.combined as Record<string, number | null>;
  const d = doubled.full.combined as Record<string, number | null>;
  return Number(b.netPnl) > 0 && Number(b.profitFactor ?? 0) >= 1.15 && Number(d.profitFactor ?? 0) >= 1
    && Number(b.maxMarkToMarketDrawdownFraction) <= 0.05
    && [2024, 2025].every((year) => Number((base.years[year].combined as Record<string, number>).netPnl) > 0);
}

function selectAuditStart(start: number, end: number, days: number, seed: string) {
  const availableDays = Math.floor((end - start) / 86_400) - days;
  return start + (fnv1a(seed) % (availableDays + 1)) * 86_400;
}
function fnv1a(value: string) { let hash = 0x811c9dc5; for (const character of value) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 0x01000193); } return hash >>> 0; }
function inferExitPrice(cycle: ExchangeMartingaleCycle) { const entryValue = cycle.fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0); return cycle.side === "long" ? (entryValue + cycle.grossPnl) / cycle.quantity : (entryValue - cycle.grossPnl) / cycle.quantity; }
function sampleCycle(cycle: ExchangeMartingaleCycle) { return { id: cycle.id, symbol: cycle.symbol, side: cycle.side, signalTime: iso(cycle.signalTime), entryTime: iso(cycle.entryTime), exitTime: iso(cycle.exitTime), exitReason: cycle.exitReason, referencePrice: cycle.referencePrice, averageEntryPrice: cycle.averageEntryPrice, exitPrice: inferExitPrice(cycle), stopPrice: cycle.stopPrice, layers: cycle.fills.length, fillTriggers: cycle.fills.map((fill) => fill.triggerPrice), netPnl: cycle.netPnl, rMultiple: cycle.rMultiple, fees: cycle.fees, holdingMinutes: cycle.holdingMinutes }; }
function normalize(candles: Candle[]) { return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((a, b) => a.time - b.time); }
function missingBars(candles: Candle[]) { let count = 0; for (let index = 1; index < candles.length; index += 1) { const delta = candles[index].time - candles[index - 1].time; if (delta > 300) count += Math.floor(delta / 300) - 1; } return count; }
function maxDrawdown(curve: Array<{ equity: number }>) { let peak = curve[0]?.equity ?? 0; let maximum = 0; for (const point of curve) { peak = Math.max(peak, point.equity); if (peak > 0) maximum = Math.max(maximum, (peak - point.equity) / peak); } return maximum; }
function iso(seconds: number | null) { return seconds === null ? null : new Date(seconds * 1000).toISOString(); }
