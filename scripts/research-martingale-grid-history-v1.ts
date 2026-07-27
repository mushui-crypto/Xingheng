import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  MARTINGALE_GRID_CONFIG,
  MARTINGALE_GRID_ROUTE_ID,
  MARTINGALE_GRID_SYMBOLS,
  simulateMartingaleGridSymbol,
  type MartingaleGridCompletedGroup,
  type MartingaleGridConfig,
  type MartingaleGridSymbol,
} from "../server/modules/strategy/runtime/MartingaleGridPaperEngine";

const signalIntervalMinutes = process.env.MARTINGALE_RESEARCH_SIGNAL_INTERVAL === "15" ? 15 : 5;
const is15mEntryV2 = signalIntervalMinutes === 15;
const historyRouteId = is15mEntryV2
  ? "binance-usdm-martingale-grid-15m-entry-v2-history"
  : `${MARTINGALE_GRID_ROUTE_ID}-history-v1`;
const outputPath = path.resolve(is15mEntryV2
  ? "research-martingale-grid-15m-entry-v2.json"
  : "research-martingale-grid-history-v1.json");
const evaluationStart = Date.parse("2021-01-01T00:00:00.000Z") / 1000;
const evaluationEnd = Date.parse("2026-07-15T23:55:00.000Z") / 1000;
const monthlyStart = "2020-12";
const monthlyEnd = "2026-06";
const dailyStart = "2026-07-01";
const dailyEnd = "2026-07-15";
const years = [2021, 2022, 2023, 2024, 2025, 2026];

const source = new BinanceVisionHistoricalDataSource();
const datasets = Object.fromEntries(await Promise.all(MARTINGALE_GRID_SYMBOLS.map(async (symbol) => {
  const [monthly, daily] = await Promise.all([
    source.loadMonths(monthRange(monthlyStart, monthlyEnd, symbol)),
    source.loadDays(dayRange(dailyStart, dailyEnd, symbol)),
  ]);
  const normalized = normalizeCandles([...monthly.candles, ...daily.candles])
    .filter((candle) => candle.time <= evaluationEnd);
  const missingBarCount = countMissingBars(normalized);
  if (!monthly.quality.checksumVerified || !daily.quality.checksumVerified || missingBarCount !== 0) {
    throw new Error(`${symbol} data quality failed: monthlyChecksum=${monthly.quality.checksumVerified} dailyChecksum=${daily.quality.checksumVerified} gaps=${missingBarCount}`);
  }
  if (normalized[0]?.time !== Date.parse("2020-12-01T00:00:00.000Z") / 1000 || normalized.at(-1)?.time !== evaluationEnd) {
    throw new Error(`${symbol} history boundaries are incomplete.`);
  }
  return [symbol, {
    candles: normalized,
    quality: {
      source: "binance_vision_usdm" as const,
      checksumVerified: true,
      candleCount: normalized.length,
      duplicateCount: monthly.quality.duplicateCount + daily.quality.duplicateCount,
      missingBarCount,
      firstCandleTime: normalized[0].time,
      lastCandleTime: normalized.at(-1)!.time,
      monthlyFiles: monthly.quality.files,
      dailyFiles: daily.quality.files,
    },
  }] as const;
}))) as Record<MartingaleGridSymbol, Dataset>;

console.log(JSON.stringify({
  event: "martingale_history_data_ready",
  symbols: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, {
    candleCount: datasets[symbol].quality.candleCount,
    duplicateCount: datasets[symbol].quality.duplicateCount,
    missingBarCount: datasets[symbol].quality.missingBarCount,
    checksumVerified: datasets[symbol].quality.checksumVerified,
    firstCandleTime: datasets[symbol].quality.firstCandleTime,
    lastCandleTime: datasets[symbol].quality.lastCandleTime,
    monthlyFileCount: datasets[symbol].quality.monthlyFiles.length,
    dailyFileCount: datasets[symbol].quality.dailyFiles.length,
  }])),
}));

const baseRuns = runSymbols(MARTINGALE_GRID_CONFIG);
const stressConfig: MartingaleGridConfig = {
  ...MARTINGALE_GRID_CONFIG,
  takerFeeRate: MARTINGALE_GRID_CONFIG.takerFeeRate * 2,
  slippageRate: MARTINGALE_GRID_CONFIG.slippageRate * 2,
};
const stressRuns = runSymbols(stressConfig);

const completedGroups = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => baseRuns[symbol].completed)
  .sort((left, right) => left.exitTime - right.exitTime);
const combinedCurve = combineEquityCurves(baseRuns, MARTINGALE_GRID_CONFIG.initialEquityPerSymbol);
const stressCompleted = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => stressRuns[symbol].completed)
  .sort((left, right) => left.exitTime - right.exitTime);
