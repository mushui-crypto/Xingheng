import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../server/types";
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
import {
  EthOrderFlowStructureStrategy,
  type EthOrderFlowFamily,
  type EthOrderFlowStructureConfig,
} from "../server/modules/strategy/models/EthOrderFlowStructureStrategy";

const routeId = "eth-factor-route-v5-kline-orderflow-structure-2r-2026-07-17";
const outputPath = path.resolve("research-eth-factor-route-v5-kline-orderflow-structure-2r-2026-07-17.json");
const families: EthOrderFlowFamily[] = [
  "taker_imbalance_continuation",
  "absorption_reversal",
  "trade_intensity_breakout",
];
const thresholds = [0.75, 1.25, 1.75] as const;
const structureLookbacks = [6, 12] as const;
const baseBacktestConfig = {
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
const loaded = await source.loadMonths(monthRange("2021-01", "2023-12", "ETHUSDT"));
const candles = loaded.candles;
const missingBarCount = countMissingBars(candles);
const missingOrderFlowBars = candles.filter((candle) => !hasOrderFlow(candle)).length;
if (!loaded.quality.checksumVerified || missingBarCount !== 0 || missingOrderFlowBars !== 0) {
  throw new Error(`Formation data quality failed: checksum=${loaded.quality.checksumVerified} gaps=${missingBarCount} missingOrderFlow=${missingOrderFlowBars}`);
}

const configurations = buildConfigurations();
if (configurations.length !== 18) throw new Error(`Pre-registered grid must contain 18 configurations, received ${configurations.length}`);

const formationRuns: FormationRun[] = [];
for (let index = 0; index < configurations.length; index += 1) {
  const config = configurations[index];
  const strategy = new EthOrderFlowStructureStrategy(config);
  let result: BacktestResult;
  try {
    result = new BacktestEngine(strategy, baseBacktestConfig).run(candles);
  } finally {
    strategy.release();
  }
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
    exitReasons: summarizeTrades(result.trades, (trade) => trade.exitReason),
    medianYearProfitFactor,
    positiveYears,
    eligible,
  });
  if ((index + 1) % 6 === 0 || index + 1 === configurations.length) {
    console.log(`[formation] ${index + 1}/${configurations.length}`);
  }
}

const rankedEligible = formationRuns
  .filter((item) => item.eligible)
  .sort(compareRuns);
const selected = rankedEligible.slice(0, 5);
const diagnosticTop = [...formationRuns].sort(compareRuns).slice(0, 8);

const report = {
  routeId,
  generatedAt: new Date().toISOString(),
  status: selected.length > 0 ? "formation_candidate_found_pending_evaluation" : "rejected_formation_no_candidate",
  researchOnly: true,
  automaticOrdersEnabled: false,
  venue: "binance_usdm_ethusdt_perpetual",
  symbol: "ETHUSDT",
  signalInterval: "15m",
  executionInterval: "5m",
  preRegistration: {
    document: "STRATEGY_ETH_FACTOR_ROUTE_V5.md",
    formationPeriod: "2021-01-01..2023-12-31",
    evaluationDataOpened: false,
    configurationCount: configurations.length,
    families,
    thresholds,
    structureLookbackBars: structureLookbacks,
    entrySession: "Asia/Shanghai 18:00..08:00 weekdays",
    structureBufferAtr15m: 0.15,
    acceptedStopAtrRange: [0.5, 2],
    actualFillRewardRisk: 2,
    riskFraction: 0.0025,
  },
  dataQuality: {
    ...loaded.quality,
    missingBarCount,
    missingOrderFlowBars,
    orderFlowFields: ["quoteVolume", "tradeCount", "takerBuyBaseVolume", "takerBuyQuoteVolume"],
  },
  costs: {
    takerEntryFeeRate: baseBacktestConfig.takerEntryFeeRate,
    takerExitFeeRate: baseBacktestConfig.takerExitFeeRate,
    slippageBpsPerSide: baseBacktestConfig.slippageBps,
  },
  formationGate: {
    minimumTrades: 90,
    minimumProfitFactor: 1.15,
    minimumAverageR: 0.10,
    maximumDrawdownFraction: 0.15,
    minimumPositiveYears: 2,
  },
  search: {
    totalConfigurations: configurations.length,
    eligibleFormationConfigurations: rankedEligible.length,
    selectedForEvaluation: selected.map((item) => item.configId),
    formationRuns,
    diagnosticTop,
  },
  decision: {
    candidateFormed: selected.length > 0,
    nextAction: selected.length > 0
      ? "freeze_selected_configurations_and_open_pre_registered_evaluation"
      : "close_route_v5_without_opening_evaluation",
  },
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output: outputPath,
  deterministicHash: hashWithoutGeneratedAt(report),
  status: report.status,
  dataQuality: {
    candleCount: candles.length,
    missingBarCount,
    missingOrderFlowBars,
    firstCandleTime: candles[0]?.time ?? null,
    lastCandleTime: candles.at(-1)?.time ?? null,
  },
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
  decision: report.decision,
}, null, 2));

type FormationRun = {
  config: EthOrderFlowStructureConfig;
  configId: string;
  metrics: BacktestResult["metrics"];
  diagnostics: BacktestResult["diagnostics"];
  yearly: Record<string, TradeSummary>;
  sideMetrics: Record<string, TradeSummary>;
  exitReasons: Record<string, TradeSummary>;
  medianYearProfitFactor: number;
  positiveYears: number;
  eligible: boolean;
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
  const result: EthOrderFlowStructureConfig[] = [];
  for (const family of families) {
    for (const threshold of thresholds) {
      for (const structureLookbackBars of structureLookbacks) {
        result.push({
          symbol: "ETHUSDT",
          family,
          threshold,
          structureLookbackBars,
          riskFraction: 0.0025,
        });
      }
    }
  }
  return result;
}

function compareRuns(left: FormationRun, right: FormationRun) {
  return (
    Number(right.eligible) - Number(left.eligible) ||
    right.medianYearProfitFactor - left.medianYearProfitFactor ||
    numericProfitFactor(right.metrics.profitFactor) - numericProfitFactor(left.metrics.profitFactor) ||
    left.metrics.maxDrawdownFraction - right.metrics.maxDrawdownFraction ||
    left.configId.localeCompare(right.configId)
  );
}

function configId(config: EthOrderFlowStructureConfig) {
  return [
    config.family,
    `threshold-${config.threshold}`,
    `structure-${config.structureLookbackBars}x5m`,
    "buffer-0.15atr15m",
    "actual-fill-2r",
  ].join("__");
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

function countMissingBars(input: Array<{ time: number }>) {
  let missing = 0;
  for (let index = 1; index < input.length; index += 1) {
    const delta = input[index].time - input[index - 1].time;
    if (delta > 300) missing += Math.floor(delta / 300) - 1;
  }
  return missing;
}

function hasOrderFlow(candle: Candle) {
  return [candle.quoteVolume, candle.tradeCount, candle.takerBuyBaseVolume, candle.takerBuyQuoteVolume]
    .every((value) => Number.isFinite(value) && value! >= 0);
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
