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
import { IctLiquidityReversalStrategy } from "../server/modules/strategy/models/IctLiquidityReversalStrategy";
import { ictResearchCandidateV5, ictResearchCandidateV5Backtest } from "../server/modules/strategy/models/ictResearchCandidate";

const routeId = "ict-btc-v5-max2-same-side-v1-2026-07-17";
const output = path.resolve("research-btc-multi-position-v1-2026-07-17.json");
const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange("2021-01", "2026-06")),
  source.loadDays(dayRange("2026-07-01", "2026-07-13")),
]);
const candles = [...new Map([...monthly.candles, ...daily.candles].map((candle) => [candle.time, candle])).values()]
  .sort((left, right) => left.time - right.time);
const missingBarCount = countMissingBars(candles);
if (missingBarCount > 0) throw new Error(`BTC multi-position dataset contains ${missingBarCount} missing bars.`);

const definitions = [
  ["formation_2021_2023", "2021-01-01", "2023-12-31"],
  ["evaluation_2024", "2024-01-01", "2024-12-31"],
  ["evaluation_2025", "2025-01-01", "2025-12-31"],
  ["evaluation_2024_2025", "2024-01-01", "2025-12-31"],
  ["historical_recalculation_2026", "2026-01-01", "2026-07-13"],
] as const;

const results: Record<string, ReturnType<typeof evaluatePeriod>> = {};
for (const [id, from, to] of definitions) {
  console.log(`[run] ${id}`);
  results[id] = evaluatePeriod(candles, from, to, false);
}
console.log("[run] doubled-cost evaluation 2024 and 2025");
const stressed2024 = evaluatePeriod(candles, "2024-01-01", "2024-12-31", true);
const stressed2025 = evaluatePeriod(candles, "2025-01-01", "2025-12-31", true);

const segmented = mergeYears(results.evaluation_2024, results.evaluation_2025);
const stressedSegmented = mergeYears(stressed2024, stressed2025);
const assessment = assess(results, segmented, stressedSegmented);
const report = {
  routeId,
  status: assessment.passed ? "historical_candidate_pending_separate_forward" : "rejected_first_round",
  generatedAt: new Date().toISOString(),
  researchOnly: true,
  automaticOrdersEnabled: false,
  preRegistration: {
    document: "STRATEGY_BTC_MULTI_POSITION_V1.md",
    base: "ict-btc-v5-2026-07-15",
    maxConcurrentPositions: 2,
    concurrentPositionMode: "same_side",
    perPositionRiskFraction: 0.0025,
    maximumConcurrentInitialRiskFraction: 0.005,
    nextBarMarketEntry: true,
    markToMarketEquityCurve: true,
    singleConfiguration: true,
  },
  frozenReferences: {
    routeBChanged: false,
    productionPaperReportsChanged: false,
    forwardDataUsed: false,
    latestResearchCandle: "2026-07-13T23:55:00Z",
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
  doubledCostMulti: stressedSegmented.multi,
  assessment,
  periods: Object.fromEntries(Object.entries(results).map(([id, value]) => [id, compact(value)])),
}, null, 2));

function evaluatePeriod(allCandles: Candle[], fromDate: string, toDate: string, doubledCosts: boolean) {
  const from = Date.parse(`${fromDate}T00:00:00Z`) / 1000;
  const to = Date.parse(`${toDate}T23:59:59Z`) / 1000;
  const items = allCandles.filter((candle) => candle.time >= from && candle.time <= to);
  const single = run(items, 1, doubledCosts);
  const multi = run(items, 2, doubledCosts);
  return {
    range: { from: fromDate, to: toDate },
    doubledCosts,
    single: summarize(single),
    multi: summarize(multi),
    opportunity: {
      addedTrades: multi.metrics.tradeCount - single.metrics.tradeCount,
      maximumConcurrentPositions: multi.diagnostics.maximumConcurrentPositions,
      oppositeSignalsRejected: multi.diagnostics.concurrentSignalsRejected,
      overlappingTrades: countOverlappingEntries(multi.trades),
    },
  };
}

function run(candles: Candle[], maxConcurrentPositions: 1 | 2, doubledCosts: boolean) {
  const costMultiplier = doubledCosts ? 2 : 1;
  const strategy = new IctLiquidityReversalStrategy(ictResearchCandidateV5);
  try {
    return new BacktestEngine(strategy, {
      ...ictResearchCandidateV5Backtest,
      makerEntryFeeRate: 0.00045 * costMultiplier,
      takerEntryFeeRate: 0.00045 * costMultiplier,
      takerExitFeeRate: 0.00045 * costMultiplier,
      slippageBps: costMultiplier,
      maxConcurrentPositions,
      concurrentPositionMode: "same_side",
      markToMarketEquityCurve: true,
    }).run(candles);
  } finally {
    strategy.release();
  }
}

function summarize(result: BacktestResult) {
  return {
    metrics: result.metrics,
    diagnostics: result.diagnostics,
    sides: groupMetrics(result.trades, (trade) => trade.side),
    exits: groupMetrics(result.trades, (trade) => trade.exitReason),
    entryYears: groupMetrics(result.trades, (trade) => String(new Date(trade.entryTime * 1000).getUTCFullYear())),
    concurrency: {
      maximumConcurrentPositions: result.diagnostics.maximumConcurrentPositions,
      oppositeSignalsRejected: result.diagnostics.concurrentSignalsRejected,
      overlappingTrades: countOverlappingEntries(result.trades),
    },
  };
}