const stressCurve = combineEquityCurves(stressRuns, MARTINGALE_GRID_CONFIG.initialEquityPerSymbol);

const combined = summarize(completedGroups, combinedCurve, 10_000);
const bySymbol = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [
  symbol,
  summarize(baseRuns[symbol].completed, baseRuns[symbol].equityCurve, MARTINGALE_GRID_CONFIG.initialEquityPerSymbol),
])) as Record<MartingaleGridSymbol, Summary>;
const yearly = Object.fromEntries(years.map((year) => {
  const from = Date.UTC(year, 0, 1) / 1000;
  const to = year === 2026 ? evaluationEnd : Date.UTC(year + 1, 0, 1) / 1000 - 1;
  return [String(year), summarize(
    completedGroups.filter((group) => group.entryTime >= from && group.entryTime <= to),
    combinedCurve.filter((point) => point.time >= from && point.time <= to),
    equityAtOrBefore(combinedCurve, from, 10_000),
  )];
}));
const sideMetrics = groupSummaries(completedGroups, (group) => group.side);
const exitReasons = groupSummaries(completedGroups, (group) => group.exitReason);
const layerAnalysis = analyzeLayers(completedGroups);
const holdingAnalysis = analyzeHolding(completedGroups);
const stress = {
  configuration: { takerFeeRate: stressConfig.takerFeeRate, slippageRate: stressConfig.slippageRate },
  combined: summarize(stressCompleted, stressCurve, 10_000),
  bySymbol: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [
    symbol,
    summarize(stressRuns[symbol].completed, stressRuns[symbol].equityCurve, MARTINGALE_GRID_CONFIG.initialEquityPerSymbol),
  ])),
};

const fullYearItems = [2021, 2022, 2023, 2024, 2025].map((year) => yearly[String(year)]);
const gates = {
  minimumCompletedGroups: gate(combined.completedGroups >= 300, combined.completedGroups, ">=300"),
  combinedProfitFactor: gate(profitFactorForGate(combined) >= 1.20, combined.profitFactor, ">=1.20"),
  combinedAverageR: gate(combined.averageR >= 0.10, combined.averageR, ">=0.10"),
  combinedMaxDrawdown: gate(combined.maxMarkToMarketDrawdownFraction <= 0.15, combined.maxMarkToMarketDrawdownFraction, "<=0.15"),
  positiveFullYears: gate(fullYearItems.filter((item) => item.netPnl > 0).length >= 4, fullYearItems.filter((item) => item.netPnl > 0).length, ">=4/5"),
  worstFullYearProfitFactor: gate(Math.min(...fullYearItems.map(profitFactorForGate)) >= 0.90, Math.min(...fullYearItems.map(profitFactorForGate)), ">=0.90"),
  ytd2026NonNegative: gate(yearly["2026"].netPnl >= 0, yearly["2026"].netPnl, ">=0"),
  btcProfitFactor: gate(profitFactorForGate(bySymbol.BTCUSDT) >= 1.05, bySymbol.BTCUSDT.profitFactor, ">=1.05"),
  ethProfitFactor: gate(profitFactorForGate(bySymbol.ETHUSDT) >= 1.05, bySymbol.ETHUSDT.profitFactor, ">=1.05"),
  doubleCostProfitFactor: gate(profitFactorForGate(stress.combined) >= 1.00, stress.combined.profitFactor, ">=1.00"),
  worstGroupR: gate(combined.worstGroupR >= -1.50, combined.worstGroupR, ">=-1.50"),
};
const qualified = Object.values(gates).every((item) => item.passed);

