import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BacktestEngine,
  defaultBacktestConfig,
  type BacktestResult,
  type BacktestTrade,
} from "../server/modules/strategy/backtest/BacktestEngine";
import {
  BinanceVisionHistoricalDataSource,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import { EthOrderFlowStructureStrategy } from "../server/modules/strategy/models/EthOrderFlowStructureStrategy";
import { RewardRiskBreakEvenStrategy } from "../server/modules/strategy/models/RewardRiskBreakEvenStrategy";
import { SignalRangePullbackEntryStrategy } from "../server/modules/strategy/models/SignalRangePullbackEntryStrategy";

const routeId = "eth-break-even-route-v1-trigger-1r-2026-07-17";
const outputPath = path.resolve("research-eth-break-even-route-v1-trigger-1r-2026-07-17.json");
const commonBacktestConfig = {
  ...defaultBacktestConfig,
  makerEntryFeeRate: 0.00045,
  takerEntryFeeRate: 0.00045,
  takerExitFeeRate: 0.00045,
  slippageBps: 1,
  maxLeverage: 3,
  closePositionAtSessionEnd: false,
  accountRiskControlsEnabled: false,
};
const lowBacktestConfig = {
  ...commonBacktestConfig,
  sessionTimeZone: "UTC",
  sessionStartMinute: 0,
  sessionEndMinute: 0,
};
const highBacktestConfig = {
  ...commonBacktestConfig,
  sessionTimeZone: "Asia/Shanghai",
  sessionStartMinute: 18 * 60,
  sessionEndMinute: 8 * 60,
};

const source = new BinanceVisionHistoricalDataSource();
const loaded = await source.loadMonths(monthRange("2021-01", "2023-12", "ETHUSDT"));
if (!loaded.quality.checksumVerified || loaded.quality.missingBarCount !== 0) {
  throw new Error(`ETH data quality failed: checksum=${loaded.quality.checksumVerified} gaps=${loaded.quality.missingBarCount}`);
}
const candles = loaded.candles;

const lowBaseline = runLow(false);
console.log("[run] low-baseline");
const lowBreakEven = runLow(true);
console.log("[run] low-break-even-1r");
const highBaseline = runHigh(false);
console.log("[run] high-baseline");
const highBreakEven = runHigh(true);
console.log("[run] high-break-even-1r");

const low = compare("low_frequency_v5", lowBaseline, lowBreakEven);
const high = compare("high_frequency_pullback25_expiry6", highBaseline, highBreakEven);
const report = {
  routeId,
  generatedAt: new Date().toISOString(),
  status: low.candidatePassed || high.candidatePassed
    ? "historical_execution_candidate_pending_new_forward"
    : "rejected_break_even_execution",
  researchOnly: true,
  automaticOrdersEnabled: false,
  preRegistration: {
    document: "STRATEGY_ETH_BREAK_EVEN_ROUTE_V1.md",
    period: "2021-01-01..2023-12-31",
    cleanHistoricalHoldoutAvailable: false,
    activationRewardRisk: 1,
    movedStopPrice: "actual_entry_price",
    partialExitFraction: 0,
    finalRewardRisk: 2,
    sameCandleOrder: ["initial_stop", "activate_1r", "break_even_stop", "target_2r"],
  },
  dataQuality: loaded.quality,
  costs: {
    makerEntryFeeRate: 0.00045,
    takerEntryFeeRate: 0.00045,
    takerExitFeeRate: 0.00045,
    slippageBpsPerSide: 1,
  },
  low,
  high,
  decision: {
    candidateFormed: low.candidatePassed || high.candidatePassed,
    nextAction: low.candidatePassed || high.candidatePassed
      ? "freeze_passing_version_for_new_forward_only"
      : "close_route_without_additional_break_even_grid",
  },
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output: outputPath,
  deterministicHash: hashWithoutGeneratedAt(report),
  status: report.status,
  low: compact(low),
  high: compact(high),
  decision: report.decision,
}, null, 2));

function runLow(useBreakEven: boolean) {
  const base = new EthOrderFlowStructureStrategy({
    symbol: "ETHUSDT",
    family: "taker_imbalance_continuation",
    threshold: 1.25,
    structureLookbackBars: 12,
    riskFraction: 0.0025,
  });
  const strategy = useBreakEven ? new RewardRiskBreakEvenStrategy(base, 1) : base;
  try {
    return new BacktestEngine(strategy, lowBacktestConfig).run(candles);
  } finally {
    strategy.release();
  }
}

function runHigh(useBreakEven: boolean) {
  const base = new EthOrderFlowStructureStrategy({
    symbol: "ETHUSDT",
    family: "taker_imbalance_continuation",
    threshold: 0.75,
    structureLookbackBars: 6,
    riskFraction: 0.0025,
  });
  const entry = new SignalRangePullbackEntryStrategy(base, {
    kind: "signal_range_pullback",
    fraction: 0.25,
    expiryBars: 6,
  });
  const strategy = useBreakEven ? new RewardRiskBreakEvenStrategy(entry, 1) : entry;
  try {
    return new BacktestEngine(strategy, highBacktestConfig).run(candles);
  } finally {
    strategy.release();
  }
}

