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
  EthFifteenMinuteFactorStrategy,
  type EthFifteenMinuteFactorConfig,
} from "../server/modules/strategy/models/EthFifteenMinuteFactorStrategy";
import type { EthFactorFamily, EthFactorSession } from "../server/modules/strategy/models/EthFactorScoreStrategy";

const routeId = "eth-factor-route-v2-15m-signal-5m-execution-2026-07-16";
const through = "2026-07-14";
const output = path.resolve(`research-${routeId}.json`);
const families: EthFactorFamily[] = ["trend_continuation", "channel_breakout", "atr_mean_reversion"];
const thresholds = [1, 1.5] as const;
const stopAtrs = [0.75, 1] as const;
const rewardRisks = [1.5, 2, 2.5] as const;
const sessions: EthFactorSession[] = ["all", "beijing_non_asia"];

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

const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange("2021-01", "2026-06", "ETHUSDT")),
  source.loadDays(dayRange("2026-07-01", through, "ETHUSDT")),
]);
const candles = deduplicate([...monthly.candles, ...daily.candles]);
const missingBarCount = countMissingBars(candles);
if (!monthly.quality.checksumVerified || !daily.quality.checksumVerified || missingBarCount !== 0) {
  throw new Error(`ETH factor data quality failed: checksum=${monthly.quality.checksumVerified && daily.quality.checksumVerified} gaps=${missingBarCount}`);
}

const datasets = {
  formation: sliceUtcDays(candles, "2021-01-01", "2023-12-31"),
  evaluation2024: sliceUtcDays(candles, "2024-01-01", "2024-12-31"),
  evaluation2025: sliceUtcDays(candles, "2025-01-01", "2025-12-31"),
  evaluation2024To2025: sliceUtcDays(candles, "2024-01-01", "2025-12-31"),
  historical2026: sliceUtcDays(candles, "2026-01-01", through),
  fullHistory: candles,
};
for (const [id, dataset] of Object.entries(datasets)) {
  const gaps = countMissingBars(dataset);
  if (gaps !== 0) throw new Error(`${id} contains ${gaps} missing 5m bars`);
}

const configurations = buildConfigurations();
if (configurations.length !== 72) throw new Error(`Pre-registered grid must contain 72 configurations, received ${configurations.length}`);

const formationRuns: FormationRun[] = [];
for (let index = 0; index < configurations.length; index += 1) {
  const config = configurations[index];
  const result = runBacktest(datasets.formation, config, baseBacktestConfig);
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
  const evaluation2024 = runBacktest(datasets.evaluation2024, config, baseBacktestConfig);
  const evaluation2025 = runBacktest(datasets.evaluation2025, config, baseBacktestConfig);
  const evaluationCombined = runBacktest(datasets.evaluation2024To2025, config, baseBacktestConfig);
  evaluationCache.set(configId(config), evaluationCombined);
  const historical2026 = runBacktest(datasets.historical2026, config, baseBacktestConfig);
  const fullHistory = runBacktest(datasets.fullHistory, config, baseBacktestConfig);
  const doubledCost = runBacktest(datasets.fullHistory, config, {
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
    const result = evaluationCache.get(id) ?? runBacktest(datasets.evaluation2024To2025, config, baseBacktestConfig);
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
    document: "STRATEGY_ETH_FACTOR_ROUTE_V2.md",
    configurationCount: configurations.length,
    families,
    thresholds,
    stopAtrs,
    rewardRisks,
    sessions,
    maximumHoldingBars: 36,
    selectionPeriod: "2021-01-01..2023-12-31",
    evaluationPeriod: "2024-01-01..2025-12-31",
    historicalRecalculation: "2026-01-01..2026-07-14",
  },
  dataQuality: {
    source: "binance_vision_usdm",
    officialChecksumVerified: true,
    candleCount: candles.length,
    missingBarCount,
    firstCandleTime: candles[0]?.time ?? null,
    lastCandleTime: candles.at(-1)?.time ?? null,
    monthly: monthly.quality,
    daily: daily.quality,
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
      : "close_route_v2_and_preregister_a_new_route_before_any_new_search",
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

type FormationRun = {
  config: EthFifteenMinuteFactorConfig;
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
  config: EthFifteenMinuteFactorConfig;
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
    config: EthFifteenMinuteFactorConfig;
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
  const result: EthFifteenMinuteFactorConfig[] = [];
  for (const family of families) {
    for (const threshold of thresholds) {
      for (const stopAtr of stopAtrs) {
        for (const rewardRisk of rewardRisks) {
          for (const session of sessions) {
            result.push({
              symbol: "ETHUSDT",
              family,
              threshold,
              stopAtr,
              rewardRisk,
              session,
              riskFraction: 0.0025,
              maximumHoldingBars: 36,
            });
          }
        }
      }
    }
  }
  return result;
}

function runBacktest(candles: Candle[], config: EthFifteenMinuteFactorConfig, backtestConfig: BacktestConfig) {
  const strategy = new EthFifteenMinuteFactorStrategy(config);
  try {
    return new BacktestEngine(strategy, backtestConfig).run(candles);
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

function areAdjacent(left: EthFifteenMinuteFactorConfig, right: EthFifteenMinuteFactorConfig) {
  if (left.family !== right.family || left.session !== right.session || configId(left) === configId(right)) return false;
  const differences = [
    gridDistance(thresholds, left.threshold, right.threshold),
    gridDistance(stopAtrs, left.stopAtr, right.stopAtr),
    gridDistance(rewardRisks, left.rewardRisk, right.rewardRisk),
  ];
  return differences.filter((distance) => distance > 0).length === 1 && differences.some((distance) => distance === 1);
}

function gridDistance<T extends number>(grid: readonly T[], left: T, right: T) {
  return Math.abs(grid.indexOf(left) - grid.indexOf(right));
}

function configId(config: EthFifteenMinuteFactorConfig) {
  return [config.family, `threshold-${config.threshold}`, `stop-${config.stopAtr}`, `rr-${config.rewardRisk}`, config.session].join("__");
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
