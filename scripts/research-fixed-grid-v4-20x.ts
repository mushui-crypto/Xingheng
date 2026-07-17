import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import { BinanceVisionHistoricalDataSource, dayRange, monthRange } from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  FIXED_GRID_CONFIG,
  simulateFixedGridSymbol,
  type FixedGridCompletedGroup,
  type FixedGridConfig,
} from "../server/modules/strategy/runtime/FixedGridPaperEngine";
import { MARTINGALE_GRID_SYMBOLS, type MartingaleGridSymbol } from "../server/modules/strategy/runtime/MartingaleGridPaperEngine";

const from = "2024-01-01";
const through = "2026-07-15";
const exchangeStyleLifecycle = process.env.FIXED_GRID_EXCHANGE_STYLE_LIFECYCLE === "true";
const fromSeconds = Date.parse(`${from}T00:00:00Z`) / 1000;
const throughExclusive = Date.parse("2026-07-16T00:00:00Z") / 1000;
const outputPath = path.resolve(process.env.FIXED_GRID_V4_REPORT_PATH ?? (exchangeStyleLifecycle
  ? "server/data/strategy/research-fixed-grid-v5-20x-exchange-lifecycle.json"
  : "server/data/strategy/research-fixed-grid-v4-20x.json"));
const source = new BinanceVisionHistoricalDataSource(undefined, path.resolve(".cache/strategy/binance-vision"));
const candlesBySymbol = {} as Record<MartingaleGridSymbol, Candle[]>;

for (const symbol of MARTINGALE_GRID_SYMBOLS) {
  const monthly = await source.loadMonths(monthRange("2023-12", "2026-06", symbol));
  const daily = await source.loadDays(dayRange("2026-07-01", through, symbol));
  const candles = normalize([...monthly.candles, ...daily.candles]).filter((candle) => candle.time >= Date.parse("2023-12-02T00:00:00Z") / 1000 && candle.time < throughExclusive);
  if (missingBars(candles) !== 0) throw new Error(`${symbol} history contains missing bars.`);
  candlesBySymbol[symbol] = candles;
  console.info(JSON.stringify({ event: "fixed_grid_v4_data_ready", symbol, candles: candles.length }));
}

type Candidate = { id: string; stepScale: number; targetSteps: number; sizeMultiplier: number };
const candidates: Candidate[] = [];
for (const stepScale of [1, 1.5, 2]) {
  for (const targetSteps of [2, 3, 4]) {
    for (const sizeMultiplier of [1.08, 1.12]) {
      candidates.push({ id: `step-${stepScale}_target-${targetSteps}_mult-${sizeMultiplier}`, stepScale, targetSteps, sizeMultiplier });
    }
  }
}

const results = [];
for (const [index, candidate] of candidates.entries()) {
  const base = run(candidate, 1);
  const doubleCost = run(candidate, 2);
  const trainingPass = passesTraining(base.years[2024], doubleCost.years[2024]);
  results.push({ candidate, trainingPass, base, doubleCost });
  console.info(JSON.stringify({
    event: "fixed_grid_v4_candidate_complete",
    candidate: candidate.id,
    progress: `${index + 1}/${candidates.length}`,
    trainingPass,
    pf2024: base.years[2024].combined.profitFactor,
    doublePf2024: doubleCost.years[2024].combined.profitFactor,
  }));
}

const eligible = results.filter((result) => result.trainingPass).sort((left, right) => score(right) - score(left));
const selected = eligible[0] ?? null;
const validationPass = selected ? passesValidation(selected.base.years[2025], selected.doubleCost.years[2025]) : false;
const report = {
  routeId: exchangeStyleLifecycle
    ? "binance-usdm-martingale-grid-fixed-step-20x-v5-exchange-lifecycle-research"
    : "binance-usdm-martingale-grid-fixed-step-20x-v4-research",
  generatedAt: new Date().toISOString(),
  status: validationPass ? "historical_candidate_pending_future_paper" : "rejected",
  datasetRole: "2024_parameter_selection_2025_sequential_validation_2026_seen_diagnostic",
  range: { from, through, warmupStart: "2023-12-02" },
  assumptions: {
    leverageSelection: 20,
    cumulativeMarginFractionCap: 0.025,
    maximumNotionalFraction: 0.5,
    maximumGroupLossFraction: 0.015,
    pendingOrderExpiryEnabled: !exchangeStyleLifecycle,
    holdingTimeoutEnabled: !exchangeStyleLifecycle,
    automaticOrdersEnabled: false,
    fundingIgnored: true,
    markPriceAndDynamicLiquidationIgnored: true,
  },
  selectionRules: {
    trainingYear: 2024,
    validationYear: 2025,
    diagnosticPeriod: "2026-01-01_through_2026-07-15_seen_history",
    candidateCount: candidates.length,
  },
  selectedCandidate: selected ? selected.candidate : null,
  validationPass,
  selectedResult: selected,
  allCandidates: results,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.info(JSON.stringify({ event: "fixed_grid_v4_complete", status: report.status, selected: report.selectedCandidate, validationPass, outputPath }));

function run(candidate: Candidate, costMultiplier: number) {
  const config: FixedGridConfig = {
    ...FIXED_GRID_CONFIG,
    leverageSelection: 20,
    cumulativeMarginFractionCap: 0.025,
    directionValidityHours: exchangeStyleLifecycle ? null : FIXED_GRID_CONFIG.directionValidityHours,
    maximumHoldingMinutes: exchangeStyleLifecycle ? null : FIXED_GRID_CONFIG.maximumHoldingMinutes,
    targetGridSteps: candidate.targetSteps,
    sizeMultiplier: candidate.sizeMultiplier,
    takerFeeRate: FIXED_GRID_CONFIG.takerFeeRate * costMultiplier,
    slippageRate: FIXED_GRID_CONFIG.slippageRate * costMultiplier,
    gridStepBySymbol: {
      BTCUSDT: FIXED_GRID_CONFIG.gridStepBySymbol.BTCUSDT * candidate.stepScale,
      ETHUSDT: FIXED_GRID_CONFIG.gridStepBySymbol.ETHUSDT * candidate.stepScale,
    },
  };
  const simulations = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [
    symbol,
    simulateFixedGridSymbol(symbol, candlesBySymbol[symbol], { forwardStart: fromSeconds, config }),
  ])) as Record<MartingaleGridSymbol, ReturnType<typeof simulateFixedGridSymbol>>;
  return {
    config,
    years: Object.fromEntries([2024, 2025, 2026].map((year) => [year, summarizeYear(simulations, year)])),
    full: summarizePeriod(simulations, fromSeconds, throughExclusive),
  };
}

