import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
import {
  BacktestEngine,
  defaultBacktestConfig,
  type BacktestConfig,
  type BacktestResult,
  type BacktestTrade,
} from "../server/modules/strategy/backtest/BacktestEngine";
import {
  BinanceVisionHistoricalDataSource,
  dayRange,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  EthBtcCrossAssetFactorStrategy,
  type EthBtcCrossAssetFamily,
} from "../server/modules/strategy/models/EthBtcCrossAssetFactorStrategy";
import { EthFactorScoreStrategy, type EthFactorFamily } from "../server/modules/strategy/models/EthFactorScoreStrategy";
import { EthFifteenMinuteFactorStrategy } from "../server/modules/strategy/models/EthFifteenMinuteFactorStrategy";
import { FixedPointExecutionStrategy } from "../server/modules/strategy/models/FixedPointExecutionStrategy";

const routeId = "eth-factor-route-v4-user-fixed-40-stop-100-target-2026-07-16";
const through = "2026-07-13";
const output = path.resolve(`research-${routeId}.json`);
const ownFamilies: EthFactorFamily[] = ["trend_continuation", "channel_breakout", "atr_mean_reversion"];
const crossFamilies: EthBtcCrossAssetFamily[] = ["btc_lead_lag", "eth_relative_momentum", "cross_asset_residual_reversion"];
const thresholdsByArchitecture = {
  v1_5m: [1, 1.5, 2],
  v2_15m: [1, 1.5],
  v3_cross: [0.75, 1, 1.25],
} as const;

const baseBacktestConfig: BacktestConfig = {
  ...defaultBacktestConfig,
  takerEntryFeeRate: 0.00045,
  takerExitFeeRate: 0.00045,
  slippageBps: 1,
  maxLeverage: 3,
  sessionTimeZone: "UTC",
  sessionStartMinute: 0,
  sessionEndMinute: 0,
  closePositionAtSessionEnd: false,
  accountRiskControlsEnabled: false,
};

const ethSource = new BinanceVisionHistoricalDataSource();
const btcSource = new BinanceVisionHistoricalDataSource();
const [ethMonthly, ethDaily, btcMonthly, btcDaily] = await Promise.all([
  ethSource.loadMonths(monthRange("2021-01", "2026-06", "ETHUSDT")),
  ethSource.loadDays(dayRange("2026-07-01", through, "ETHUSDT")),
  btcSource.loadMonths(monthRange("2021-01", "2026-06", "BTCUSDT")),
  btcSource.loadDays(dayRange("2026-07-01", through, "BTCUSDT")),
]);
const ethCandles = deduplicate([...ethMonthly.candles, ...ethDaily.candles]);
const btcCandles = deduplicate([...btcMonthly.candles, ...btcDaily.candles]);
const ethMissingBarCount = countMissingBars(ethCandles);
const btcMissingBarCount = countMissingBars(btcCandles);
if (
  !ethMonthly.quality.checksumVerified || !ethDaily.quality.checksumVerified || ethMissingBarCount !== 0 ||
  !btcMonthly.quality.checksumVerified || !btcDaily.quality.checksumVerified || btcMissingBarCount !== 0
) {
  throw new Error(`Cross-asset data quality failed: ethGaps=${ethMissingBarCount} btcGaps=${btcMissingBarCount}`);
}

const ethDatasets = {
  formation: sliceUtcDays(ethCandles, "2021-01-01", "2023-12-31"),
  evaluation2024: sliceUtcDays(ethCandles, "2024-01-01", "2024-12-31"),
  evaluation2025: sliceUtcDays(ethCandles, "2025-01-01", "2025-12-31"),
  evaluation2024To2025: sliceUtcDays(ethCandles, "2024-01-01", "2025-12-31"),
  historical2026: sliceUtcDays(ethCandles, "2026-01-01", through),
  fullHistory: ethCandles,
};
const btcDatasets = {
  formation: sliceUtcDays(btcCandles, "2021-01-01", "2023-12-31"),
  evaluation2024: sliceUtcDays(btcCandles, "2024-01-01", "2024-12-31"),
  evaluation2025: sliceUtcDays(btcCandles, "2025-01-01", "2025-12-31"),
  evaluation2024To2025: sliceUtcDays(btcCandles, "2024-01-01", "2025-12-31"),
  historical2026: sliceUtcDays(btcCandles, "2026-01-01", through),
  fullHistory: btcCandles,
};
for (const [id, dataset] of Object.entries(ethDatasets)) {
  const gaps = countMissingBars(dataset);
  if (gaps !== 0) throw new Error(`ETH ${id} contains ${gaps} missing 5m bars`);
  const btcDataset = btcDatasets[id as keyof typeof btcDatasets];
  if (countMissingBars(btcDataset) !== 0 || btcDataset.length !== dataset.length) {
    throw new Error(`BTC/ETH ${id} alignment failed`);
  }
}