const report = {
  routeId: historyRouteId,
  generatedAt: new Date().toISOString(),
  status: qualified ? "historically_qualified_for_independent_forward_observation" : "rejected_historical_qualification",
  researchOnly: true,
  automaticOrdersEnabled: false,
  preRegistration: {
    document: is15mEntryV2 ? "docs/strategy/archive/STRATEGY_MARTINGALE_GRID_15M_ENTRY_V2.md" : "docs/strategy/archive/STRATEGY_MARTINGALE_GRID_HISTORY_V1.md",
    strategyDocument: "docs/strategy/STRATEGY_MARTINGALE_GRID_PAPER_V1.md",
    noParameterSearch: true,
    warmupRange: { from: "2020-12-01", to: "2020-12-31" },
    evaluationRange: { from: "2021-01-01", to: "2026-07-15" },
    attributionField: "entryTime",
  },
  strategy: {
    routeId: is15mEntryV2 ? "binance-usdm-martingale-grid-15m-entry-v2" : MARTINGALE_GRID_ROUTE_ID,
    configuration: is15mEntryV2
      ? { ...MARTINGALE_GRID_CONFIG, signalIntervalMinutes, entryExecutionIntervalMinutes: 5 }
      : MARTINGALE_GRID_CONFIG,
  },
  costs: {
    takerFeeRatePerSide: MARTINGALE_GRID_CONFIG.takerFeeRate,
    slippageRatePerFill: MARTINGALE_GRID_CONFIG.slippageRate,
    fundingIgnored: true,
    markPriceAndDynamicLiquidationIgnored: true,
  },
  dataQuality: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, datasets[symbol].quality])),
  results: {
    combined,
    bySymbol,
    yearly,
    sideMetrics,
    exitReasons,
    signalDiagnostics: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, baseRuns[symbol].diagnostics])),
    layerAnalysis,
    holdingAnalysis,
    openAtEnd: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, baseRuns[symbol].open])),
    stressDoubleCosts: stress,
  },
  qualification: { qualified, gates },
  completedGroups,
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output: outputPath,
  deterministicHash: deterministicHash(report),
  status: report.status,
  combined,
  bySymbol,
  yearly,
  sideMetrics,
  exitReasons,
  signalDiagnostics: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, baseRuns[symbol].diagnostics])),
  layerAnalysis,
  holdingAnalysis,
  stress: stress.combined,
  qualification: report.qualification,
}, null, 2));

type Dataset = {
  candles: Candle[];
  quality: {
    source: "binance_vision_usdm";
    checksumVerified: boolean;
    candleCount: number;
    duplicateCount: number;
    missingBarCount: number;
    firstCandleTime: number;
    lastCandleTime: number;
    monthlyFiles: string[];
    dailyFiles: string[];
  };
};

type Simulation = ReturnType<typeof simulateMartingaleGridSymbol>;

type Summary = {
  completedGroups: number;
  wins: number;
  losses: number;
  winRate: number;
  totalFills: number;
  netPnl: number;
  netReturnFraction: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  averageR: number;
  fees: number;
  maxMarkToMarketDrawdownFraction: number;
  initialEquity: number;
  endingMarkedEquity: number;
  maximumConsecutiveLosses: number;
  bestGroupPnl: number;
  worstGroupPnl: number;
  bestGroupR: number;
  worstGroupR: number;
};

function runSymbols(config: MartingaleGridConfig) {
  return Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [
    symbol,
    simulateMartingaleGridSymbol(symbol, datasets[symbol].candles, {
      forwardStart: evaluationStart,
      config,
      signalIntervalMinutes,
    }),
  ])) as Record<MartingaleGridSymbol, Simulation>;
}

function summarize(groups: MartingaleGridCompletedGroup[], curve: Array<{ time: number; equity: number }>, initialEquity: number): Summary {
  const ordered = [...groups].sort((left, right) => left.exitTime - right.exitTime);
  const wins = ordered.filter((group) => group.netPnl > 0);
  const losses = ordered.filter((group) => group.netPnl < 0);
  const grossProfit = wins.reduce((sum, group) => sum + group.netPnl, 0);
  const grossLoss = -losses.reduce((sum, group) => sum + group.netPnl, 0);
  const netPnl = ordered.reduce((sum, group) => sum + group.netPnl, 0);
  return {
    completedGroups: ordered.length,
    wins: wins.length,
    losses: losses.length,
    winRate: ordered.length ? wins.length / ordered.length : 0,
    totalFills: ordered.reduce((sum, group) => sum + group.fills.length, 0),
    netPnl,
    netReturnFraction: initialEquity > 0 ? netPnl / initialEquity : 0,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    averageR: ordered.length ? ordered.reduce((sum, group) => sum + group.rMultiple, 0) / ordered.length : 0,
    fees: ordered.reduce((sum, group) => sum + group.fees, 0),
    maxMarkToMarketDrawdownFraction: maxDrawdown(curve, initialEquity),
    initialEquity,
    endingMarkedEquity: curve.at(-1)?.equity ?? initialEquity,
    maximumConsecutiveLosses: maximumConsecutiveLosses(ordered),
    bestGroupPnl: ordered.length ? Math.max(...ordered.map((group) => group.netPnl)) : 0,
    worstGroupPnl: ordered.length ? Math.min(...ordered.map((group) => group.netPnl)) : 0,
    bestGroupR: ordered.length ? Math.max(...ordered.map((group) => group.rMultiple)) : 0,
    worstGroupR: ordered.length ? Math.min(...ordered.map((group) => group.rMultiple)) : 0,
  };
}