function summarizeYear(simulations: Record<MartingaleGridSymbol, ReturnType<typeof simulateFixedGridSymbol>>, year: number) {
  return summarizePeriod(simulations, Date.UTC(year, 0, 1) / 1000, Math.min(Date.UTC(year + 1, 0, 1) / 1000, throughExclusive));
}

function summarizePeriod(simulations: Record<MartingaleGridSymbol, ReturnType<typeof simulateFixedGridSymbol>>, start: number, end: number) {
  const bySymbol = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => {
    const groups = simulations[symbol].completed.filter((group) => group.exitTime >= start && group.exitTime < end);
    const curve = simulations[symbol].equityCurve.filter((point) => point.time >= start && point.time < end);
    return [symbol, metrics(groups, curve)];
  })) as Record<MartingaleGridSymbol, ReturnType<typeof metrics>>;
  const groups = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].completed).filter((group) => group.exitTime >= start && group.exitTime < end);
  const btcCurve = simulations.BTCUSDT.equityCurve.filter((point) => point.time >= start && point.time < end);
  const ethCurve = simulations.ETHUSDT.equityCurve.filter((point) => point.time >= start && point.time < end);
  return {
    combined: metrics(groups, btcCurve.map((point, index) => ({ time: point.time, equity: point.equity + (ethCurve[index]?.equity ?? 5_000) }))),
    bySymbol,
  };
}

function metrics(groups: FixedGridCompletedGroup[], curve: Array<{ time: number; equity: number }>) {
  const profit = groups.filter((group) => group.netPnl > 0).reduce((sum, group) => sum + group.netPnl, 0);
  const loss = -groups.filter((group) => group.netPnl < 0).reduce((sum, group) => sum + group.netPnl, 0);
  const initial = curve[0]?.equity ?? 10_000;
  const netPnl = groups.reduce((sum, group) => sum + group.netPnl, 0);
  return {
    groups: groups.length,
    netPnl,
    returnOnPeriodStart: initial ? netPnl / initial : 0,
    profitFactor: loss > 0 ? profit / loss : null,
    averageR: groups.length ? groups.reduce((sum, group) => sum + group.rMultiple, 0) / groups.length : 0,
    maxMarkToMarketDrawdownFraction: maxDrawdown(curve),
    fees: groups.reduce((sum, group) => sum + group.fees, 0),
  };
}

function passesTraining(base: ReturnType<typeof summarizePeriod>, doubled: ReturnType<typeof summarizePeriod>) {
  return pf(base.combined) >= 1.15 && base.combined.netPnl > 0
    && pf(doubled.combined) >= 1 && doubled.combined.netPnl >= 0
    && pf(base.bySymbol.BTCUSDT) >= 0.9 && pf(base.bySymbol.ETHUSDT) >= 0.9
    && base.combined.groups >= 150;
}

function passesValidation(base: ReturnType<typeof summarizePeriod>, doubled: ReturnType<typeof summarizePeriod>) {
  return pf(base.combined) >= 1.05 && base.combined.netPnl > 0
    && pf(doubled.combined) >= 0.95
    && pf(base.bySymbol.BTCUSDT) >= 0.9 && pf(base.bySymbol.ETHUSDT) >= 0.9
    && base.combined.groups >= 150 && base.combined.maxMarkToMarketDrawdownFraction <= 0.05;
}

function score(result: (typeof results)[number]) {
  return Math.min(pf(result.base.years[2024].combined), pf(result.doubleCost.years[2024].combined))
    + result.base.years[2024].combined.returnOnPeriodStart * 5;
}

function pf(value: { profitFactor: number | null }) { return value.profitFactor ?? 0; }
function normalize(candles: Candle[]) { return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((a, b) => a.time - b.time); }
function missingBars(candles: Candle[]) { let count = 0; for (let index = 1; index < candles.length; index += 1) { const delta = candles[index].time - candles[index - 1].time; if (delta > 300) count += Math.floor(delta / 300) - 1; } return count; }
function maxDrawdown(curve: Array<{ equity: number }>) { let peak = curve[0]?.equity ?? 0; let maximum = 0; for (const point of curve) { peak = Math.max(peak, point.equity); if (peak > 0) maximum = Math.max(maximum, (peak - point.equity) / peak); } return maximum; }
