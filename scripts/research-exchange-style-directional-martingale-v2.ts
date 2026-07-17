import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  simulateExchangeStyleDirectionalMartingaleV2,
  type ExchangeMartingaleV2Config,
  type ExchangeMartingaleV2Cycle,
  type ExchangeMartingaleV2Simulation,
} from "../server/modules/strategy/research/ExchangeStyleDirectionalMartingaleV2Engine";
import {
  MARTINGALE_GRID_SYMBOLS,
  type MartingaleGridSymbol,
} from "../server/modules/strategy/runtime/MartingaleGridPaperEngine";

const evaluationStart = Date.parse("2024-01-01T00:00:00Z") / 1000;
const formationEnd = Date.parse("2025-01-01T00:00:00Z") / 1000;
const validationEnd = Date.parse("2026-01-01T00:00:00Z") / 1000;
const throughExclusive = Date.parse("2026-07-16T00:00:00Z") / 1000;
const warmupStart = Date.parse("2023-12-02T00:00:00Z") / 1000;
const source = new BinanceVisionHistoricalDataSource(undefined, path.resolve(".cache/strategy/binance-vision"));
const candlesBySymbol = {} as Record<MartingaleGridSymbol, Candle[]>;
const dataQuality = {} as Record<MartingaleGridSymbol, unknown>;

for (const symbol of MARTINGALE_GRID_SYMBOLS) {
  const monthly = await source.loadMonths(monthRange("2023-12", "2026-06", symbol));
  const daily = await source.loadDays(dayRange("2026-07-01", "2026-07-15", symbol));
  const candles = normalize([...monthly.candles, ...daily.candles])
    .filter((candle) => candle.time >= warmupStart && candle.time < throughExclusive);
  const missing = missingBars(candles);
  if (missing !== 0) throw new Error(`${symbol} V2 history contains ${missing} missing bars.`);
  candlesBySymbol[symbol] = candles;
  dataQuality[symbol] = {
    candleCount: candles.length,
    missingBarCount: missing,
    checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
    first: iso(candles[0]?.time ?? null),
    last: iso(candles.at(-1)?.time ?? null),
  };
}

const configs = buildConfigs();
const formation = [];
for (const [index, config] of configs.entries()) {
  const result = runThrough(config, formationEnd);
  const metrics = summarize(result, evaluationStart, formationEnd);
  const passed = passesFormation(metrics.combined);
  formation.push({ config, metrics, passed });
  console.info(JSON.stringify({ event: "martingale_v2_formation", index: index + 1, total: configs.length, id: config.id, passed, metrics: metrics.combined }));
}

const formationPassed = formation.filter((item) => item.passed);
const validation = [];
for (const item of formationPassed) {
  const simulations = runThrough(item.config, throughExclusive);
  const metrics2025 = summarize(simulations, formationEnd, validationEnd);
  const passed = passesValidation(metrics2025);
  validation.push({ config: item.config, metrics2025, passed, simulations });
  console.info(JSON.stringify({ event: "martingale_v2_validation", id: item.config.id, passed, metrics: metrics2025.combined }));
}

const validationPassed = validation.filter((item) => item.passed);
const finalists = [];
for (const item of validationPassed) {
  const doubleConfig = {
    ...item.config,
    id: `${item.config.id}__double-cost`,
    takerFeeRate: item.config.takerFeeRate * 2,
    slippageRate: item.config.slippageRate * 2,
  };
  const doubleSimulations = runThrough(doubleConfig, validationEnd);
  const doubleMetrics = summarize(doubleSimulations, evaluationStart, validationEnd);
  const diagnostic2026 = summarize(item.simulations, validationEnd, throughExclusive);
  const base2024To2025 = summarize(item.simulations, evaluationStart, validationEnd);
  const passed = Number(doubleMetrics.combined.profitFactor ?? 0) >= 1
    && base2024To2025.combined.approximateLiquidations === 0;
  finalists.push({
    config: item.config,
    passed,
    base2024To2025,
    doubleCost2024To2025: doubleMetrics,
    diagnostic2026,
  });
}

