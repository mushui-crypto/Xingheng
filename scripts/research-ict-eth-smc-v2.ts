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
  dayRange,
  monthRange,
} from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  EthLiquiditySweepFibFvgObStrategy,
  ethLiquiditySweepFibFvgObV2AConfig,
  ethLiquiditySweepFibFvgObV2BConfig,
  type EthLiquiditySweepFibFvgObConfig,
} from "../server/modules/strategy/models/EthLiquiditySweepFibFvgObStrategy";

const symbol = "ETHUSDT" as const;
const monthlyStart = process.argv[2] ?? "2024-01";
const monthlyEnd = process.argv[3] ?? "2026-06";
const dailyEnd = process.argv[4] ?? "2026-07-14";
const dailyStart = firstDayAfterMonth(monthlyEnd);
const marginFractions = [0.02, 0.03, 0.04, 0.05] as const;
const routes = [
  ethLiquiditySweepFibFvgObV2AConfig,
  ethLiquiditySweepFibFvgObV2BConfig,
] as const;

if (Date.parse(`${dailyEnd}T00:00:00Z`) < Date.parse(`${dailyStart}T00:00:00Z`)) {
  throw new Error(`Daily end ${dailyEnd} must be on or after ${dailyStart}.`);
}

const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange(monthlyStart, monthlyEnd, symbol)),
  source.loadDays(dayRange(dailyStart, dailyEnd, symbol)),
]);
const candles = deduplicateCandles([...monthly.candles, ...daily.candles]);
const combinedMissingBarCount = countMissingBars(candles);
if (monthly.quality.missingBarCount > 0 || daily.quality.missingBarCount > 0 || combinedMissingBarCount > 0) {
  throw new Error([
    "ETHUSDT V2 research data is incomplete.",
    `monthly gaps=${monthly.quality.missingBarCount}`,
    `daily gaps=${daily.quality.missingBarCount}`,
    `combined gaps=${combinedMissingBarCount}`,
  ].join(" "));
}

const segmentDefinitions = [
  {
    id: "calendar_2024",
    from: "2024-01-01",
    through: "2024-12-31",
    datasetRole: "preregistered_rule_evaluation_seen_history",
  },
  {
    id: "calendar_2025",
    from: "2025-01-01",
    through: "2025-12-31",
    datasetRole: "preregistered_rule_evaluation_seen_history",
  },
  {
    id: "calendar_2026_through_latest_available_day",
    from: "2026-01-01",
    through: dailyEnd,
    datasetRole: "preregistered_rule_historical_recalculation_seen_history",
  },
  {
    id: "continuous_2024_through_latest_available_day",
    from: "2024-01-01",
    through: dailyEnd,
    datasetRole: "preregistered_rule_continuous_diagnostic_not_a_holdout",
  },
] as const;

const preparedSegments = Object.fromEntries(segmentDefinitions.map((definition) => {
  const segmentCandles = sliceUtcDays(candles, definition.from, definition.through);
  if (segmentCandles.length === 0) throw new Error(`Segment ${definition.id} contains no candles.`);
  const missingBarCount = countMissingBars(segmentCandles);
  if (missingBarCount > 0) throw new Error(`Segment ${definition.id} contains ${missingBarCount} missing 5m bars.`);
  return [definition.id, {
    ...definition,
    candles: segmentCandles,
    quality: {
      candleCount: segmentCandles.length,
      missingBarCount,
      firstCandleTime: segmentCandles[0]?.time ?? null,
      lastCandleTime: segmentCandles.at(-1)?.time ?? null,
    },
  }];
})) as Record<(typeof segmentDefinitions)[number]["id"], {
  id: string;
  from: string;
  through: string;
  datasetRole: string;
  candles: Candle[];
  quality: {
    candleCount: number;
    missingBarCount: number;
    firstCandleTime: number | null;
    lastCandleTime: number | null;
  };
}>;

const candidates: Record<string, ReturnType<typeof runCandidate>> = {};
for (const route of routes) {
  for (const marginFraction of marginFractions) {
    const candidateKey = `${route.routeId}__margin_${Math.round(marginFraction * 100)}pct`;
    console.error(`Running ${candidateKey}...`);
    candidates[candidateKey] = runCandidate(route, marginFraction);
  }
}

