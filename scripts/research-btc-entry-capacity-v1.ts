import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import { BacktestEngine, type BacktestTrade } from "../server/modules/strategy/backtest/BacktestEngine";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import type { Strategy, StrategyEvaluationContext, StrategySignal } from "../server/modules/strategy/core/types";
import { IctLiquidityReversalStrategy } from "../server/modules/strategy/models/IctLiquidityReversalStrategy";
import { SignalRangePullbackEntryStrategy } from "../server/modules/strategy/models/SignalRangePullbackEntryStrategy";
import { ictResearchCandidateV5, ictResearchCandidateV5Backtest } from "../server/modules/strategy/models/ictResearchCandidate";

const routeId = "ict-btc-v5-same-side-addon-v1-2026-07-17";
const output = path.resolve("research-btc-entry-capacity-v1-2026-07-17.json");
const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange("2021-01", "2026-06")),
  source.loadDays(dayRange("2026-07-01", "2026-07-13")),
]);
const candles = [...new Map([...monthly.candles, ...daily.candles].map((candle) => [candle.time, candle])).values()]
  .sort((left, right) => left.time - right.time);
const missingBarCount = countMissingBars(candles);
if (missingBarCount > 0) throw new Error(`BTC capacity dataset contains ${missingBarCount} missing bars.`);

const periods = [
  ["formation_2021_2023", "2021-01-01", "2023-12-31"],
  ["evaluation_2024", "2024-01-01", "2024-12-31"],
  ["evaluation_2025", "2025-01-01", "2025-12-31"],
  ["historical_recalculation_2026", "2026-01-01", "2026-07-13"],
] as const;

const internal: Record<string, ReturnType<typeof evaluate>> = {};
for (const [id, from, to] of periods) {
  console.log(`[run] ${id}`);
  internal[id] = evaluate(candles, from, to, false);
}
console.log("[run] doubled-cost evaluation 2024 and 2025");
const stressed2024 = evaluate(candles, "2024-01-01", "2024-12-31", true);
const stressed2025 = evaluate(candles, "2025-01-01", "2025-12-31", true);

const results = Object.fromEntries(Object.entries(internal).map(([id, value]) => [id, value.public]));
const segmented = mergeYears(internal.evaluation_2024.public, internal.evaluation_2025.public);
const stressedSegmented = mergeYears(stressed2024.public, stressed2025.public);
const assessment = assess(results, segmented, stressedSegmented);
const report = {
  routeId,
  status: assessment.passed ? "historical_candidate_pending_forward" : "rejected_first_round",
  generatedAt: new Date().toISOString(),
  researchOnly: true,
  automaticOrdersEnabled: false,
  preRegistration: {
    document: "docs/strategy/archive/STRATEGY_BTC_ENTRY_CAPACITY_V1.md",
    base: "ict-btc-v5-2026-07-15",
    addonEntry: { fraction: 0.25, expiryBars: 6, sameSideOnly: true },
    maximumConcurrentPositions: 2,
    maximumConcurrentInitialRiskFraction: 0.005,
    riskNormalization: "fixed_0.25pct_initial_equity_per_1R_sorted_by_exit_time",
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
  doubledCostCombined: stressedSegmented.combined,
  assessment,
  results,
}, null, 2));

function evaluate(allCandles: Candle[], fromDate: string, toDate: string, doubledCosts: boolean) {
  const from = Date.parse(`${fromDate}T00:00:00Z`) / 1000;
  const to = Date.parse(`${toDate}T23:59:59Z`) / 1000;
  const items = allCandles.filter((candle) => candle.time >= from && candle.time <= to);
  const rawSignals = collectRawSignals(items);
  const primaryResult = run(new IctLiquidityReversalStrategy(ictResearchCandidateV5), items, doubledCosts);
  const primaryIds = new Set(primaryResult.trades.map((trade) => trade.signalId));
  const eligibleSignals = rawSignals.filter((signal) => {
    if (primaryIds.has(signal.id)) return false;
    const occupying = primaryResult.trades.find((trade) => signal.createdAt >= trade.entryTime && signal.createdAt <= trade.exitTime);
    return occupying?.side === signal.side;
  });
  const replay = makeReplayStrategy(eligibleSignals);
  const addonStrategy = new SignalRangePullbackEntryStrategy(replay, {
    kind: "signal_range_pullback",
    fraction: 0.25,
    expiryBars: 6,
  });
  const addonResult = run(addonStrategy, items, doubledCosts);
  const primary = normalizedMetrics(primaryResult.trades);
  const addon = normalizedMetrics(addonResult.trades);
  const combined = normalizedMetrics([...primaryResult.trades, ...addonResult.trades]);
  return {
    public: {
      range: { from: fromDate, to: toDate },
      doubledCosts,
      primary,
      addon,
      combined,
      opportunity: {
        rawSignals: rawSignals.length,
        primaryTrades: primaryResult.trades.length,
        missedSignals: rawSignals.length - primaryResult.trades.length,
        eligibleSameSideMissedSignals: eligibleSignals.length,
        addonFilledTrades: addonResult.trades.length,
        combinedAddedTrades: combined.tradeCount - primary.tradeCount,
        addonExpiredOrders: addonResult.diagnostics.expiredOrders,
        addonCostRejectedOrders: addonResult.diagnostics.costRejectedOrders,
      },
      addonSides: groupMetrics(addonResult.trades, (trade) => trade.side),
      addonYears: groupMetrics(addonResult.trades, (trade) => String(new Date(trade.entryTime * 1000).getUTCFullYear())),
      sourceBacktestFees: {
        primary: primaryResult.metrics.totalFees,
        addon: addonResult.metrics.totalFees,
      },
    },
    primaryTrades: primaryResult.trades,
    addonTrades: addonResult.trades,
  };
}