const configurations = buildConfigurations();
if (configurations.length !== 24) throw new Error(`Pre-registered grid must contain 24 configurations, received ${configurations.length}`);

const formationRuns: FormationRun[] = [];
for (let index = 0; index < configurations.length; index += 1) {
  const config = configurations[index];
  const result = runBacktest(ethDatasets.formation, btcDatasets.formation, config, baseBacktestConfig);
  const yearly = summarizeByEntryYear(result.trades, [2021, 2022, 2023]);
  const medianYearProfitFactor = median(Object.values(yearly).map((item) => numericProfitFactor(item.profitFactor)));
  const positiveYears = Object.values(yearly).filter((item) => item.netPnl > 0).length;
  const eligible = (
    result.metrics.tradeCount >= 90 &&
    numericProfitFactor(result.metrics.profitFactor) >= 1.15 &&
    result.metrics.averageR >= 0.10 &&
    result.metrics.maxDrawdownFraction <= 0.15 &&
    positiveYears >= 2
  );
  formationRuns.push({
    config,
    configId: configId(config),
    metrics: result.metrics,
    diagnostics: result.diagnostics,
    yearly,
    sideMetrics: summarizeTrades(result.trades, (trade) => trade.side),
    medianYearProfitFactor,
    positiveYears,
    eligible,
  });
  if ((index + 1) % 12 === 0 || index + 1 === configurations.length) {
    console.log(`[formation] ${index + 1}/${configurations.length}`);
  }
}

const rankedEligible = formationRuns
  .filter((item) => item.eligible)
  .sort((left, right) => (
    right.medianYearProfitFactor - left.medianYearProfitFactor ||
    numericProfitFactor(right.metrics.profitFactor) - numericProfitFactor(left.metrics.profitFactor) ||
    left.metrics.maxDrawdownFraction - right.metrics.maxDrawdownFraction ||
    left.configId.localeCompare(right.configId)
  ));
const selected = rankedEligible.slice(0, 5);
const diagnosticTop = [...formationRuns]
  .sort((left, right) => (
    Number(right.eligible) - Number(left.eligible) ||
    right.medianYearProfitFactor - left.medianYearProfitFactor ||
    numericProfitFactor(right.metrics.profitFactor) - numericProfitFactor(left.metrics.profitFactor) ||
    left.configId.localeCompare(right.configId)
  ))
  .slice(0, 5);

console.log(`[selection] eligible=${rankedEligible.length} selected=${selected.length}`);

const evaluationCache = new Map<string, BacktestResult>();
const evaluations: EvaluationRun[] = [];
for (const formation of selected) {
  const config = formation.config;
  const evaluation2024 = runBacktest(ethDatasets.evaluation2024, btcDatasets.evaluation2024, config, baseBacktestConfig);
  const evaluation2025 = runBacktest(ethDatasets.evaluation2025, btcDatasets.evaluation2025, config, baseBacktestConfig);
  const evaluationCombined = runBacktest(ethDatasets.evaluation2024To2025, btcDatasets.evaluation2024To2025, config, baseBacktestConfig);
  evaluationCache.set(configId(config), evaluationCombined);
  const historical2026 = runBacktest(ethDatasets.historical2026, btcDatasets.historical2026, config, baseBacktestConfig);
  const fullHistory = runBacktest(ethDatasets.fullHistory, btcDatasets.fullHistory, config, baseBacktestConfig);
  const doubledCost = runBacktest(ethDatasets.fullHistory, btcDatasets.fullHistory, config, {
    ...baseBacktestConfig,
    takerEntryFeeRate: 0.0009,
    takerExitFeeRate: 0.0009,
    slippageBps: 2,
  });
  evaluations.push({
    config,
    configId: formation.configId,
    formation,
    evaluation2024,
    evaluation2025,
    evaluationCombined,
    historical2026,
    fullHistory,
    doubledCost,
    fullHistoryYearly: summarizeByEntryYear(fullHistory.trades, [2021, 2022, 2023, 2024, 2025, 2026]),
    fullHistorySides: summarizeTrades(fullHistory.trades, (trade) => trade.side),
    fullHistoryExitReasons: summarizeTrades(fullHistory.trades, (trade) => trade.exitReason),
  });
  console.log(`[evaluation] ${formation.configId}`);
}

