import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import { BinanceVisionHistoricalDataSource, dayRange, monthRange } from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  simulateExchangeStyleDirectionalMartingaleV2,
  type ExchangeMartingaleV2Config,
  type ExchangeMartingaleV2Cycle,
  type ExchangeMartingaleV2Simulation,
} from "../server/modules/strategy/research/ExchangeStyleDirectionalMartingaleV2Engine";
import { MARTINGALE_GRID_SYMBOLS, type MartingaleGridSymbol } from "../server/modules/strategy/runtime/MartingaleGridPaperEngine";

const start = Date.parse("2024-01-01T00:00:00Z") / 1000;
const validationStart = Date.parse("2025-01-01T00:00:00Z") / 1000;
const diagnosticStart = Date.parse("2026-01-01T00:00:00Z") / 1000;
const end = Date.parse("2026-07-16T00:00:00Z") / 1000;
const source = new BinanceVisionHistoricalDataSource(undefined, path.resolve(".cache/strategy/binance-vision"));
const candlesBySymbol = {} as Record<MartingaleGridSymbol, Candle[]>;
const dataQuality = {} as Record<MartingaleGridSymbol, unknown>;

for (const symbol of MARTINGALE_GRID_SYMBOLS) {
  const monthly = await source.loadMonths(monthRange("2023-12", "2026-06", symbol));
  const daily = await source.loadDays(dayRange("2026-07-01", "2026-07-15", symbol));
  const candles = normalize([...monthly.candles, ...daily.candles]).filter((candle) => candle.time >= Date.parse("2023-12-02T00:00:00Z") / 1000 && candle.time < end);
  const missing = missingBars(candles);
  if (missing !== 0) throw new Error(`${symbol} V3 pullback history contains ${missing} missing bars.`);
  candlesBySymbol[symbol] = candles;
  dataQuality[symbol] = { candleCount: candles.length, missingBarCount: missing, checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified, first: iso(candles[0]?.time ?? null), last: iso(candles.at(-1)?.time ?? null) };
}

const formation = buildConfigs().map((config) => {
  const simulations = run(config, validationStart);
  const metrics = summarize(simulations, start, validationStart);
  const passed = passesFormation(metrics.combined);
  console.info(JSON.stringify({ event: "martingale_v3_pullback_formation", id: config.id, passed, metrics: metrics.combined }));
  return { config, metrics, passed };
});

const validation = formation.filter((item) => item.passed).map((item) => {
  const simulations = run(item.config, end);
  const metrics2025 = summarize(simulations, validationStart, diagnosticStart);
  const passed = passesValidation(metrics2025);
  console.info(JSON.stringify({ event: "martingale_v3_pullback_validation", id: item.config.id, passed, metrics: metrics2025.combined }));
  return { config: item.config, metrics2025, passed, simulations };
});

const finalists = validation.filter((item) => item.passed).map((item) => {
  const doubleConfig = { ...item.config, id: `${item.config.id}__double-cost`, takerFeeRate: item.config.takerFeeRate * 2, slippageRate: item.config.slippageRate * 2 };
  const doubled = run(doubleConfig, diagnosticStart);
  const base2024To2025 = summarize(item.simulations, start, diagnosticStart);
  const doubleCost2024To2025 = summarize(doubled, start, diagnosticStart);
  const diagnostic2026 = summarize(item.simulations, diagnosticStart, end);
  const passed = Number(doubleCost2024To2025.combined.profitFactor ?? 0) >= 1 && base2024To2025.combined.approximateLiquidations === 0;
  return { config: item.config, base2024To2025, doubleCost2024To2025, diagnostic2026, passed };
});

const candidates = finalists.filter((item) => item.passed).sort((left, right) => {
  const l = validation.find((item) => item.config.id === left.config.id)!.metrics2025.combined;
  const r = validation.find((item) => item.config.id === right.config.id)!.metrics2025.combined;
  return Number(r.profitFactor ?? 0) - Number(l.profitFactor ?? 0) || r.netPnl - l.netPnl || l.maxMarkToMarketDrawdownFraction - r.maxMarkToMarketDrawdownFraction;
});

