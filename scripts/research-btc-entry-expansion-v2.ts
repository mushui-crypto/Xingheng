import { createHash } from "node:crypto";
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
import {
  IctConfirmedPullbackContinuationStrategy,
  ictRouteAConfirmedPullbackV2Config,
} from "../server/modules/strategy/models/IctConfirmedPullbackContinuationStrategy";
import { IctLiquidityReversalStrategy } from "../server/modules/strategy/models/IctLiquidityReversalStrategy";
import { ictResearchCandidateV5, ictResearchCandidateV5Backtest } from "../server/modules/strategy/models/ictResearchCandidate";

const output = path.resolve("research-btc-entry-expansion-v2-2026-07-17.json");
const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange("2021-01", "2026-06")),
  source.loadDays(dayRange("2026-07-01", "2026-07-13")),
]);
const candles = [...new Map([...monthly.candles, ...daily.candles].map((candle) => [candle.time, candle])).values()]
  .sort((left, right) => left.time - right.time);
const missingBarCount = countMissingBars(candles);
if (missingBarCount > 0) throw new Error(`BTC entry V2 dataset contains ${missingBarCount} missing 5m bars.`);

const periodDefinitions = [
  ["formation_2021_2023", "2021-01-01", "2023-12-31"],
  ["evaluation_2024", "2024-01-01", "2024-12-31"],
  ["evaluation_2025", "2025-01-01", "2025-12-31"],
  ["evaluation_2024_2025", "2024-01-01", "2025-12-31"],
  ["historical_recalculation_2026", "2026-01-01", "2026-07-13"],
] as const;

const results: Record<string, ReturnType<typeof evaluatePeriod>> = {};
for (const [id, from, to] of periodDefinitions) {
  console.log(`[run] ${id}`);
  results[id] = evaluatePeriod(candles, from, to, false);
}
console.log("[run] doubled-cost evaluation 2024 and 2025");
const stressed2024 = evaluatePeriod(candles, "2024-01-01", "2024-12-31", true);
const stressed2025 = evaluatePeriod(candles, "2025-01-01", "2025-12-31", true);

const segmented = buildSegmented(results.evaluation_2024, results.evaluation_2025);
const stressedSegmented = buildSegmented(stressed2024, stressed2025);
const assessment = assess(results, segmented, stressedSegmented);
const report = {
  routeId: ictRouteAConfirmedPullbackV2Config.routeId,
  status: assessment.passed ? "historical_candidate_pending_forward" : "rejected_first_round",
  generatedAt: new Date().toISOString(),
  researchOnly: true,
  automaticOrdersEnabled: false,
  frozenReferences: {
    v5ArchiveId: "ict-btc-v5-2026-07-15",
    routeBChanged: false,
    productionPaperReportsChanged: false,
    forwardDataUsed: false,
    latestResearchCandle: "2026-07-13T23:55:00Z",
  },
  preRegistration: {
    document: "STRATEGY_BTC_ENTRY_EXPANSION_V2.md",
    fixedCandidate: ictRouteAConfirmedPullbackV2Config,
    singleConfiguration: true,
    v5PriorityOnExactConflict: true,
    thresholds: {
      minimumCombinedTrades2024To2025: 191,
      minimumAddedTrades2024To2025: 32,
      minimumAddedTradesEachYear: 10,
      minimumCombinedProfitFactor: 1.427,
      maximumCombinedDrawdownFraction: 0.0236,
      minimumCombinedNetPnl: 1042.88,
      minimumSetupProfitFactorEachYear: 1.15,
      minimumSetupAverageR: 0.1,
      maximumExactOverlapFraction: 0.2,
      maximumOppositeConflictFraction: 0.05,
      minimumDoubledCostCombinedProfitFactor: 1,
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
  segmentedEvaluation2024To2025: segmented,
  doubledCostEvaluation2024To2025: stressedSegmented,
  results,
  assessment,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output,
  deterministicHash: deterministicHash(report),
  status: report.status,
  dataQuality: report.dataQuality,
  segmented,
  doubledCost: stressedSegmented.combined,
  assessment,
  periods: Object.fromEntries(Object.entries(results).map(([id, value]) => [id, compact(value)])),
}, null, 2));

function evaluatePeriod(allCandles: Candle[], fromDate: string, toDate: string, doubledCosts: boolean) {
  const from = Date.parse(`${fromDate}T00:00:00Z`) / 1000;
  const to = Date.parse(`${toDate}T23:59:59Z`) / 1000;
  const periodCandles = allCandles.filter((candle) => candle.time >= from && candle.time <= to);
  const v5 = run(makeV5(), periodCandles, doubledCosts);
  const confirmed = run(makeConfirmed(), periodCandles, doubledCosts);
  const combined = run(makeCombined(), periodCandles, doubledCosts);
  const rawV5 = collectSignals(makeV5(), periodCandles);
  const rawConfirmed = collectSignals(makeConfirmed(), periodCandles);
  const sourceCounts = combined.trades.reduce<Record<string, number>>((groups, trade) => {
    const sourceId = trade.signalId.startsWith("v5:") ? "v5" : trade.signalId.startsWith("v8:") ? "confirmed" : "unknown";
    groups[sourceId] = (groups[sourceId] ?? 0) + 1;
    return groups;
  }, {});
  return {
    range: { from: fromDate, to: toDate },
    doubledCosts,
    v5: summarize(v5),
    confirmed: summarize(confirmed),
    combined: { ...summarize(combined), sourceCounts },
    opportunity: {
      combinedAddedTrades: combined.metrics.tradeCount - v5.metrics.tradeCount,
      confirmedStandaloneTrades: confirmed.metrics.tradeCount,
      confirmedCombinedTrades: sourceCounts.confirmed ?? 0,
      confirmedSuppressedByCombination: confirmed.metrics.tradeCount - (sourceCounts.confirmed ?? 0),
    },
    overlap: overlap(rawV5, rawConfirmed),
  };
}