function combineEquityCurves(runs: Record<MartingaleGridSymbol, Simulation>, initialPerSymbol: number) {
  const cursors: Record<MartingaleGridSymbol, number> = { BTCUSDT: 0, ETHUSDT: 0 };
  const latest: Record<MartingaleGridSymbol, number> = { BTCUSDT: initialPerSymbol, ETHUSDT: initialPerSymbol };
  const output: Array<{ time: number; equity: number }> = [];
  while (MARTINGALE_GRID_SYMBOLS.some((symbol) => cursors[symbol] < runs[symbol].equityCurve.length)) {
    const nextTime = Math.min(...MARTINGALE_GRID_SYMBOLS.map((symbol) => runs[symbol].equityCurve[cursors[symbol]]?.time ?? Number.POSITIVE_INFINITY));
    for (const symbol of MARTINGALE_GRID_SYMBOLS) {
      while (runs[symbol].equityCurve[cursors[symbol]]?.time === nextTime) {
        latest[symbol] = runs[symbol].equityCurve[cursors[symbol]].equity;
        cursors[symbol] += 1;
      }
    }
    output.push({ time: nextTime, equity: latest.BTCUSDT + latest.ETHUSDT });
  }
  return output.filter((point) => point.time >= evaluationStart && point.time <= evaluationEnd);
}

function maxDrawdown(curve: Array<{ time: number; equity: number }>, initialEquity: number) {
  let peak = curve[0]?.equity ?? initialEquity;
  let drawdown = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    drawdown = Math.max(drawdown, peak > 0 ? (peak - point.equity) / peak : 0);
  }
  return drawdown;
}

function groupSummaries(
  groups: MartingaleGridCompletedGroup[],
  key: (group: MartingaleGridCompletedGroup) => string,
) {
  const buckets = new Map<string, MartingaleGridCompletedGroup[]>();
  for (const group of groups) buckets.set(key(group), [...(buckets.get(key(group)) ?? []), group]);
  return Object.fromEntries([...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, items]) => [
    id,
    tradeOnlySummary(items),
  ]));
}

function tradeOnlySummary(groups: MartingaleGridCompletedGroup[]) {
  const summary = summarize(groups, [], 0);
  const {
    maxMarkToMarketDrawdownFraction: _maxDrawdown,
    initialEquity: _initialEquity,
    endingMarkedEquity: _endingMarkedEquity,
    netReturnFraction: _netReturnFraction,
    ...tradeOnly
  } = summary;
  return tradeOnly;
}

function analyzeLayers(groups: MartingaleGridCompletedGroup[]) {
  const exact = Object.fromEntries([1, 2, 3, 4, 5].map((level) => [String(level), groups.filter((group) => group.fills.length === level).length]));
  const atLeast = Object.fromEntries([2, 3, 4, 5].map((level) => {
    const count = groups.filter((group) => group.fills.length >= level).length;
    return [String(level), { count, fraction: groups.length ? count / groups.length : 0 }];
  }));
  return { exactCompletedGroupLayerCount: exact, reachedAtLeastLayer: atLeast };
}

function analyzeHolding(groups: MartingaleGridCompletedGroup[]) {
  const values = groups.map((group) => group.holdingMinutes).sort((left, right) => left - right);
  return {
    averageMinutes: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
    medianMinutes: percentile(values, 0.5),
    p95Minutes: percentile(values, 0.95),
    maximumMinutes: values.at(-1) ?? 0,
  };
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))];
}

function maximumConsecutiveLosses(groups: MartingaleGridCompletedGroup[]) {
  let maximum = 0;
  let current = 0;
  for (const group of groups) {
    current = group.netPnl < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function equityAtOrBefore(curve: Array<{ time: number; equity: number }>, time: number, fallback: number) {
  let equity = fallback;
  for (const point of curve) {
    if (point.time >= time) break;
    equity = point.equity;
  }
  return equity;
}

function profitFactorForGate(summary: Summary) {
  if (summary.profitFactor !== null) return summary.profitFactor;
  return summary.completedGroups > 0 && summary.grossLoss === 0 ? Number.POSITIVE_INFINITY : 0;
}

function gate(passed: boolean, actual: unknown, required: string) {
  return { passed, actual, required };
}

function normalizeCandles(candles: Candle[]) {
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((left, right) => left.time - right.time);
}

function countMissingBars(candles: Candle[]) {
  let missing = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].time - candles[index - 1].time;
    if (delta > 300) missing += Math.floor(delta / 300) - 1;
  }
  return missing;
}

function deterministicHash(value: unknown) {
  const root = value as Record<string, unknown>;
  const stable = { ...root, generatedAt: null };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