const report = {
  study: "ETHUSDT SMC/ICT liquidity-sweep Fibonacci-FVG-order-block V2 preregistered baseline",
  generatedAt: new Date().toISOString(),
  frozenRuleDocument: "docs/strategy/archive/STRATEGY_ETH_SMC_ICT_V2.md",
  candidateVersion: "smc-ict-liquidity-sweep-fib-fvg-ob-v2",
  routes: routes.map((route) => ({ routeId: route.routeId, exitMode: route.exitMode })),
  symbol,
  venue: "binance_usdm_ethusdt_perpetual",
  source: "binance_vision_usdm",
  sourceUrl: "https://data.binance.vision/data/futures/um",
  researchOnly: true,
  automaticOrdersEnabled: false,
  executionScope: "historical_research_only_no_binance_trading_api",
  parameterSelection: "user_constraints_and_rule_translation_preregistered_before_first_v2_run",
  datasetRole: "preregistered_rule_evaluation_non_clean_seen_history",
  cleanHoldoutAvailable: false,
  fundingIncluded: false,
  assumptions: {
    initialEquityUsdt: 10_000,
    exchangeLeverageSetting: 100,
    positionSizing: "fixed initial margin fraction multiplied by 100x exchange leverage",
    marginFractions,
    approximateInitialNotionalToEquity: marginFractions.map((fraction) => fraction * 100),
    marginMode: "cross",
    concurrentEthPositions: 1,
    otherCrossPositionsAssumed: 0,
    entryFeeRate: 0.00045,
    exitFeeRate: 0.00045,
    slippageBpsPerFill: 1,
    liquidationMaintenanceMarginRate: 0.005,
    liquidationFeeRate: 0.0125,
    maintenanceMarginRateStatus: "explicit research simplification; not the account-specific Binance leverage bracket",
    quantityModel: "continuous ETH quantity; no 0.001 ETH step-size rounding in this baseline",
    pointStop: "structural stop expanded to 20 points when closer; 20-40 retained; signals above 40 rejected",
  },
  limitations: [
    "The 2024-01-01 through 2026-07-14 history is not a clean holdout because earlier ETH/BTC strategy research already touched it.",
    "Funding payments are excluded.",
    "The 0.50% maintenance margin rate is a research simplification and must be replaced by the account-specific ETHUSDT leverage bracket before forward or execution review.",
    "ETH quantity remains continuous in this baseline; Binance 0.001 ETH step size, 0.01 price tick and minimum notional must be applied in an execution adapter.",
    "Partial TP proceeds affect the simulated equity curve only after the entire position closes; leg-level fees and PnL are still recorded.",
    "Five-minute OHLC cannot reveal intrabar path, so liquidation and stop are evaluated before targets; after TP1, a same-bar break-even touch closes the remainder conservatively.",
    "Cross-margin liquidation assumes no other positions or orders consume wallet collateral.",
    "A 100x exchange leverage setting with 2%-5% initial margin creates approximately 2x-5x account notional exposure, not 100x whole-account exposure.",
  ],
  requestedRange: {
    monthlyStart,
    monthlyEnd,
    dailyStart,
    dailyEnd,
  },
  quality: {
    checksumPolicy: "official_sha256_verified_before_using_parsed_cache",
    checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
    monthly: monthly.quality,
    daily: daily.quality,
    combined: {
      market: symbol,
      interval: "5m",
      candleCount: candles.length,
      duplicateCount: monthly.candles.length + daily.candles.length - candles.length
        + monthly.quality.duplicateCount + daily.quality.duplicateCount,
      missingBarCount: combinedMissingBarCount,
      firstCandleTime: candles[0]?.time ?? null,
      lastCandleTime: candles.at(-1)?.time ?? null,
    },
  },
  candidates,
  baselineAssessment: {
    rule: "For a candidate to pass, continuous and every calendar segment must each have positive net PnL, profit factor above 1, and positive average R.",
    candidateCount: Object.keys(candidates).length,
    passedCandidateKeys: Object.entries(candidates).filter(([, value]) => value.assessment.baselinePassed).map(([key]) => key),
    status: Object.values(candidates).some((value) => value.assessment.baselinePassed)
      ? "one_or_more_candidates_passed_requires_new_clean_forward_sample"
      : "all_candidates_rejected_no_same_route_tuning",
    shadowEligible: false,
    automaticExecutionEligible: false,
  },
};