function makeV5() {
  return new IctLiquidityReversalStrategy(ictResearchCandidateV5);
}

function makeConfirmed() {
  return new IctConfirmedPullbackContinuationStrategy(ictRouteAConfirmedPullbackV2Config);
}

function makeCombined(): Strategy {
  const v5 = makeV5();
  const confirmed = makeConfirmed();
  return {
    id: "ict-btc-v5-plus-confirmed-pullback-v2",
    warmupBars: Math.max(v5.warmupBars, confirmed.warmupBars),
    prepare: (items) => { v5.prepare(items); confirmed.prepare(items); },
    release: () => { v5.release(); confirmed.release(); },
    evaluate: (context) => {
      const v5Signal = v5.evaluate(context);
      const confirmedSignal = confirmed.evaluate(context);
      if (v5Signal) return tag(v5Signal, "v5");
      return confirmedSignal ? tag(confirmedSignal, "v8") : null;
    },
  };
}

function tag(signal: StrategySignal, sourceId: "v5" | "v8") {
  return { ...signal, id: `${sourceId}:${signal.id}`, evidence: { ...signal.evidence, combinationSource: sourceId } };
}

function run(strategy: Strategy, items: Candle[], doubledCosts: boolean) {
  const config = doubledCosts ? {
    ...ictResearchCandidateV5Backtest,
    makerEntryFeeRate: ictResearchCandidateV5Backtest.makerEntryFeeRate * 2,
    takerEntryFeeRate: (ictResearchCandidateV5Backtest.takerEntryFeeRate ?? ictResearchCandidateV5Backtest.makerEntryFeeRate) * 2,
    takerExitFeeRate: ictResearchCandidateV5Backtest.takerExitFeeRate * 2,
    slippageBps: ictResearchCandidateV5Backtest.slippageBps * 2,
  } : ictResearchCandidateV5Backtest;
  const result = new BacktestEngine(strategy, config).run(items);
  strategy.release?.();
  return result;
}

function collectSignals(strategy: Strategy, items: Candle[]) {
  strategy.prepare?.(items);
  const signals: StrategySignal[] = [];
  for (let index = strategy.warmupBars; index < items.length; index += 1) {
    const signal = strategy.evaluate({ candles: items, index, equity: 10_000 } satisfies StrategyEvaluationContext);
    if (signal) signals.push(signal);
  }
  strategy.release?.();
  return signals;
}

function overlap(v5: StrategySignal[], confirmed: StrategySignal[]) {
  const v5ByTime = new Map(v5.map((signal) => [signal.createdAt, signal]));
  let exact = 0;
  let exactOpposite = 0;
  for (const signal of confirmed) {
    const match = v5ByTime.get(signal.createdAt);
    if (!match) continue;
    exact += 1;
    if (match.side !== signal.side) exactOpposite += 1;
  }
  return {
    v5RawSignals: v5.length,
    confirmedRawSignals: confirmed.length,
    exact,
    exactOpposite,
    exactFractionOfConfirmed: confirmed.length ? exact / confirmed.length : 0,
    oppositeFractionOfConfirmed: confirmed.length ? exactOpposite / confirmed.length : 0,
  };
}

function summarize(result: BacktestResult) {
  return {
    metrics: result.metrics,
    diagnostics: result.diagnostics,
    sides: groupMetrics(result.trades, (trade) => trade.side),
    exits: groupMetrics(result.trades, (trade) => trade.exitReason),
    entryYears: groupMetrics(result.trades, (trade) => String(new Date(trade.entryTime * 1000).getUTCFullYear())),
  };
}

function groupMetrics(trades: BacktestTrade[], key: (trade: BacktestTrade) => string) {
  const groups: Record<string, BacktestTrade[]> = {};
  for (const trade of trades) (groups[key(trade)] ??= []).push(trade);
  return Object.fromEntries(Object.entries(groups).map(([id, items]) => [id, metrics(items)]));
}

function metrics(trades: BacktestTrade[]) {
  const grossProfit = trades.filter((trade) => trade.netPnl > 0).reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = -trades.filter((trade) => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0);
  let equity = 10_000;
  let peak = equity;
  let maxDrawdownFraction = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maxDrawdownFraction = Math.max(maxDrawdownFraction, (peak - equity) / peak);
  }
  return {
    tradeCount: trades.length,
    netPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0),
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    averageR: trades.length ? trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length : 0,
    maxDrawdownFraction,
    fees: trades.reduce((sum, trade) => sum + trade.fees, 0),
  };
}