for (const evaluation of evaluations) {
  const neighborConfigs = configurations.filter((candidate) => areAdjacent(evaluation.config, candidate));
  const neighbors = [];
  for (const config of neighborConfigs) {
    const id = configId(config);
    const result = evaluationCache.get(id) ?? runBacktest(
      ethDatasets.evaluation2024To2025,
      btcDatasets.evaluation2024To2025,
      config,
      baseBacktestConfig,
    );
    evaluationCache.set(id, result);
    neighbors.push({
      configId: id,
      config,
      metrics: result.metrics,
      positiveAndProfitFactorAboveOne: result.metrics.netPnl > 0 && numericProfitFactor(result.metrics.profitFactor) > 1,
    });
  }
  evaluation.neighbors = neighbors;
  evaluation.assessment = assessCandidate(evaluation);
}

const passingCandidates = evaluations.filter((item) => item.assessment?.passed);
const report = {
  routeId,
  generatedAt: new Date().toISOString(),
  status: passingCandidates.length > 0 ? "candidate_found_pending_freeze_review" : "rejected_first_round_no_candidate",
  researchOnly: true,
  automaticOrdersEnabled: false,
  venue: "binance_usdm_ethusdt_perpetual",
  symbol: "ETHUSDT",
  interval: "5m",
  preRegistration: {
    document: "STRATEGY_ETH_FACTOR_ROUTE_V4.md",
    configurationCount: configurations.length,
    architectures: {
      v1_5m: { families: ownFamilies, thresholds: thresholdsByArchitecture.v1_5m },
      v2_15m: { families: ownFamilies, thresholds: thresholdsByArchitecture.v2_15m },
      v3_cross: { families: crossFamilies, thresholds: thresholdsByArchitecture.v3_cross },
    },
    stopPoints: 40,
    targetPoints: 100,
    maximumHoldingBars: null,
    entrySession: "Asia/Shanghai 18:00..08:00 weekdays",
    selectionPeriod: "2021-01-01..2023-12-31",
    evaluationPeriod: "2024-01-01..2025-12-31",
    historicalRecalculation: "2026-01-01..2026-07-13",
  },
  dataQuality: {
    source: "binance_vision_usdm",
    officialChecksumVerified: true,
    alignedCandleCount: ethCandles.length,
    eth: {
      candleCount: ethCandles.length,
      missingBarCount: ethMissingBarCount,
      firstCandleTime: ethCandles[0]?.time ?? null,
      lastCandleTime: ethCandles.at(-1)?.time ?? null,
      monthly: ethMonthly.quality,
      daily: ethDaily.quality,
    },
    btc: {
      candleCount: btcCandles.length,
      missingBarCount: btcMissingBarCount,
      firstCandleTime: btcCandles[0]?.time ?? null,
      lastCandleTime: btcCandles.at(-1)?.time ?? null,
      monthly: btcMonthly.quality,
      daily: btcDaily.quality,
    },
  },
  costs: {
    takerEntryFeeRate: baseBacktestConfig.takerEntryFeeRate,
    takerExitFeeRate: baseBacktestConfig.takerExitFeeRate,
    slippageBpsPerSide: baseBacktestConfig.slippageBps,
    doubledCost: { takerEntryFeeRate: 0.0009, takerExitFeeRate: 0.0009, slippageBpsPerSide: 2 },
  },
  search: {
    totalConfigurations: configurations.length,
    eligibleFormationConfigurations: rankedEligible.length,
    selectedForEvaluation: selected.map((item) => item.configId),
    formationRuns,
    diagnosticTop,
  },
  evaluations,
  passingCandidates: passingCandidates.map((item) => item.configId),
  decision: {
    candidateFormed: passingCandidates.length > 0,
    selectedConfigId: passingCandidates[0]?.configId ?? null,
    nextAction: passingCandidates.length > 0
      ? "independent_review_then_freeze_before_forward_paper"
      : "close_route_v4_and_require_new_information_before_any_new_search",
  },
};

await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const deterministicHash = hashWithoutGeneratedAt(report);
console.log(JSON.stringify({
  output,
  deterministicHash,
  status: report.status,
  dataQuality: report.dataQuality,
  selection: {
    eligible: rankedEligible.length,
    selected: selected.map((item) => item.configId),
    diagnosticTop: diagnosticTop.map((item) => ({
      configId: item.configId,
      eligible: item.eligible,
      metrics: item.metrics,
      medianYearProfitFactor: item.medianYearProfitFactor,
      positiveYears: item.positiveYears,
    })),
  },
  evaluations: evaluations.map((item) => ({
    configId: item.configId,
    assessment: item.assessment,
    evaluation2024: item.evaluation2024.metrics,
    evaluation2025: item.evaluation2025.metrics,
    evaluationCombined: item.evaluationCombined.metrics,
    historical2026: item.historical2026.metrics,
    fullHistory: item.fullHistory.metrics,
    doubledCost: item.doubledCost.metrics,
    sides: item.fullHistorySides,
  })),
  decision: report.decision,
}, null, 2));