function run(strategy: Strategy, candles: Candle[], doubledCosts: boolean) {
  const config = doubledCosts ? {
    ...ictResearchCandidateV5Backtest,
    makerEntryFeeRate: ictResearchCandidateV5Backtest.makerEntryFeeRate * 2,
    takerEntryFeeRate: (ictResearchCandidateV5Backtest.takerEntryFeeRate ?? ictResearchCandidateV5Backtest.makerEntryFeeRate) * 2,
    takerExitFeeRate: ictResearchCandidateV5Backtest.takerExitFeeRate * 2,
    slippageBps: ictResearchCandidateV5Backtest.slippageBps * 2,
  } : ictResearchCandidateV5Backtest;
  try {
    return new BacktestEngine(strategy, {
      ...config,
      makerEntryFeeRate: doubledCosts ? 0.0009 : 0.00045,
      takerEntryFeeRate: doubledCosts ? 0.0009 : 0.00045,
      takerExitFeeRate: doubledCosts ? 0.0009 : 0.00045,
    }).run(candles);
  } finally {
    strategy.release?.();
  }
}

function collectRawSignals(candles: Candle[]) {
  const strategy = new IctLiquidityReversalStrategy(ictResearchCandidateV5);
  strategy.prepare(candles);
  const signals: StrategySignal[] = [];
  for (let index = strategy.warmupBars; index < candles.length; index += 1) {
    const signal = strategy.evaluate({ candles, index, equity: 10_000 } satisfies StrategyEvaluationContext);
    if (signal) signals.push(signal);
  }
  strategy.release();
  return signals;
}

function makeReplayStrategy(signals: StrategySignal[]): Strategy {
  const byTime = new Map(signals.map((signal) => [signal.createdAt, signal]));
  return {
    id: `${routeId}-eligible-replay`,
    warmupBars: 300,
    evaluate: ({ candles, index }) => byTime.get(candles[index].time) ?? null,
  };
}

function normalizedMetrics(trades: BacktestTrade[]) {
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.signalId.localeCompare(right.signalId));
  const riskUnit = 10_000 * 0.0025;
  let equity = 10_000;
  let peak = equity;
  let maxDrawdownFraction = 0;
  let grossProfitR = 0;
  let grossLossR = 0;
  for (const trade of ordered) {
    equity += trade.rMultiple * riskUnit;
    peak = Math.max(peak, equity);
    maxDrawdownFraction = Math.max(maxDrawdownFraction, (peak - equity) / peak);
    if (trade.rMultiple > 0) grossProfitR += trade.rMultiple;
    if (trade.rMultiple < 0) grossLossR += Math.abs(trade.rMultiple);
  }
  const netR = ordered.reduce((sum, trade) => sum + trade.rMultiple, 0);
  return {
    tradeCount: ordered.length,
    netR,
    normalizedNetPnl: netR * riskUnit,
    profitFactor: grossLossR > 0 ? grossProfitR / grossLossR : grossProfitR > 0 ? null : 0,
    averageR: ordered.length ? netR / ordered.length : 0,
    maxDrawdownFraction,
    grossProfitR,
    grossLossR,
  };
}

function groupMetrics(trades: BacktestTrade[], key: (trade: BacktestTrade) => string) {
  const groups: Record<string, BacktestTrade[]> = {};
  for (const trade of trades) (groups[key(trade)] ??= []).push(trade);
  return Object.fromEntries(Object.entries(groups).map(([id, items]) => [id, normalizedMetrics(items)]));
}