function compare(id: string, baseline: BacktestResult, breakEven: BacktestResult) {
  const baselineSummary = summarize(baseline);
  const breakEvenSummary = summarize(breakEven);
  const executionImproved = (
    numericProfitFactor(breakEven.metrics.profitFactor) >= numericProfitFactor(baseline.metrics.profitFactor) &&
    breakEven.metrics.averageR >= baseline.metrics.averageR &&
    breakEven.metrics.maxDrawdownFraction <= baseline.metrics.maxDrawdownFraction
  );
  const positiveYears = Object.values(breakEvenSummary.yearly).filter((item) => item.netPnl > 0).length;
  const candidateChecks = {
    executionImproved,
    tradesAtLeast90: breakEven.metrics.tradeCount >= 90,
    profitFactorAtLeast115: numericProfitFactor(breakEven.metrics.profitFactor) >= 1.15,
    averageRAtLeast010: breakEven.metrics.averageR >= 0.10,
    drawdownAtMost15Pct: breakEven.metrics.maxDrawdownFraction <= 0.15,
    atLeastTwoPositiveYears: positiveYears >= 2,
  };
  return {
    id,
    baseline: baselineSummary,
    breakEven: breakEvenSummary,
    delta: {
      trades: breakEven.metrics.tradeCount - baseline.metrics.tradeCount,
      netPnl: breakEven.metrics.netPnl - baseline.metrics.netPnl,
      profitFactor: numericProfitFactor(breakEven.metrics.profitFactor) - numericProfitFactor(baseline.metrics.profitFactor),
      averageR: breakEven.metrics.averageR - baseline.metrics.averageR,
      maxDrawdownFraction: breakEven.metrics.maxDrawdownFraction - baseline.metrics.maxDrawdownFraction,
      fees: breakEven.metrics.totalFees - baseline.metrics.totalFees,
    },
    executionImproved,
    candidateChecks,
    candidatePassed: Object.values(candidateChecks).every(Boolean),
  };
}

function summarize(result: BacktestResult) {
  return {
    metrics: result.metrics,
    yearly: summarizeTrades(result.trades, (trade) => String(new Date(trade.entryTime * 1000).getUTCFullYear())),
    sides: summarizeTrades(result.trades, (trade) => trade.side),
    exits: summarizeTrades(result.trades, (trade) => trade.exitReason),
    breakEvenDiagnostics: {
      activated: result.trades.filter((trade) => trade.breakEvenActivatedAt !== null && trade.breakEvenActivatedAt !== undefined).length,
      breakEvenExits: result.trades.filter((trade) => trade.exitReason === "break_even").length,
      targetsAfterActivation: result.trades.filter((trade) => trade.exitReason === "target" && trade.breakEvenActivatedAt !== null && trade.breakEvenActivatedAt !== undefined).length,
      initialStops: result.trades.filter((trade) => trade.exitReason === "stop").length,
    },
    diagnostics: result.diagnostics,
  };
}

function summarizeTrades(trades: BacktestTrade[], key: (trade: BacktestTrade) => string) {
  const groups: Record<string, ReturnType<typeof emptySummary>> = {};
  for (const trade of trades) {
    const id = key(trade);
    groups[id] ??= emptySummary();
    const group = groups[id];
    group.trades += 1;
    group.wins += trade.netPnl > 0 ? 1 : 0;
    group.netPnl += trade.netPnl;
    group.grossProfit += trade.netPnl > 0 ? trade.netPnl : 0;
    group.grossLoss += trade.netPnl < 0 ? Math.abs(trade.netPnl) : 0;
    group.averageR += trade.rMultiple;
    group.fees += trade.fees;
  }
  for (const group of Object.values(groups)) {
    group.winRate = group.trades ? group.wins / group.trades : 0;
    group.profitFactor = group.grossLoss > 0 ? group.grossProfit / group.grossLoss : group.grossProfit > 0 ? null : 0;
    group.averageR = group.trades ? group.averageR / group.trades : 0;
  }
  return groups;
}

function emptySummary() {
  return {
    trades: 0,
    wins: 0,
    winRate: 0,
    netPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    profitFactor: 0 as number | null,
    averageR: 0,
    fees: 0,
  };
}

function compact(result: ReturnType<typeof compare>) {
  return {
    executionImproved: result.executionImproved,
    candidatePassed: result.candidatePassed,
    baseline: result.baseline.metrics,
    breakEven: result.breakEven.metrics,
    breakEvenDiagnostics: result.breakEven.breakEvenDiagnostics,
    delta: result.delta,
    yearly: result.breakEven.yearly,
    sides: result.breakEven.sides,
    failedChecks: Object.entries(result.candidateChecks).filter(([, passed]) => !passed).map(([key]) => key),
  };
}

function numericProfitFactor(value: number | null) {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function hashWithoutGeneratedAt(value: typeof report) {
  const clone = structuredClone(value);
  delete (clone as { generatedAt?: string }).generatedAt;
  return createHash("sha256").update(JSON.stringify(clone)).digest("hex");
}