const report = {
  routeId: "binance-usdm-exchange-style-directional-martingale-v3-pullback-research",
  generatedAt: new Date().toISOString(),
  status: candidates.length ? "historical_candidate_pending_future_paper" : "rejected",
  datasetRole: "seen_history_sequential_formation_validation_not_clean_holdout",
  dataQuality,
  searchSpaceSize: 4,
  formation: formation.map(({ config, metrics, passed }) => ({ config, metrics, passed })),
  validation: validation.map(({ config, metrics2025, passed }) => ({ config, metrics2025, passed })),
  finalists,
  selectedCandidate: candidates[0] ?? null,
  assumptions: { automaticOrdersEnabled: false, fundingIgnored: true, markPriceLiquidationApproximated: true },
};
const output = path.resolve("server/data/strategy/research-exchange-style-directional-martingale-v3-pullback.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.info(JSON.stringify({ event: "martingale_v3_pullback_complete", status: report.status, formationPassed: formation.filter((item) => item.passed).length, validationPassed: validation.filter((item) => item.passed).length, finalistsPassed: candidates.length, selected: candidates[0]?.config.id ?? null, output }));

function buildConfigs(): ExchangeMartingaleV2Config[] {
  const configs: ExchangeMartingaleV2Config[] = [];
  for (const takeProfitPriceFraction of [0.008, 0.012] as const) {
    for (const entryRetracementStepMultiple of [0.5, 1] as const) {
      configs.push({
        id: `pullback_${entryRetracementStepMultiple}step__l6__tp${Math.round(takeProfitPriceFraction * 10_000)}bp__completed_1h_atr`,
        initialEquity: 5_000,
        leverageSelection: 20,
        marginMode: "isolated",
        maximumLayers: 6,
        amountMultiplier: 1.08,
        priceStepMultiplier: 1,
        stepMode: "completed_1h_atr",
        fixedStepFractionBySymbol: { BTCUSDT: 0.006, ETHUSDT: 0.008 },
        atrStepMultiplier: 0.75,
        minimumStepFraction: 0.004,
        maximumStepFraction: 0.012,
        takeProfitPriceFraction,
        reentryPolicy: "cooldown_4h",
        cooldownMinutes: 240,
        entryPolicy: "confirmation_retracement",
        entryRetracementStepMultiple,
        cumulativeMarginFractionCap: 0.015,
        maximumCycleLossFraction: 0.005,
        stopBeyondLastStepMultiplier: 1,
        maintenanceMarginRateStress: 0.005,
        takerFeeRate: 0.00045,
        slippageRate: 0.0001,
      });
    }
  }
  return configs;
}

function run(config: ExchangeMartingaleV2Config, through: number) {
  return Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, simulateExchangeStyleDirectionalMartingaleV2(symbol, candlesBySymbol[symbol].filter((candle) => candle.time < through), { forwardStart: start, config })])) as Record<MartingaleGridSymbol, ExchangeMartingaleV2Simulation>;
}

function summarize(simulations: Record<MartingaleGridSymbol, ExchangeMartingaleV2Simulation>, from: number, through: number) {
  const bySymbol = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, metrics(simulations[symbol].completed.filter((cycle) => cycle.entryTime >= from && cycle.entryTime < through), simulations[symbol].equityCurve.filter((point) => point.time >= from && point.time < through))])) as Record<MartingaleGridSymbol, ReturnType<typeof metrics>>;
  const cycles = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].completed).filter((cycle) => cycle.entryTime >= from && cycle.entryTime < through);
  const btc = simulations.BTCUSDT.equityCurve.filter((point) => point.time >= from && point.time < through);
  const eth = simulations.ETHUSDT.equityCurve.filter((point) => point.time >= from && point.time < through);
  return { combined: metrics(cycles, btc.map((point, index) => ({ equity: point.equity + (eth[index]?.equity ?? 5_000) }))), bySymbol };
}

function metrics(cycles: ExchangeMartingaleV2Cycle[], curve: Array<{ equity: number }>) {
  const profit = cycles.filter((cycle) => cycle.netPnl > 0).reduce((sum, cycle) => sum + cycle.netPnl, 0);
  const loss = -cycles.filter((cycle) => cycle.netPnl < 0).reduce((sum, cycle) => sum + cycle.netPnl, 0);
  return {
    completedCycles: cycles.length,
    longCycles: cycles.filter((cycle) => cycle.side === "long").length,
    shortCycles: cycles.filter((cycle) => cycle.side === "short").length,
    takeProfits: cycles.filter((cycle) => cycle.exitReason === "cycle_take_profit").length,
    stops: cycles.filter((cycle) => cycle.exitReason === "cycle_stop").length,
    approximateLiquidations: cycles.filter((cycle) => cycle.exitReason === "approx_liquidation").length,
    netPnl: cycles.reduce((sum, cycle) => sum + cycle.netPnl, 0),
    profitFactor: loss > 0 ? profit / loss : null,
    averageR: cycles.length ? cycles.reduce((sum, cycle) => sum + cycle.rMultiple, 0) / cycles.length : 0,
    fees: cycles.reduce((sum, cycle) => sum + cycle.fees, 0),
    averageLayers: cycles.length ? cycles.reduce((sum, cycle) => sum + cycle.fills.length, 0) / cycles.length : 0,
    maxMarkToMarketDrawdownFraction: maxDrawdown(curve),
  };
}
function passesFormation(metric: ReturnType<typeof metrics>) { return metric.completedCycles >= 100 && metric.netPnl > 0 && Number(metric.profitFactor ?? 0) >= 1.1 && metric.maxMarkToMarketDrawdownFraction <= 0.05; }
function passesValidation(metric: ReturnType<typeof summarize>) { return metric.combined.netPnl > 0 && Number(metric.combined.profitFactor ?? 0) >= 1.05 && metric.combined.maxMarkToMarketDrawdownFraction <= 0.05 && !(metric.bySymbol.BTCUSDT.netPnl < 0 && metric.bySymbol.ETHUSDT.netPnl < 0); }
function normalize(input: Candle[]) { return [...new Map(input.map((candle) => [candle.time, candle])).values()].sort((left, right) => left.time - right.time); }
function missingBars(input: Candle[]) { let count = 0; for (let index = 1; index < input.length; index += 1) { const delta = input[index].time - input[index - 1].time; if (delta > 300) count += Math.floor(delta / 300) - 1; } return count; }
function maxDrawdown(curve: Array<{ equity: number }>) { let peak = curve[0]?.equity ?? 0; let maximum = 0; for (const point of curve) { peak = Math.max(peak, point.equity); if (peak > 0) maximum = Math.max(maximum, (peak - point.equity) / peak); } return maximum; }
function iso(seconds: number | null) { return seconds === null ? null : new Date(seconds * 1000).toISOString(); }
