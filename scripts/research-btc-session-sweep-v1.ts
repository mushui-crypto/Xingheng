import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import { BacktestEngine, type BacktestResult, type BacktestTrade } from "../server/modules/strategy/backtest/BacktestEngine";
import { BinanceVisionHistoricalDataSource, dayRange, monthRange } from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import type { Strategy, StrategyEvaluationContext, StrategySignal } from "../server/modules/strategy/core/types";
import { BtcSessionRangeSweepStrategy, btcSessionRangeSweepV1Config } from "../server/modules/strategy/models/BtcSessionRangeSweepStrategy";
import { IctLiquidityReversalStrategy } from "../server/modules/strategy/models/IctLiquidityReversalStrategy";
import { ictResearchCandidateV5, ictResearchCandidateV5Backtest } from "../server/modules/strategy/models/ictResearchCandidate";

const output = path.resolve("research-btc-session-sweep-v1-2026-07-17.json");
const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange("2021-01", "2026-06")),
  source.loadDays(dayRange("2026-07-01", "2026-07-13")),
]);
const candles = [...new Map([...monthly.candles, ...daily.candles].map((candle) => [candle.time, candle])).values()]
  .sort((left, right) => left.time - right.time);
const missingBarCount = countMissingBars(candles);
if (missingBarCount > 0) throw new Error(`Session sweep dataset contains ${missingBarCount} missing bars.`);

const periods = [
  ["formation_2021_2023", "2021-01-01", "2023-12-31"],
  ["evaluation_2024", "2024-01-01", "2024-12-31"],
  ["evaluation_2025", "2025-01-01", "2025-12-31"],
  ["evaluation_2024_2025", "2024-01-01", "2025-12-31"],
  ["historical_recalculation_2026", "2026-01-01", "2026-07-13"],
] as const;
const results: Record<string, ReturnType<typeof evaluate>> = {};
for (const [id, from, to] of periods) {
  console.log(`[run] ${id}`);
  results[id] = evaluate(candles, from, to, false);
}
console.log("[run] doubled-cost evaluation 2024 and 2025");
const stress2024 = evaluate(candles, "2024-01-01", "2024-12-31", true);
const stress2025 = evaluate(candles, "2025-01-01", "2025-12-31", true);
const segmented = mergeYears(results.evaluation_2024, results.evaluation_2025);
const stressed = mergeYears(stress2024, stress2025);
const assessment = assess(results, segmented, stressed);
const report = {
  routeId: btcSessionRangeSweepV1Config.routeId,
  status: assessment.passed ? "historical_candidate_pending_forward" : "rejected_first_round",
  generatedAt: new Date().toISOString(),
  researchOnly: true,
  automaticOrdersEnabled: false,
  preRegistration: {
    document: "STRATEGY_BTC_SESSION_SWEEP_V1.md",
    setup: btcSessionRangeSweepV1Config,
    combinedMaxConcurrentPositions: 2,
    concurrentPositionMode: "same_side",
    minimumTrades2024To2025: 360,
    singleConfiguration: true,
  },
  frozenReferences: {
    v5ArchiveId: "ict-btc-v5-2026-07-15",
    routeBChanged: false,
    productionPaperReportsChanged: false,
    forwardDataUsed: false,
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
  doubledCostEvaluation2024To2025: stressed,
  results,
  assessment,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output,
  deterministicHash: deterministicHash(report),
  status: report.status,
  segmented,
  doubledCostCombined: stressed.combined,
  assessment,
  periods: Object.fromEntries(Object.entries(results).map(([id, value]) => [id, compact(value)])),
}, null, 2));

function evaluate(all: Candle[], fromDate: string, toDate: string, doubledCosts: boolean) {
  const from = Date.parse(`${fromDate}T00:00:00Z`) / 1000;
  const to = Date.parse(`${toDate}T23:59:59Z`) / 1000;
  const items = all.filter((candle) => candle.time >= from && candle.time <= to);
  const v5 = run(makeV5(), items, 1, doubledCosts);
  const session = run(makeSession(), items, 2, doubledCosts);
  const combined = run(makeCombined(), items, 2, doubledCosts);
  const rawV5 = collectSignals(makeV5(), items);
  const rawSession = collectSignals(makeSession(), items);
  return {
    range: { from: fromDate, to: toDate },
    doubledCosts,
    v5: summarize(v5),
    session: summarize(session),
    combined: summarize(combined),
    opportunity: {
      addedTrades: combined.metrics.tradeCount - v5.metrics.tradeCount,
      maximumConcurrentPositions: combined.diagnostics.maximumConcurrentPositions,
      oppositeSignalsRejected: combined.diagnostics.concurrentSignalsRejected,
      exactSignalOverlap: exactOverlap(rawV5, rawSession),
      v5RawSignals: rawV5.length,
      sessionRawSignals: rawSession.length,
    },
  };
}