const candidates = finalists.filter((item) => item.passed).sort((left, right) => {
  const leftValidation = validation.find((item) => item.config.id === left.config.id)!.metrics2025.combined;
  const rightValidation = validation.find((item) => item.config.id === right.config.id)!.metrics2025.combined;
  return Number(rightValidation.profitFactor ?? 0) - Number(leftValidation.profitFactor ?? 0)
    || rightValidation.netPnl - leftValidation.netPnl
    || leftValidation.maxMarkToMarketDrawdownFraction - rightValidation.maxMarkToMarketDrawdownFraction
    || left.config.id.localeCompare(right.config.id);
});

const report = {
  routeId: "binance-usdm-exchange-style-directional-martingale-v2-research",
  generatedAt: new Date().toISOString(),
  status: candidates.length > 0 ? "historical_candidate_pending_future_paper" : "rejected",
  datasetRole: "seen_history_sequential_formation_validation_not_clean_holdout",
  range: { warmupStart: "2023-12-02", formation: "2024", validation: "2025", diagnostic: "2026-01-01_to_2026-07-15" },
  assumptions: {
    automaticOrdersEnabled: false,
    fundingIgnored: true,
    markPriceLiquidationApproximated: true,
    maintenanceMarginRateStress: 0.005,
    officialReference: "https://www.binance.com/en-IN/support/faq/detail/b3c689c1f50a44cabb3a84e663b81d93",
  },
  thresholds: {
    formation: { minimumCycles: 100, minimumProfitFactor: 1.1, maximumDrawdownFraction: 0.05, positiveNetPnl: true },
    validation: { minimumProfitFactor: 1.05, maximumDrawdownFraction: 0.05, positiveNetPnl: true, bothSymbolsCannotBeNegative: true },
    final: { minimumDoubleCostProfitFactor: 1, maximumApproximateLiquidations: 0 },
  },
  dataQuality,
  searchSpaceSize: configs.length,
  formation: formation.map(({ config, metrics, passed }) => ({ config, metrics, passed })),
  validation: validation.map(({ config, metrics2025, passed }) => ({ config, metrics2025, passed })),
  finalists,
  selectedCandidate: candidates[0] ?? null,
};

const output = path.resolve(process.env.EXCHANGE_MARTINGALE_V2_REPORT_PATH
  ?? "server/data/strategy/research-exchange-style-directional-martingale-v2.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.info(JSON.stringify({
  event: "martingale_v2_complete",
  status: report.status,
  formationPassed: formationPassed.length,
  validationPassed: validationPassed.length,
  finalistsPassed: candidates.length,
  selectedCandidate: candidates[0]?.config.id ?? null,
  output,
}));

function buildConfigs(): ExchangeMartingaleV2Config[] {
  const configs: ExchangeMartingaleV2Config[] = [];
  for (const reentryPolicy of ["cooldown_4h", "new_confirmation"] as const) {
    for (const maximumLayers of [6, 8] as const) {
      for (const takeProfitPriceFraction of [0.008, 0.012] as const) {
        for (const stepMode of ["fixed_fraction", "completed_1h_atr"] as const) {
          configs.push({
            id: `${reentryPolicy}__l${maximumLayers}__tp${Math.round(takeProfitPriceFraction * 10_000)}bp__${stepMode}`,
            initialEquity: 5_000,
            leverageSelection: 20,
            marginMode: "isolated",
            maximumLayers,
            amountMultiplier: 1.08,
            priceStepMultiplier: 1,
            stepMode,
            fixedStepFractionBySymbol: { BTCUSDT: 0.006, ETHUSDT: 0.008 },
            atrStepMultiplier: 0.75,
            minimumStepFraction: 0.004,
            maximumStepFraction: 0.012,
            takeProfitPriceFraction,
            reentryPolicy,
            cooldownMinutes: 240,
            cumulativeMarginFractionCap: 0.015,
            maximumCycleLossFraction: 0.005,
            stopBeyondLastStepMultiplier: 1,
            maintenanceMarginRateStress: 0.005,
            takerFeeRate: 0.00045,
            slippageRate: 0.0001,
          });
        }
      }
    }
  }
  return configs;
}

