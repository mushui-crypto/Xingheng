import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import { BacktestEngine, type BacktestResult, type BacktestTrade } from "../server/modules/strategy/backtest/BacktestEngine";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import type { Strategy, StrategyEvaluationContext, StrategySignal } from "../server/modules/strategy/core/types";
import { IctLiquidityReversalStrategy } from "../server/modules/strategy/models/IctLiquidityReversalStrategy";
import {
  IctTrendPullbackContinuationStrategy,
  ictRouteATrendPullbackV1Config,
} from "../server/modules/strategy/models/IctTrendPullbackContinuationStrategy";
import {
  ictResearchCandidateV5,
  ictResearchCandidateV5Backtest,
} from "../server/modules/strategy/models/ictResearchCandidate";

const output = path.resolve("research-ict-route-a-trend-pullback-v1.json");
const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange("2021-01", "2026-06")),
  source.loadDays(dayRange("2026-07-01", "2026-07-13")),
]);
const candles = [...new Map([...monthly.candles, ...daily.candles].map((candle) => [candle.time, candle])).values()]
  .sort((left, right) => left.time - right.time);
const missingBarCount = countMissingBars(candles);
if (missingBarCount > 0) throw new Error(`Route A dataset contains ${missingBarCount} missing 5m bars.`);

const periods = [
  { id: "formation_2021_2023", from: "2021-01-01", to: "2023-12-31" },
  { id: "evaluation_2024", from: "2024-01-01", to: "2024-12-31" },
  { id: "evaluation_2025", from: "2025-01-01", to: "2025-12-31" },
  { id: "evaluation_2024_2025", from: "2024-01-01", to: "2025-12-31" },
  { id: "historical_recalculation_2026", from: "2026-01-01", to: "2026-07-13" },
] as const;

const results: Record<string, ReturnType<typeof evaluatePeriod>> = {};
for (const period of periods) results[period.id] = evaluatePeriod(candles, period.from, period.to);
const segmentedEvaluation2024To2025 = buildSegmentedEvaluation(
  results.evaluation_2024,
  results.evaluation_2025,
  results.evaluation_2024_2025.overlap,
);
const assessment = assessCandidate(results, segmentedEvaluation2024To2025);
const report = {
  routeId: ictRouteATrendPullbackV1Config.routeId,
  status: assessment.passed ? "first_round_candidate" : "rejected_first_round",
  generatedAt: new Date().toISOString(),
  automaticOrdersEnabled: false,
  frozenReferences: {
    v5ArchiveId: "ict-btc-v5-2026-07-15",
    routeBChanged: false,
    forwardDataUsed: false,
    latestResearchCandle: "2026-07-13T23:55:00Z",
  },
  preRegistration: {
    document: "STRATEGY_ROUTE_A_RESEARCH.md",
    fixedCandidate: ictRouteATrendPullbackV1Config,
    v5PriorityOnExactConflict: true,
    thresholds: {
      minimumCombinedTrades2024To2025: 191,
      minimumAddedTrades2024To2025: 32,
      minimumAddedTradesEachYear: 10,
      minimumCombinedProfitFactor: 1.427,
      maximumCombinedDrawdownFraction: 0.0236,
      minimumStandaloneProfitFactorEachYear: 1.15,
      minimumStandaloneAverageR2024To2025: 0.1,
      maximumExactOverlapFraction: 0.2,
      maximumExactOppositeConflictFraction: 0.05,
    },
  },
  dataQuality: {
    source: "binance_vision_usdm",
    market: "BTCUSDT",
    interval: "5m",
    checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
    candleCount: candles.length,
    missingBarCount,
    firstCandleTime: candles[0]?.time ?? null,
    lastCandleTime: candles.at(-1)?.time ?? null,
  },
  segmentedEvaluation2024To2025,
  results,
  assessment,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, status: report.status, dataQuality: report.dataQuality, assessment, summaries: summarizeOutput(results) }, null, 2));