function makeV5() {
  return new IctLiquidityReversalStrategy(ictResearchCandidateV5);
}

function makeSession() {
  return new BtcSessionRangeSweepStrategy(btcSessionRangeSweepV1Config);
}

function makeCombined(): Strategy {
  const v5 = makeV5();
  const session = makeSession();
  return {
    id: "ict-btc-v5-plus-session-range-sweep-v1",
    warmupBars: Math.max(v5.warmupBars, session.warmupBars),
    prepare: (candles) => { v5.prepare(candles); session.prepare(candles); },
    release: () => { v5.release(); session.release(); },
    evaluate: (context) => {
      const v5Signal = v5.evaluate(context);
      const sessionSignal = session.evaluate(context);
      if (v5Signal) return tag(v5Signal, "v5");
      return sessionSignal ? tag(sessionSignal, "session") : null;
    },
  };
}

function tag(signal: StrategySignal, sourceId: "v5" | "session") {
  return { ...signal, id: `${sourceId}:${signal.id}`, evidence: { ...signal.evidence, combinationSource: sourceId } };
}

function run(strategy: Strategy, candles: Candle[], maxConcurrentPositions: 1 | 2, doubledCosts: boolean) {
  const multiplier = doubledCosts ? 2 : 1;
  try {
    return new BacktestEngine(strategy, {
      ...ictResearchCandidateV5Backtest,
      makerEntryFeeRate: 0.00045 * multiplier,
      takerEntryFeeRate: 0.00045 * multiplier,
      takerExitFeeRate: 0.00045 * multiplier,
      slippageBps: multiplier,
      maxConcurrentPositions,
      concurrentPositionMode: "same_side",
      markToMarketEquityCurve: true,
    }).run(candles);
  } finally {
    strategy.release?.();
  }
}

function collectSignals(strategy: Strategy, candles: Candle[]) {
  strategy.prepare?.(candles);
  const signals: StrategySignal[] = [];
  for (let index = strategy.warmupBars; index < candles.length; index += 1) {
    const signal = strategy.evaluate({ candles, index, equity: 10_000 } satisfies StrategyEvaluationContext);
    if (signal) signals.push(signal);
  }
  strategy.release?.();
  return signals;
}

function exactOverlap(left: StrategySignal[], right: StrategySignal[]) {
  const byTime = new Set(left.map((signal) => signal.createdAt));
  return right.filter((signal) => byTime.has(signal.createdAt)).length;
}

function summarize(result: BacktestResult) {
  return {
    metrics: result.metrics,
    diagnostics: result.diagnostics,
    sides: group(result.trades, (trade) => trade.side),
    exits: group(result.trades, (trade) => trade.exitReason),
    sources: group(result.trades, (trade) => trade.signalId.startsWith("v5:") ? "v5" : trade.signalId.startsWith("session:") ? "session" : "standalone"),
  };
}

function group(trades: BacktestTrade[], key: (trade: BacktestTrade) => string) {
  const groups: Record<string, BacktestTrade[]> = {};
  for (const trade of trades) (groups[key(trade)] ??= []).push(trade);
  return Object.fromEntries(Object.entries(groups).map(([id, items]) => [id, tradeMetrics(items)]));
}