const output = path.resolve(`research-ict-eth-smc-v2-baseline-through-${dailyEnd}.json`);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output,
  through: dailyEnd,
  quality: report.quality.combined,
  baselineAssessment: report.baselineAssessment,
  candidates: Object.fromEntries(Object.entries(candidates).map(([key, candidate]) => [key, {
    routeId: candidate.routeId,
    marginFraction: candidate.marginFraction,
    assessment: candidate.assessment,
    continuousMetrics: candidate.segments.continuous_2024_through_latest_available_day.result.metrics,
    executionSummary: candidate.segments.continuous_2024_through_latest_available_day.executionSummary,
  }])),
}, null, 2));

function runCandidate(strategyConfig: EthLiquiditySweepFibFvgObConfig, marginFraction: number) {
  const backtestConfig = {
    ...defaultBacktestConfig,
    initialEquity: 10_000,
    makerEntryFeeRate: 0.00045,
    takerEntryFeeRate: 0.00045,
    takerExitFeeRate: 0.00045,
    slippageBps: 1,
    maxLeverage: 100,
    minNetRewardRisk: 1.2,
    sessionTimeZone: "America/New_York",
    sessionStartMinute: 7 * 60,
    sessionEndMinute: 10 * 60,
    closePositionAtSessionEnd: false,
    accountRiskControlsEnabled: false,
    stopExecutionMode: "hard" as const,
    positionSizingMode: "fixed_margin_fraction" as const,
    positionMarginFraction: marginFraction,
    positionLeverage: 100,
    positionMarginMode: "cross" as const,
    liquidationMaintenanceMarginRate: 0.005,
    liquidationFeeRate: 0.0125,
  };
  const segments = Object.fromEntries(segmentDefinitions.map((definition) => {
    const prepared = preparedSegments[definition.id];
    return [definition.id, {
      id: prepared.id,
      from: prepared.from,
      through: prepared.through,
      datasetRole: prepared.datasetRole,
      quality: prepared.quality,
      ...runBacktest(prepared.candles, strategyConfig, backtestConfig),
    }];
  })) as Record<(typeof segmentDefinitions)[number]["id"], ReturnType<typeof runBacktest> & {
    id: string;
    from: string;
    through: string;
    datasetRole: string;
    quality: typeof preparedSegments[(typeof segmentDefinitions)[number]["id"]]["quality"];
  }>;

  const annualIds = ["calendar_2024", "calendar_2025", "calendar_2026_through_latest_available_day"] as const;
  const annual = Object.fromEntries(annualIds.map((id) => [id, assessPositiveExpectancy(segments[id].result)]));
  const continuous = assessPositiveExpectancy(segments.continuous_2024_through_latest_available_day.result);
  const baselinePassed = continuous.passed && annualIds.every((id) => annual[id].passed);
  return {
    routeId: strategyConfig.routeId,
    exitMode: strategyConfig.exitMode,
    marginFraction,
    exchangeLeverageSetting: 100,
    approximateInitialNotionalToEquity: marginFraction * 100,
    marginMode: "cross" as const,
    strategyConfig,
    backtestConfig,
    segments,
    assessment: {
      annual,
      continuous,
      baselinePassed,
      status: baselinePassed
        ? "baseline_passed_requires_new_clean_forward_sample"
        : "baseline_rejected_no_same_route_tuning",
      shadowEligible: false,
      automaticExecutionEligible: false,
    },
  };
}

function runBacktest(
  segmentCandles: Candle[],
  strategyConfig: EthLiquiditySweepFibFvgObConfig,
  backtestConfig: typeof defaultBacktestConfig & Record<string, unknown>,
) {
  const strategy = new EthLiquiditySweepFibFvgObStrategy(strategyConfig);
  try {
    const result = new BacktestEngine(strategy, backtestConfig).run(segmentCandles);
    return {
      result,
      sideMetrics: summarizeTrades(result.trades, (trade) => trade.side),
      regimeMetrics: summarizeTrades(result.trades, (trade) => trade.regimeKey),
      exitMetrics: summarizeTrades(result.trades, (trade) => trade.exitReason),
      entryMonthMetrics: summarizeTrades(result.trades, (trade) => new Date(trade.entryTime * 1000).toISOString().slice(0, 7)),
      executionSummary: summarizeExecution(result.trades),
    };
  } finally {
    strategy.release();
  }
}