type FixedSignalConfig = {
  architecture: "v1_5m" | "v2_15m" | "v3_cross";
  family: EthFactorFamily | EthBtcCrossAssetFamily;
  threshold: number;
};

type FormationRun = {
  config: FixedSignalConfig;
  configId: string;
  metrics: BacktestResult["metrics"];
  diagnostics: BacktestResult["diagnostics"];
  yearly: Record<string, TradeSummary>;
  sideMetrics: Record<string, TradeSummary>;
  medianYearProfitFactor: number;
  positiveYears: number;
  eligible: boolean;
};

type EvaluationRun = {
  config: FixedSignalConfig;
  configId: string;
  formation: FormationRun;
  evaluation2024: BacktestResult;
  evaluation2025: BacktestResult;
  evaluationCombined: BacktestResult;
  historical2026: BacktestResult;
  fullHistory: BacktestResult;
  doubledCost: BacktestResult;
  fullHistoryYearly: Record<string, TradeSummary>;
  fullHistorySides: Record<string, TradeSummary>;
  fullHistoryExitReasons: Record<string, TradeSummary>;
  neighbors?: Array<{
    configId: string;
    config: FixedSignalConfig;
    metrics: BacktestResult["metrics"];
    positiveAndProfitFactorAboveOne: boolean;
  }>;
  assessment?: ReturnType<typeof assessCandidate>;
};

type TradeSummary = {
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  averageR: number;
  fees: number;
};

function buildConfigurations() {
  const result: FixedSignalConfig[] = [];
  for (const family of ownFamilies) {
    for (const threshold of thresholdsByArchitecture.v1_5m) result.push({ architecture: "v1_5m", family, threshold });
    for (const threshold of thresholdsByArchitecture.v2_15m) result.push({ architecture: "v2_15m", family, threshold });
  }
  for (const family of crossFamilies) {
    for (const threshold of thresholdsByArchitecture.v3_cross) result.push({ architecture: "v3_cross", family, threshold });
  }
  return result;
}

function runBacktest(
  ethCandles: Candle[],
  btcCandles: Candle[],
  config: FixedSignalConfig,
  backtestConfig: BacktestConfig,
) {
  const base = config.architecture === "v1_5m"
    ? new EthFactorScoreStrategy({
      symbol: "ETHUSDT",
      family: config.family as EthFactorFamily,
      threshold: config.threshold as 1 | 1.5 | 2,
      stopAtr: 1.5,
      rewardRisk: 2,
      session: "beijing_non_asia",
      riskFraction: 0.0025,
      maximumHoldingBars: 24,
    })
    : config.architecture === "v2_15m"
      ? new EthFifteenMinuteFactorStrategy({
        symbol: "ETHUSDT",
        family: config.family as EthFactorFamily,
        threshold: config.threshold as 1 | 1.5,
        stopAtr: 0.75,
        rewardRisk: 2,
        session: "beijing_non_asia",
        riskFraction: 0.0025,
        maximumHoldingBars: 36,
      })
      : new EthBtcCrossAssetFactorStrategy({
        symbol: "ETHUSDT",
        family: config.family as EthBtcCrossAssetFamily,
        threshold: config.threshold as 0.75 | 1 | 1.25,
        stopAtr: 0.75,
        rewardRisk: 2,
        session: "beijing_non_asia",
        riskFraction: 0.0025,
        maximumHoldingBars: 36,
        cooldownFactorBars: 8,
      }, btcCandles);
  const strategy = new FixedPointExecutionStrategy(base, {
    stopPoints: 40,
    targetPoints: 100,
    sessionTimeZone: "Asia/Shanghai",
    sessionStartMinute: 18 * 60,
    sessionEndMinute: 8 * 60,
    excludeWeekends: true,
  });
  try {
    return new BacktestEngine(strategy, backtestConfig).run(ethCandles);
  } finally {
    strategy.release();
  }
}

