import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import { BinanceVisionHistoricalDataSource, dayRange, monthRange } from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  RANGE_GRID_CONFIG,
  simulateExchangeStyleRangeGrid,
  type RangeGridConfig,
  type RangeGridLeg,
  type RangeGridSimulation,
} from "../server/modules/strategy/research/ExchangeStyleRangeGridEngine";
import { MARTINGALE_GRID_SYMBOLS, type MartingaleGridSymbol } from "../server/modules/strategy/runtime/MartingaleGridPaperEngine";

const fromSeconds = Date.parse("2024-01-01T00:00:00Z") / 1000;
const throughExclusive = Date.parse("2026-07-16T00:00:00Z") / 1000;
const stopBeyondRangeSteps = Number(process.env.RANGE_GRID_STOP_BEYOND_STEPS ?? RANGE_GRID_CONFIG.stopBeyondRangeSteps);
const researchConfig: RangeGridConfig = { ...RANGE_GRID_CONFIG, stopBeyondRangeSteps };
const source = new BinanceVisionHistoricalDataSource(undefined, path.resolve(".cache/strategy/binance-vision"));
const candlesBySymbol = {} as Record<MartingaleGridSymbol, Candle[]>;
for (const symbol of MARTINGALE_GRID_SYMBOLS) {
  const monthly = await source.loadMonths(monthRange("2023-12", "2026-06", symbol));
  const daily = await source.loadDays(dayRange("2026-07-01", "2026-07-15", symbol));
  candlesBySymbol[symbol] = normalize([...monthly.candles, ...daily.candles]).filter((candle) => candle.time >= Date.parse("2023-12-02T00:00:00Z") / 1000 && candle.time < throughExclusive);
  if (missingBars(candlesBySymbol[symbol]) !== 0) throw new Error(`${symbol} range-grid data has gaps.`);
  console.info(JSON.stringify({ event: "range_grid_data_ready", symbol, candles: candlesBySymbol[symbol].length }));
}

const base = run(researchConfig);
const doubleCost = run({ ...researchConfig, takerFeeRate: researchConfig.takerFeeRate * 2, slippageRate: researchConfig.slippageRate * 2 });
const report = {
  routeId: stopBeyondRangeSteps === RANGE_GRID_CONFIG.stopBeyondRangeSteps
    ? "binance-usdm-exchange-style-neutral-range-grid-v1-research"
    : "binance-usdm-exchange-style-neutral-range-grid-v1-stop-buffer-sensitivity",
  generatedAt: new Date().toISOString(),
  status: qualifies(base, doubleCost) ? "historical_candidate_pending_future_paper" : "rejected",
  datasetRole: "historical_recalculation_seen_history_not_clean_holdout",
  range: { from: "2024-01-01", through: "2026-07-15", warmupStart: "2023-12-02" },
  assumptions: { leverageSelection: 20, automaticOrdersEnabled: false, fundingIgnored: true, noPendingOrderExpiry: true, noHoldingTimeout: true },
  base,
  doubleCost,
};
const output = path.resolve(process.env.RANGE_GRID_HISTORY_REPORT_PATH ?? (stopBeyondRangeSteps === RANGE_GRID_CONFIG.stopBeyondRangeSteps
  ? "server/data/strategy/research-exchange-style-range-grid-v1.json"
  : `server/data/strategy/research-exchange-style-range-grid-v1-stop-${stopBeyondRangeSteps}.json`));
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.info(JSON.stringify({ event: "range_grid_research_complete", status: report.status, output, base: base.full.combined, doubleCost: doubleCost.full.combined }));

function run(config: RangeGridConfig) {
  const simulations = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, simulateExchangeStyleRangeGrid(symbol, candlesBySymbol[symbol], { forwardStart: fromSeconds, config })])) as Record<MartingaleGridSymbol, RangeGridSimulation>;
  return {
    config,
    years: Object.fromEntries([2024, 2025, 2026].map((year) => [year, summarize(simulations, Date.UTC(year, 0, 1) / 1000, Math.min(Date.UTC(year + 1, 0, 1) / 1000, throughExclusive))])),
    full: summarize(simulations, fromSeconds, throughExclusive),
    diagnostics: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, simulations[symbol].diagnostics])),
  };
}

function summarize(simulations: Record<MartingaleGridSymbol, RangeGridSimulation>, start: number, end: number) {
  const bySymbol = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => {
    const legs = simulations[symbol].completedLegs.filter((leg) => leg.exitTime >= start && leg.exitTime < end);
    const curve = simulations[symbol].equityCurve.filter((point) => point.time >= start && point.time < end);
    const cycles = simulations[symbol].completedCycles.filter((cycle) => cycle.endedAt !== null && cycle.endedAt >= start && cycle.endedAt < end).length;
    return [symbol, metrics(legs, curve, cycles)];
  })) as Record<MartingaleGridSymbol, ReturnType<typeof metrics>>;
  const legs = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].completedLegs).filter((leg) => leg.exitTime >= start && leg.exitTime < end);
  const btcCurve = simulations.BTCUSDT.equityCurve.filter((point) => point.time >= start && point.time < end);
  const ethCurve = simulations.ETHUSDT.equityCurve.filter((point) => point.time >= start && point.time < end);
  return {
    combined: metrics(legs, btcCurve.map((point, index) => ({ time: point.time, equity: point.equity + (ethCurve[index]?.equity ?? RANGE_GRID_CONFIG.initialEquity) })), bySymbol.BTCUSDT.completedCycles + bySymbol.ETHUSDT.completedCycles),
    bySymbol,
  };
}

function metrics(legs: RangeGridLeg[], curve: Array<{ equity: number }>, completedCycles: number) {
  const profit = legs.filter((leg) => leg.netPnl > 0).reduce((sum, leg) => sum + leg.netPnl, 0);
  const loss = -legs.filter((leg) => leg.netPnl < 0).reduce((sum, leg) => sum + leg.netPnl, 0);
  return {
    completedLegs: legs.length,
    completedCycles,
    gridProfits: legs.filter((leg) => leg.exitReason === "grid_profit").length,
    rangeStops: legs.filter((leg) => leg.exitReason === "range_stop").length,
    netPnl: legs.reduce((sum, leg) => sum + leg.netPnl, 0),
    profitFactor: loss > 0 ? profit / loss : null,
    fees: legs.reduce((sum, leg) => sum + leg.fees, 0),
    maxMarkToMarketDrawdownFraction: maxDrawdown(curve),
  };
}

function qualifies(base: ReturnType<typeof run>, doubled: ReturnType<typeof run>) {
  return [2024, 2025].every((year) => base.years[year].combined.netPnl > 0 && (base.years[year].combined.profitFactor ?? 0) >= 1.1)
    && base.full.combined.netPnl > 0 && (base.full.combined.profitFactor ?? 0) >= 1.15
    && (doubled.full.combined.profitFactor ?? 0) >= 1
    && base.full.combined.maxMarkToMarketDrawdownFraction <= 0.05;
}

function normalize(candles: Candle[]) { return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((a, b) => a.time - b.time); }
function missingBars(candles: Candle[]) { let count = 0; for (let index = 1; index < candles.length; index += 1) { const delta = candles[index].time - candles[index - 1].time; if (delta > 300) count += Math.floor(delta / 300) - 1; } return count; }
function maxDrawdown(curve: Array<{ equity: number }>) { let peak = curve[0]?.equity ?? 0; let maximum = 0; for (const point of curve) { peak = Math.max(peak, point.equity); if (peak > 0) maximum = Math.max(maximum, (peak - point.equity) / peak); } return maximum; }