function tradeMetrics(trades: BacktestTrade[]) {
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

function mergeYears(left: ReturnType<typeof evaluate>, right: ReturnType<typeof evaluate>) {
  return {
    v5: mergeMetrics(left.v5.metrics, right.v5.metrics),
    session: mergeMetrics(left.session.metrics, right.session.metrics),
    combined: mergeMetrics(left.combined.metrics, right.combined.metrics),
    opportunity: {
      addedTrades: left.opportunity.addedTrades + right.opportunity.addedTrades,
      combined2024: left.combined.metrics.tradeCount,
      combined2025: right.combined.metrics.tradeCount,
      maximumConcurrentPositions: Math.max(left.opportunity.maximumConcurrentPositions, right.opportunity.maximumConcurrentPositions),
      exactSignalOverlap: left.opportunity.exactSignalOverlap + right.opportunity.exactSignalOverlap,
    },
    sessionSides: mergeGroups(left.session.sides, right.session.sides),
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

type GroupMetric = ReturnType<typeof tradeMetrics>;
function mergeGroups(left: Record<string, GroupMetric>, right: Record<string, GroupMetric>) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return Object.fromEntries([...keys].map((key) => {
    const a = left[key] ?? empty();
    const b = right[key] ?? empty();
    const tradeCount = a.tradeCount + b.tradeCount;
    const grossProfit = a.grossProfit + b.grossProfit;
    const grossLoss = a.grossLoss + b.grossLoss;
    return [key, { tradeCount, netPnl: a.netPnl + b.netPnl, grossProfit, grossLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
      averageR: tradeCount ? (a.averageR * a.tradeCount + b.averageR * b.tradeCount) / tradeCount : 0,
      fees: a.fees + b.fees }];
  }));
}
function empty(): GroupMetric { return { tradeCount: 0, netPnl: 0, grossProfit: 0, grossLoss: 0, profitFactor: 0, averageR: 0, fees: 0 }; }

function assess(all: Record<string, ReturnType<typeof evaluate>>, segmented: ReturnType<typeof mergeYears>, stressed: ReturnType<typeof mergeYears>) {
  const sides = segmented.sessionSides;
  const checks = {
    combinedTradesAtLeast360: segmented.combined.tradeCount >= 360,
    combined2024AtLeast160: segmented.opportunity.combined2024 >= 160,
    combined2025AtLeast160: segmented.opportunity.combined2025 >= 160,
    combinedPfAtLeast120: finitePf(segmented.combined.profitFactor) >= 1.2,
    combinedAverageRAtLeast010: segmented.combined.averageR >= 0.1,
    combinedDrawdownAtMost10Pct: segmented.combined.maxDrawdownFraction <= 0.1,
    combinedPositive2024: all.evaluation_2024.combined.metrics.netPnl > 0,
    combinedPositive2025: all.evaluation_2025.combined.metrics.netPnl > 0,
    combinedPositive2026: all.historical_recalculation_2026.combined.metrics.netPnl > 0,
    formationCombinedPfAtLeast100: finitePf(all.formation_2021_2023.combined.metrics.profitFactor) >= 1,
    sessionPf2024AtLeast105: finitePf(all.evaluation_2024.session.metrics.profitFactor) >= 1.05,
    sessionPf2025AtLeast105: finitePf(all.evaluation_2025.session.metrics.profitFactor) >= 1.05,
    sessionPositive2024: all.evaluation_2024.session.metrics.netPnl > 0,
    sessionPositive2025: all.evaluation_2025.session.metrics.netPnl > 0,
    sessionLongNotLosing: (sides.long?.netPnl ?? 0) >= 0 && (sides.long?.tradeCount ?? 0) > 0,
    sessionShortNotLosing: (sides.short?.netPnl ?? 0) >= 0 && (sides.short?.tradeCount ?? 0) > 0,
    doubledCostPfAtLeast100: finitePf(stressed.combined.profitFactor) >= 1,
  };
  return { checks, passed: Object.values(checks).every(Boolean), failedChecks: Object.entries(checks).filter(([, value]) => !value).map(([key]) => key) };
}

function compact(value: ReturnType<typeof evaluate>) {
  return { v5: value.v5.metrics, session: value.session.metrics, combined: value.combined.metrics, opportunity: value.opportunity };
}
function finitePf(value: number | null) { return value === null ? Number.POSITIVE_INFINITY : value; }
function deterministicHash(value: typeof report) { const copy = structuredClone(value); delete (copy as { generatedAt?: string }).generatedAt; return createHash("sha256").update(JSON.stringify(copy)).digest("hex"); }
function countMissingBars(items: Array<{ time: number }>) { let missing = 0; for (let index = 1; index < items.length; index += 1) { const delta = items[index].time - items[index - 1].time; if (delta > 300) missing += Math.floor(delta / 300) - 1; } return missing; }