function evaluatePeriod(allCandles: Candle[], fromDate: string, toDate: string) {
  const from = Date.parse(`${fromDate}T00:00:00Z`) / 1000;
  const to = Date.parse(`${toDate}T23:59:59Z`) / 1000;
  // Match the frozen V5 reports exactly: the requested range begins without
  // importing pre-range candles. Both strategies receive the same warmup bars.
  const periodCandles = allCandles.filter((candle) => candle.time >= from && candle.time <= to);
  const v5 = runBacktest(makeV5(), periodCandles, from, to);
  const pullback = runBacktest(makePullback(), periodCandles, from, to);
  const combined = runBacktest(makeCombined(), periodCandles, from, to);
  const rawV5Signals = collectSignals(makeV5(), periodCandles, from, to);
  const rawPullbackSignals = collectSignals(makePullback(), periodCandles, from, to);
  const overlap = calculateOverlap(rawV5Signals, rawPullbackSignals);
  const combinedSourceCounts = combined.trades.reduce<Record<string, number>>((groups, trade) => {
    const key = trade.signalId.startsWith("v5:") ? "v5" : trade.signalId.startsWith("v7:") ? "v7" : "unknown";
    groups[key] = (groups[key] ?? 0) + 1;
    return groups;
  }, {});
  return {
    range: { from: fromDate, to: toDate },
    v5: summarizeResult(v5),
    pullback: summarizeResult(pullback),
    combined: { ...summarizeResult(combined), sourceCounts: combinedSourceCounts },
    opportunity: {
      combinedAddedTrades: combined.metrics.tradeCount - v5.metrics.tradeCount,
      combinedAddedTradesByEntryYear: differenceByYear(combined.trades, v5.trades),
      pullbackStandaloneFilledTrades: pullback.metrics.tradeCount,
      pullbackCombinedFilledTrades: combinedSourceCounts.v7 ?? 0,
      pullbackTradesSuppressedByCombination: pullback.metrics.tradeCount - (combinedSourceCounts.v7 ?? 0),
    },
    overlap,
    trades: {
      v5: v5.trades,
      pullback: pullback.trades,
      combined: combined.trades,
    },
  };
}

function makeV5() {
  return new IctLiquidityReversalStrategy(ictResearchCandidateV5);
}

function makePullback() {
  return new IctTrendPullbackContinuationStrategy(ictRouteATrendPullbackV1Config);
}

function makeCombined(): Strategy {
  const v5 = makeV5();
  const pullback = makePullback();
  return {
    id: "ict-route-a-v5-plus-trend-pullback-v1",
    warmupBars: Math.max(v5.warmupBars, pullback.warmupBars),
    prepare: (candles) => {
      v5.prepare(candles);
      pullback.prepare(candles);
    },
    release: () => {
      v5.release();
      pullback.release();
    },
    evaluate: (context) => {
      const v5Signal = v5.evaluate(context);
      const pullbackSignal = pullback.evaluate(context);
      if (v5Signal) return tagSignal(v5Signal, "v5");
      return pullbackSignal ? tagSignal(pullbackSignal, "v7") : null;
    },
  };
}

function tagSignal(signal: StrategySignal, sourceId: "v5" | "v7") {
  return { ...signal, id: `${sourceId}:${signal.id}`, evidence: { ...signal.evidence, combinationSource: sourceId } };
}

function runBacktest(strategy: Strategy, candles: Candle[], from: number, to: number) {
  const gated = gateStrategy(strategy, from, to);
  const result = new BacktestEngine(gated, ictResearchCandidateV5Backtest).run(candles);
  gated.release?.();
  return result;
}

function gateStrategy(strategy: Strategy, from: number, to: number): Strategy {
  return {
    id: strategy.id,
    warmupBars: strategy.warmupBars,
    prepare: (candles) => strategy.prepare?.(candles),
    release: () => strategy.release?.(),
    evaluate: (context) => {
      const time = context.candles[context.index].time;
      return time >= from && time <= to ? strategy.evaluate(context) : null;
    },
  };
}

function collectSignals(strategy: Strategy, candles: Candle[], from: number, to: number) {
  strategy.prepare?.(candles);
  const signals: StrategySignal[] = [];
  for (let index = strategy.warmupBars; index < candles.length; index += 1) {
    const time = candles[index].time;
    if (time < from || time > to) continue;
    const signal = strategy.evaluate({ candles, index, equity: 10_000 } satisfies StrategyEvaluationContext);
    if (signal) signals.push(signal);
  }
  strategy.release?.();
  return signals;
}