function groupMetrics(trades: BacktestTrade[], key: (trade: BacktestTrade) => string) {
  const groups: Record<string, BacktestTrade[]> = {};
  for (const trade of trades) (groups[key(trade)] ??= []).push(trade);
  return Object.fromEntries(Object.entries(groups).map(([id, items]) => [id, calculateTradeMetrics(items)]));
}

function calculateTradeMetrics(trades: BacktestTrade[]) {
  const grossProfit = trades.filter((trade) => trade.netPnl > 0).reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = -trades.filter((trade) => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0);
  return {
    tradeCount: trades.length,
    netPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0),
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    averageR: trades.length ? trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length : 0,
    fees: trades.reduce((sum, trade) => sum + trade.fees, 0),
  };
}

function countOverlappingEntries(trades: BacktestTrade[]) {
  const ordered = [...trades].sort((left, right) => left.entryTime - right.entryTime || left.signalId.localeCompare(right.signalId));
  let count = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const trade = ordered[index];
    if (ordered.some((other, otherIndex) => otherIndex !== index && other.entryTime < trade.entryTime && other.exitTime >= trade.entryTime)) {
      count += 1;
    }
  }
  return count;
}

function mergeYears(left: ReturnType<typeof evaluatePeriod>, right: ReturnType<typeof evaluatePeriod>) {
  return {
    method: "sum_independent_calendar_year_runs_with_mark_to_market_drawdown",
    single: mergeMetrics(left.single.metrics, right.single.metrics),
    multi: mergeMetrics(left.multi.metrics, right.multi.metrics),
    opportunity: {
      addedTrades: left.opportunity.addedTrades + right.opportunity.addedTrades,
      added2024: left.opportunity.addedTrades,
      added2025: right.opportunity.addedTrades,
      maximumConcurrentPositions: Math.max(left.opportunity.maximumConcurrentPositions, right.opportunity.maximumConcurrentPositions),
      oppositeSignalsRejected: left.opportunity.oppositeSignalsRejected + right.opportunity.oppositeSignalsRejected,
      overlappingTrades: left.opportunity.overlappingTrades + right.opportunity.overlappingTrades,
    },
    multiSides: mergeGroups(left.multi.sides, right.multi.sides),
  };
}

function mergeMetrics(left: BacktestResult["metrics"], right: BacktestResult["metrics"]) {
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

type GroupMetric = ReturnType<typeof calculateTradeMetrics>;

function mergeGroups(left: Record<string, GroupMetric>, right: Record<string, GroupMetric>) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return Object.fromEntries([...keys].map((key) => {
    const a = left[key] ?? emptyGroup();
    const b = right[key] ?? emptyGroup();
    const tradeCount = a.tradeCount + b.tradeCount;
    const grossProfit = a.grossProfit + b.grossProfit;
    const grossLoss = a.grossLoss + b.grossLoss;
    return [key, {
      tradeCount,
      netPnl: a.netPnl + b.netPnl,
      grossProfit,
      grossLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
      averageR: tradeCount ? (a.averageR * a.tradeCount + b.averageR * b.tradeCount) / tradeCount : 0,
      fees: a.fees + b.fees,
    }];
  }));
}

function emptyGroup(): GroupMetric {
  return { tradeCount: 0, netPnl: 0, grossProfit: 0, grossLoss: 0, profitFactor: 0, averageR: 0, fees: 0 };
}

function assess(
  all: Record<string, ReturnType<typeof evaluatePeriod>>,
  segmented: ReturnType<typeof mergeYears>,
  stressed: ReturnType<typeof mergeYears>,
) {
  const formation = all.formation_2021_2023;
  const year2024 = all.evaluation_2024;
  const year2025 = all.evaluation_2025;
  const year2026 = all.historical_recalculation_2026;
  const checks = {
    tradesAtLeast191: segmented.multi.tradeCount >= 191,
    added2024AtLeast10: segmented.opportunity.added2024 >= 10,
    added2025AtLeast10: segmented.opportunity.added2025 >= 10,
    profitFactorAtLeast1427: finitePf(segmented.multi.profitFactor) >= 1.427,
    averageRAtLeast0271: segmented.multi.averageR >= 0.271,
    netPnlHigherThanFrozen: segmented.multi.netPnl > 1042.88,
    markedDrawdownAtMost311Pct: segmented.multi.maxDrawdownFraction <= 0.0311,
    positive2024: year2024.multi.metrics.netPnl > 0,
    positive2025: year2025.multi.metrics.netPnl > 0,
    positiveHistorical2026: year2026.multi.metrics.netPnl > 0,
    formationPfNotMoreThan005Worse: finitePf(formation.multi.metrics.profitFactor) >= finitePf(formation.single.metrics.profitFactor) - 0.05,
    longNotLosing: (segmented.multiSides.long?.netPnl ?? 0) >= 0 && (segmented.multiSides.long?.tradeCount ?? 0) > 0,
    shortNotLosing: (segmented.multiSides.short?.netPnl ?? 0) >= 0 && (segmented.multiSides.short?.tradeCount ?? 0) > 0,
    doubledCostPfAtLeast100: finitePf(stressed.multi.profitFactor) >= 1,
    actualConcurrencyReachedTwo: segmented.opportunity.maximumConcurrentPositions === 2,
  };
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => key),
  };
}

function compact(value: ReturnType<typeof evaluatePeriod>) {
  return {
    single: value.single.metrics,
    multi: value.multi.metrics,
    opportunity: value.opportunity,
    multiSides: value.multi.sides,
    multiExits: value.multi.exits,
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