function mergeYears(left: ReturnType<typeof evaluate>["public"], right: ReturnType<typeof evaluate>["public"]) {
  return {
    method: "sum_independent_calendar_year_normalized_runs",
    primary: mergeNormalized(left.primary, right.primary),
    addon: mergeNormalized(left.addon, right.addon),
    combined: mergeNormalized(left.combined, right.combined),
    opportunity: {
      rawSignals: left.opportunity.rawSignals + right.opportunity.rawSignals,
      primaryTrades: left.opportunity.primaryTrades + right.opportunity.primaryTrades,
      eligibleSameSideMissedSignals: left.opportunity.eligibleSameSideMissedSignals + right.opportunity.eligibleSameSideMissedSignals,
      addonFilledTrades: left.opportunity.addonFilledTrades + right.opportunity.addonFilledTrades,
      combinedAddedTrades: left.opportunity.combinedAddedTrades + right.opportunity.combinedAddedTrades,
      added2024: left.opportunity.combinedAddedTrades,
      added2025: right.opportunity.combinedAddedTrades,
    },
    addonSides: mergeGroups(left.addonSides, right.addonSides),
  };
}

type Normalized = ReturnType<typeof normalizedMetrics>;

function mergeNormalized(left: Normalized, right: Normalized): Normalized {
  const tradeCount = left.tradeCount + right.tradeCount;
  const netR = left.netR + right.netR;
  const grossProfitR = left.grossProfitR + right.grossProfitR;
  const grossLossR = left.grossLossR + right.grossLossR;
  return {
    tradeCount,
    netR,
    normalizedNetPnl: netR * 25,
    profitFactor: grossLossR > 0 ? grossProfitR / grossLossR : grossProfitR > 0 ? null : 0,
    averageR: tradeCount ? netR / tradeCount : 0,
    maxDrawdownFraction: Math.max(left.maxDrawdownFraction, right.maxDrawdownFraction),
    grossProfitR,
    grossLossR,
  };
}

function mergeGroups(left: Record<string, Normalized>, right: Record<string, Normalized>) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return Object.fromEntries([...keys].map((key) => [key, mergeNormalized(left[key] ?? normalizedMetrics([]), right[key] ?? normalizedMetrics([]))]));
}

function assess(
  results: Record<string, ReturnType<typeof evaluate>["public"]>,
  segmented: ReturnType<typeof mergeYears>,
  stressed: ReturnType<typeof mergeYears>,
) {
  const year2024 = results.evaluation_2024;
  const year2025 = results.evaluation_2025;
  const year2026 = results.historical_recalculation_2026;
  const checks = {
    combinedTradesAtLeast191: segmented.combined.tradeCount >= 191,
    addedTradesAtLeast32: segmented.opportunity.combinedAddedTrades >= 32,
    added2024AtLeast10: segmented.opportunity.added2024 >= 10,
    added2025AtLeast10: segmented.opportunity.added2025 >= 10,
    combinedProfitFactorNotWorse: finitePf(segmented.combined.profitFactor) >= finitePf(segmented.primary.profitFactor),
    combinedAverageRNotWorse: segmented.combined.averageR >= segmented.primary.averageR,
    drawdownIncreaseAtMost050PctPoint: segmented.combined.maxDrawdownFraction <= segmented.primary.maxDrawdownFraction + 0.005,
    combinedPositive2024: year2024.combined.netR > 0,
    combinedPositive2025: year2025.combined.netR > 0,
    combinedPositiveHistorical2026: year2026.combined.netR > 0,
    addonPositive2024: year2024.addon.netR > 0,
    addonPositive2025: year2025.addon.netR > 0,
    addonPf2024AtLeast115: finitePf(year2024.addon.profitFactor) >= 1.15,
    addonPf2025AtLeast115: finitePf(year2025.addon.profitFactor) >= 1.15,
    addonAverageRAtLeast010: segmented.addon.averageR >= 0.1,
    addonLongNotLosing: (segmented.addonSides.long?.netR ?? 0) >= 0 && (segmented.addonSides.long?.tradeCount ?? 0) > 0,
    addonShortNotLosing: (segmented.addonSides.short?.netR ?? 0) >= 0 && (segmented.addonSides.short?.tradeCount ?? 0) > 0,
    doubledCostCombinedPfAtLeast100: finitePf(stressed.combined.profitFactor) >= 1,
  };
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => key),
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