function calculateOverlap(v5: StrategySignal[], pullback: StrategySignal[]) {
  const v5ByTime = new Map(v5.map((signal) => [signal.createdAt, signal]));
  let exact = 0;
  let exactSameSide = 0;
  let exactOppositeSide = 0;
  let withinThirtyMinutes = 0;
  let cursor = 0;
  const orderedV5 = [...v5].sort((left, right) => left.createdAt - right.createdAt);
  for (const signal of pullback) {
    const match = v5ByTime.get(signal.createdAt);
    if (match) {
      exact += 1;
      if (match.side === signal.side) exactSameSide += 1;
      else exactOppositeSide += 1;
    }
    while (cursor < orderedV5.length && orderedV5[cursor].createdAt < signal.createdAt - 30 * 60) cursor += 1;
    let nearby = false;
    for (let index = cursor; index < orderedV5.length && orderedV5[index].createdAt <= signal.createdAt + 30 * 60; index += 1) {
      nearby = true;
      break;
    }
    if (nearby) withinThirtyMinutes += 1;
  }
  return {
    v5RawSignals: v5.length,
    pullbackRawSignals: pullback.length,
    exact,
    exactSameSide,
    exactOppositeSide,
    exactFractionOfPullback: pullback.length ? exact / pullback.length : 0,
    exactOppositeFractionOfPullback: pullback.length ? exactOppositeSide / pullback.length : 0,
    withinThirtyMinutes,
    withinThirtyMinutesFractionOfPullback: pullback.length ? withinThirtyMinutes / pullback.length : 0,
  };
}

function summarizeResult(result: BacktestResult) {
  return {
    metrics: result.metrics,
    diagnostics: result.diagnostics,
    sideMetrics: summarizeGroups(result.trades, (trade) => trade.side),
    exitMetrics: summarizeGroups(result.trades, (trade) => trade.exitReason),
    entryYearMetrics: summarizeGroups(result.trades, (trade) => new Date(trade.entryTime * 1000).getUTCFullYear().toString()),
  };
}

function differenceByYear(combined: BacktestTrade[], baseline: BacktestTrade[]) {
  const counts = (trades: BacktestTrade[]) => trades.reduce<Record<string, number>>((groups, trade) => {
    const year = new Date(trade.entryTime * 1000).getUTCFullYear().toString();
    groups[year] = (groups[year] ?? 0) + 1;
    return groups;
  }, {});
  const combinedCounts = counts(combined);
  const baselineCounts = counts(baseline);
  return Object.fromEntries([...new Set([...Object.keys(combinedCounts), ...Object.keys(baselineCounts)])]
    .sort()
    .map((year) => [year, (combinedCounts[year] ?? 0) - (baselineCounts[year] ?? 0)]));
}

function summarizeGroups(trades: BacktestTrade[], key: (trade: BacktestTrade) => string) {
  const groups: Record<string, BacktestTrade[]> = {};
  for (const trade of trades) (groups[key(trade)] ??= []).push(trade);
  return Object.fromEntries(Object.entries(groups).map(([group, items]) => [group, calculateTradeMetrics(items)]));
}

function calculateTradeMetrics(trades: BacktestTrade[]) {
  const grossProfit = trades.filter((trade) => trade.netPnl > 0).reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = -trades.filter((trade) => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0);
  let equity = 10_000;
  let peak = equity;
  let maxDrawdownFraction = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maxDrawdownFraction = Math.max(maxDrawdownFraction, peak > 0 ? (peak - equity) / peak : 0);
  }
  return {
    tradeCount: trades.length,
    netPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    averageR: trades.length ? trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length : 0,
    maxDrawdownFraction,
    fees: trades.reduce((sum, trade) => sum + trade.fees, 0),
  };
}