function runThrough(config: ExchangeMartingaleV2Config, end: number) {
  return Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [
    symbol,
    simulateExchangeStyleDirectionalMartingaleV2(
      symbol,
      candlesBySymbol[symbol].filter((candle) => candle.time < end),
      { forwardStart: evaluationStart, config },
    ),
  ])) as Record<MartingaleGridSymbol, ExchangeMartingaleV2Simulation>;
}

function summarize(
  simulations: Record<MartingaleGridSymbol, ExchangeMartingaleV2Simulation>,
  start: number,
  end: number,
) {
  const bySymbol = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => {
    const cycles = simulations[symbol].completed.filter((cycle) => cycle.entryTime >= start && cycle.entryTime < end);
    const curve = simulations[symbol].equityCurve.filter((point) => point.time >= start && point.time < end);
    return [symbol, metrics(cycles, curve)];
  })) as Record<MartingaleGridSymbol, ReturnType<typeof metrics>>;
  const cycles = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].completed)
    .filter((cycle) => cycle.entryTime >= start && cycle.entryTime < end)
    .sort((left, right) => left.entryTime - right.entryTime);
  const btcCurve = simulations.BTCUSDT.equityCurve.filter((point) => point.time >= start && point.time < end);
  const ethCurve = simulations.ETHUSDT.equityCurve.filter((point) => point.time >= start && point.time < end);
  const combinedCurve = btcCurve.map((point, index) => ({
    equity: point.equity + (ethCurve[index]?.equity ?? 5_000),
  }));
  return { combined: metrics(cycles, combinedCurve), bySymbol };
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
    maximumLayerCycles: cycles.filter((cycle) => cycle.fills.length === cycleMaximumLayers(cycle)).length,
    averageHoldingMinutes: cycles.length ? cycles.reduce((sum, cycle) => sum + cycle.holdingMinutes, 0) / cycles.length : 0,
    maximumHoldingMinutes: cycles.length ? Math.max(...cycles.map((cycle) => cycle.holdingMinutes)) : 0,
    maxMarkToMarketDrawdownFraction: maxDrawdown(curve),
  };
}

function passesFormation(metric: ReturnType<typeof metrics>) {
  return metric.completedCycles >= 100
    && metric.netPnl > 0
    && Number(metric.profitFactor ?? 0) >= 1.1
    && metric.maxMarkToMarketDrawdownFraction <= 0.05;
}

function passesValidation(metric: ReturnType<typeof summarize>) {
  return metric.combined.netPnl > 0
    && Number(metric.combined.profitFactor ?? 0) >= 1.05
    && metric.combined.maxMarkToMarketDrawdownFraction <= 0.05
    && !(metric.bySymbol.BTCUSDT.netPnl < 0 && metric.bySymbol.ETHUSDT.netPnl < 0);
}

function cycleMaximumLayers(cycle: ExchangeMartingaleV2Cycle) {
  const marker = cycle.id.match(/__l(6|8)__/);
  return marker ? Number(marker[1]) : 0;
}
function normalize(candles: Candle[]) {
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((left, right) => left.time - right.time);
}
function missingBars(candles: Candle[]) {
  let count = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].time - candles[index - 1].time;
    if (delta > 300) count += Math.floor(delta / 300) - 1;
  }
  return count;
}
function maxDrawdown(curve: Array<{ equity: number }>) {
  let peak = curve[0]?.equity ?? 0;
  let maximum = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maximum = Math.max(maximum, (peak - point.equity) / peak);
  }
  return maximum;
}
function iso(seconds: number | null) {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}