function assessPositiveExpectancy(result: BacktestResult) {
  const checks = {
    netPnlPositive: result.metrics.netPnl > 0,
    profitFactorAboveOne: result.metrics.profitFactor !== null && result.metrics.profitFactor > 1,
    averageRPositive: result.metrics.averageR > 0,
  };
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

function summarizeTrades(
  trades: BacktestTrade[],
  key: (trade: BacktestTrade) => string,
) {
  const groups: Record<string, {
    trades: number;
    wins: number;
    winRate: number;
    grossPnl: number;
    netPnl: number;
    averageR: number;
    fees: number;
  }> = {};
  for (const trade of trades) {
    const groupKey = key(trade);
    groups[groupKey] ??= { trades: 0, wins: 0, winRate: 0, grossPnl: 0, netPnl: 0, averageR: 0, fees: 0 };
    const group = groups[groupKey];
    group.trades += 1;
    group.wins += trade.netPnl > 0 ? 1 : 0;
    group.grossPnl += trade.grossPnl;
    group.netPnl += trade.netPnl;
    group.averageR += trade.rMultiple;
    group.fees += trade.fees;
  }
  for (const group of Object.values(groups)) {
    group.winRate = group.trades ? group.wins / group.trades : 0;
    group.averageR = group.trades ? group.averageR / group.trades : 0;
  }
  return groups;
}

function summarizeExecution(trades: BacktestTrade[]) {
  let tp1HitTrades = 0;
  let tp1ThenBreakEvenTrades = 0;
  let tp2CompletedTrades = 0;
  let liquidations = 0;
  let longestHoldingSeconds = 0;
  let maximumEntryNotional = 0;
  let maximumAllocatedMargin = 0;
  for (const trade of trades) {
    const legs = trade.exitLegs ?? [];
    const tp1 = legs.some((leg) => leg.label === "tp1_1r" && leg.reason === "partial_target");
    const tp2 = legs.some((leg) => leg.label === "tp2_2_5r" && leg.reason === "target");
    const breakEvenAfterTp1 = tp1 && legs.some((leg, index) => index > 0 && leg.reason === "stop");
    tp1HitTrades += tp1 ? 1 : 0;
    tp1ThenBreakEvenTrades += breakEvenAfterTp1 ? 1 : 0;
    tp2CompletedTrades += tp2 ? 1 : 0;
    liquidations += trade.exitReason === "liquidation" ? 1 : 0;
    longestHoldingSeconds = Math.max(longestHoldingSeconds, trade.exitTime - trade.entryTime);
    maximumEntryNotional = Math.max(maximumEntryNotional, trade.entryPrice * trade.quantity);
    maximumAllocatedMargin = Math.max(maximumAllocatedMargin, trade.allocatedMargin ?? 0);
  }
  return {
    liquidations,
    tp1HitTrades,
    tp1ThenBreakEvenTrades,
    tp2CompletedTrades,
    longestHoldingSeconds,
    longestHoldingHours: longestHoldingSeconds / 3600,
    maximumEntryNotional,
    maximumAllocatedMargin,
  };
}


function deduplicateCandles(input: Candle[]) {
  return [...new Map(input.map((candle) => [candle.time, candle])).values()]
    .sort((left, right) => left.time - right.time);
}

function sliceUtcDays(input: Candle[], from: string, through: string) {
  const start = parseUtcDay(from);
  const endExclusive = parseUtcDay(through) + 24 * 60 * 60;
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

function firstDayAfterMonth(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid month ${value}; expected YYYY-MM.`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
  return date.toISOString().slice(0, 10);
}

function parseUtcDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid UTC day ${value}.`);
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid UTC day ${value}.`);
  }
  return milliseconds / 1000;
}