function assessCandidate(
  results: Record<string, ReturnType<typeof evaluatePeriod>>,
  segmentedEvaluation: ReturnType<typeof buildSegmentedEvaluation>,
) {
  const continuousEvaluation = results.evaluation_2024_2025;
  const historical2026 = results.historical_recalculation_2026;
  const year2024 = results.evaluation_2024;
  const year2025 = results.evaluation_2025;
  const pullbackSides = continuousEvaluation.pullback.sideMetrics;
  const checks = {
    combinedTradesAtLeast191: segmentedEvaluation.combined.tradeCount >= 191,
    combinedAddedTradesAtLeast32: segmentedEvaluation.opportunity.combinedAddedTrades >= 32,
    addedTradesAtLeast10In2024: year2024.opportunity.combinedAddedTrades >= 10,
    addedTradesAtLeast10In2025: year2025.opportunity.combinedAddedTrades >= 10,
    combinedProfitFactorNotWorse: finitePf(segmentedEvaluation.combined.profitFactor) >= 1.427,
    combinedDrawdownNotWorse: segmentedEvaluation.combined.maxDrawdownFraction <= 0.0236,
    combinedNetPnlHigher: segmentedEvaluation.combined.netPnl > 1042.88,
    combinedPositive2024: year2024.combined.metrics.netPnl > 0,
    combinedPositive2025: year2025.combined.metrics.netPnl > 0,
    combinedPositiveHistorical2026: historical2026.combined.metrics.netPnl > 0,
    pullbackPf2024AtLeast115: finitePf(year2024.pullback.metrics.profitFactor) >= 1.15,
    pullbackPf2025AtLeast115: finitePf(year2025.pullback.metrics.profitFactor) >= 1.15,
    pullbackPositive2024: year2024.pullback.metrics.netPnl > 0,
    pullbackPositive2025: year2025.pullback.metrics.netPnl > 0,
    pullbackAverageRAtLeast010: segmentedEvaluation.pullback.averageR >= 0.1,
    pullbackLongNotLosing: (pullbackSides.long?.netPnl ?? 0) >= 0 && (pullbackSides.long?.tradeCount ?? 0) > 0,
    pullbackShortNotLosing: (pullbackSides.short?.netPnl ?? 0) >= 0 && (pullbackSides.short?.tradeCount ?? 0) > 0,
    exactOverlapAtMost20Pct: continuousEvaluation.overlap.exactFractionOfPullback <= 0.2,
    exactOppositeConflictAtMost5Pct: continuousEvaluation.overlap.exactOppositeFractionOfPullback <= 0.05,
  };
  return { checks, passed: Object.values(checks).every(Boolean), failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name) };
}

function buildSegmentedEvaluation(
  year2024: ReturnType<typeof evaluatePeriod>,
  year2025: ReturnType<typeof evaluatePeriod>,
  overlap: ReturnType<typeof calculateOverlap>,
) {
  return {
    method: "sum_independent_calendar_year_runs_with_10000_initial_equity_each",
    v5: mergeMetrics(year2024.v5.metrics, year2025.v5.metrics),
    pullback: mergeMetrics(year2024.pullback.metrics, year2025.pullback.metrics),
    combined: mergeMetrics(year2024.combined.metrics, year2025.combined.metrics),
    opportunity: {
      combinedAddedTrades: year2024.opportunity.combinedAddedTrades + year2025.opportunity.combinedAddedTrades,
      combinedAddedTradesByEntryYear: {
        "2024": year2024.opportunity.combinedAddedTrades,
        "2025": year2025.opportunity.combinedAddedTrades,
      },
      pullbackStandaloneFilledTrades: year2024.opportunity.pullbackStandaloneFilledTrades + year2025.opportunity.pullbackStandaloneFilledTrades,
      pullbackCombinedFilledTrades: year2024.opportunity.pullbackCombinedFilledTrades + year2025.opportunity.pullbackCombinedFilledTrades,
      pullbackTradesSuppressedByCombination: year2024.opportunity.pullbackTradesSuppressedByCombination + year2025.opportunity.pullbackTradesSuppressedByCombination,
    },
    overlap,
  };
}

function mergeMetrics(
  left: BacktestResult["metrics"],
  right: BacktestResult["metrics"],
) {
  const tradeCount = left.tradeCount + right.tradeCount;
  const grossProfit = left.grossProfit + right.grossProfit;
  const grossLoss = left.grossLoss + right.grossLoss;
  const netPnl = left.netPnl + right.netPnl;
  return {
    initialEquityPerSegment: 10_000,
    tradeCount,
    netPnl,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    averageR: tradeCount ? (left.averageR * left.tradeCount + right.averageR * right.tradeCount) / tradeCount : 0,
    maxDrawdownFraction: Math.max(left.maxDrawdownFraction, right.maxDrawdownFraction),
    fees: left.totalFees + right.totalFees,
    winRate: tradeCount ? (left.winRate * left.tradeCount + right.winRate * right.tradeCount) / tradeCount : 0,
  };
}

function finitePf(value: number | null) {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function summarizeOutput(results: Record<string, ReturnType<typeof evaluatePeriod>>) {
  return Object.fromEntries(Object.entries(results).map(([key, value]) => [key, {
    v5: value.v5.metrics,
    pullback: value.pullback.metrics,
    combined: value.combined.metrics,
    opportunity: value.opportunity,
    overlap: value.overlap,
  }]));
}

function countMissingBars(items: Array<{ time: number }>) {
  let missing = 0;
  for (let index = 1; index < items.length; index += 1) {
    const delta = items[index].time - items[index - 1].time;
    if (delta > 300) missing += Math.floor(delta / 300) - 1;
  }
  return missing;
}