function buildSegmented(year2024: ReturnType<typeof evaluatePeriod>, year2025: ReturnType<typeof evaluatePeriod>) {
  return {
    method: "sum_independent_calendar_year_runs_with_10000_initial_equity_each",
    v5: merge(year2024.v5.metrics, year2025.v5.metrics),
    confirmed: merge(year2024.confirmed.metrics, year2025.confirmed.metrics),
    combined: merge(year2024.combined.metrics, year2025.combined.metrics),
    opportunity: {
      combinedAddedTrades: year2024.opportunity.combinedAddedTrades + year2025.opportunity.combinedAddedTrades,
      added2024: year2024.opportunity.combinedAddedTrades,
      added2025: year2025.opportunity.combinedAddedTrades,
      confirmedStandaloneTrades: year2024.opportunity.confirmedStandaloneTrades + year2025.opportunity.confirmedStandaloneTrades,
      confirmedCombinedTrades: year2024.opportunity.confirmedCombinedTrades + year2025.opportunity.confirmedCombinedTrades,
    },
  };
}

function merge(left: BacktestResult["metrics"], right: BacktestResult["metrics"]) {
  const tradeCount = left.tradeCount + right.tradeCount;
  const grossProfit = left.grossProfit + right.grossProfit;
  const grossLoss = left.grossLoss + right.grossLoss;
  return {
    tradeCount,
    netPnl: left.netPnl + right.netPnl,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    averageR: tradeCount ? (left.averageR * left.tradeCount + right.averageR * right.tradeCount) / tradeCount : 0,
    maxDrawdownFraction: Math.max(left.maxDrawdownFraction, right.maxDrawdownFraction),
    fees: left.totalFees + right.totalFees,
  };
}

function assess(
  all: Record<string, ReturnType<typeof evaluatePeriod>>,
  segmented: ReturnType<typeof buildSegmented>,
  stressed: ReturnType<typeof buildSegmented>,
) {
  const year2024 = all.evaluation_2024;
  const year2025 = all.evaluation_2025;
  const historical2026 = all.historical_recalculation_2026;
  const continuous = all.evaluation_2024_2025;
  const sides = continuous.confirmed.sides;
  const checks = {
    combinedTradesAtLeast191: segmented.combined.tradeCount >= 191,
    addedTradesAtLeast32: segmented.opportunity.combinedAddedTrades >= 32,
    added2024AtLeast10: segmented.opportunity.added2024 >= 10,
    added2025AtLeast10: segmented.opportunity.added2025 >= 10,
    combinedProfitFactorNotWorse: finitePf(segmented.combined.profitFactor) >= 1.427,
    combinedDrawdownNotWorse: segmented.combined.maxDrawdownFraction <= 0.0236,
    combinedNetPnlHigher: segmented.combined.netPnl > 1042.88,
    combinedPositive2024: year2024.combined.metrics.netPnl > 0,
    combinedPositive2025: year2025.combined.metrics.netPnl > 0,
    combinedPositiveHistorical2026: historical2026.combined.metrics.netPnl > 0,
    setupPf2024AtLeast115: finitePf(year2024.confirmed.metrics.profitFactor) >= 1.15,
    setupPf2025AtLeast115: finitePf(year2025.confirmed.metrics.profitFactor) >= 1.15,
    setupPositive2024: year2024.confirmed.metrics.netPnl > 0,
    setupPositive2025: year2025.confirmed.metrics.netPnl > 0,
    setupAverageRAtLeast010: segmented.confirmed.averageR >= 0.1,
    setupLongNotLosing: (sides.long?.netPnl ?? 0) >= 0 && (sides.long?.tradeCount ?? 0) > 0,
    setupShortNotLosing: (sides.short?.netPnl ?? 0) >= 0 && (sides.short?.tradeCount ?? 0) > 0,
    exactOverlapAtMost20Pct: continuous.overlap.exactFractionOfConfirmed <= 0.2,
    oppositeConflictAtMost5Pct: continuous.overlap.oppositeFractionOfConfirmed <= 0.05,
    doubledCostCombinedPfAtLeast100: finitePf(stressed.combined.profitFactor) >= 1,
  };
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

function compact(value: ReturnType<typeof evaluatePeriod>) {
  return {
    v5: value.v5.metrics,
    confirmed: value.confirmed.metrics,
    combined: value.combined.metrics,
    opportunity: value.opportunity,
    overlap: value.overlap,
  };
}

function finitePf(value: number | null) {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function deterministicHash(value: typeof report) {
  const copy = structuredClone(value);
  delete (copy as { generatedAt?: string }).generatedAt;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function countMissingBars(items: Array<{ time: number }>) {
  let missing = 0;
  for (let index = 1; index < items.length; index += 1) {
    const delta = items[index].time - items[index - 1].time;
    if (delta > 300) missing += Math.floor(delta / 300) - 1;
  }
  return missing;
}