function assessCandidate(run: EvaluationRun) {
  const year2024 = run.evaluation2024.metrics;
  const year2025 = run.evaluation2025.metrics;
  const evaluation = run.evaluationCombined.metrics;
  const historical2026 = run.historical2026.metrics;
  const full = run.fullHistory.metrics;
  const stress = run.doubledCost.metrics;
  const neighborPasses = run.neighbors?.filter((item) => item.positiveAndProfitFactorAboveOne).length ?? 0;
  const yearly = Object.values(run.fullHistoryYearly);
  const positiveYearPnl = yearly.filter((item) => item.netPnl > 0).map((item) => item.netPnl);
  const positivePnlTotal = positiveYearPnl.reduce((sum, value) => sum + value, 0);
  const largestPositiveYearContribution = positivePnlTotal > 0 ? Math.max(0, ...positiveYearPnl) / positivePnlTotal : 1;
  const elapsedYears = (Date.parse("2026-07-15T00:00:00Z") - Date.parse("2021-01-01T00:00:00Z")) / (365.25 * 86_400_000);
  const checks = {
    formationEligible: run.formation.eligible,
    positive2024: year2024.netPnl > 0,
    profitFactor2024AtLeast105: numericProfitFactor(year2024.profitFactor) >= 1.05,
    positive2025: year2025.netPnl > 0,
    profitFactor2025AtLeast105: numericProfitFactor(year2025.profitFactor) >= 1.05,
    evaluationProfitFactorAtLeast120: numericProfitFactor(evaluation.profitFactor) >= 1.20,
    evaluationAverageRAtLeast010: evaluation.averageR >= 0.10,
    evaluationTradesAtLeast60: evaluation.tradeCount >= 60,
    positiveHistorical2026: historical2026.netPnl > 0,
    historical2026ProfitFactorAboveOne: numericProfitFactor(historical2026.profitFactor) > 1,
    historical2026AverageRPositive: historical2026.averageR > 0,
    fullHistoryTradesAtLeast200: full.tradeCount >= 200,
    annualizedTradesAtLeast30: full.tradeCount / elapsedYears >= 30,
    fullHistoryDrawdownAtMost10Pct: full.maxDrawdownFraction <= 0.10,
    doubledCostProfitFactorAtLeastOne: numericProfitFactor(stress.profitFactor) >= 1,
    atLeastTwoPositiveNeighbors: neighborPasses >= 2,
    noSinglePositiveYearAbove50Pct: largestPositiveYearContribution <= 0.50,
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([id]) => id);
  return {
    checks,
    passed: failedChecks.length === 0,
    failedChecks,
    neighborPasses,
    largestPositiveYearContribution,
  };
}

function summarizeByEntryYear(trades: BacktestTrade[], years: number[]) {
  const groups = summarizeTrades(trades, (trade) => String(new Date(trade.entryTime * 1000).getUTCFullYear()));
  return Object.fromEntries(years.map((year) => [String(year), groups[String(year)] ?? emptySummary()]));
}

function summarizeTrades(trades: BacktestTrade[], key: (trade: BacktestTrade) => string) {
  const groups: Record<string, TradeSummary> = {};
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

function emptySummary(): TradeSummary {
  return { trades: 0, wins: 0, winRate: 0, netPnl: 0, grossProfit: 0, grossLoss: 0, profitFactor: 0, averageR: 0, fees: 0 };
}

function areAdjacent(left: FixedSignalConfig, right: FixedSignalConfig) {
  if (left.architecture !== right.architecture || left.family !== right.family || configId(left) === configId(right)) return false;
  const grid = thresholdsByArchitecture[left.architecture] as readonly number[];
  return Math.abs(grid.indexOf(left.threshold) - grid.indexOf(right.threshold)) === 1;
}

function configId(config: FixedSignalConfig) {
  return [config.architecture, config.family, `threshold-${config.threshold}`, "fixed-40-100", "beijing-non-asia-weekday"].join("__");
}

function deduplicate(input: Candle[]) {
  return [...new Map(input.map((candle) => [candle.time, candle])).values()]
    .sort((left, right) => left.time - right.time);
}

function sliceUtcDays(input: Candle[], from: string, through: string) {
  const start = Date.parse(`${from}T00:00:00Z`) / 1000;
  const endExclusive = Date.parse(`${through}T00:00:00Z`) / 1000 + 86_400;
  return input.filter((candle) => candle.time >= start && candle.time < endExclusive);
}

function countMissingBars(input: Array<{ time: number }>) {
  let missing = 0;
  for (let index = 1; index < input.length; index += 1) {
    const delta = input[index].time - input[index - 1].time;
    if (delta > 300) missing += Math.floor(delta / 300) - 1;
  }
  return missing;
}

function numericProfitFactor(value: number | null) {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function hashWithoutGeneratedAt(value: typeof report) {
  const clone = structuredClone(value);
  delete (clone as { generatedAt?: string }).generatedAt;
  return createHash("sha256").update(JSON.stringify(clone)).digest("hex");
}
