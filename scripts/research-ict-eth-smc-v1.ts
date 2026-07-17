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
  EthSmcIctConfluenceStrategy,
  ethSmcIctConfluenceV1Config,
} from "../server/modules/strategy/models/EthSmcIctConfluenceStrategy";

const symbol = "ETHUSDT" as const;
const routeId = ethSmcIctConfluenceV1Config.routeId;
const monthlyStart = process.argv[2] ?? "2024-01";
const monthlyEnd = process.argv[3] ?? "2026-06";
const dailyEnd = process.argv[4] ?? "2026-07-14";
const dailyStart = firstDayAfterMonth(monthlyEnd);

if (Date.parse(`${dailyEnd}T00:00:00Z`) < Date.parse(`${dailyStart}T00:00:00Z`)) {
  throw new Error(`Daily end ${dailyEnd} must be on or after ${dailyStart}.`);
}

const strategyConfig = {
  ...ethSmcIctConfluenceV1Config,
  symbol,
};
const backtestConfig = {
  ...defaultBacktestConfig,
  initialEquity: 10_000,
  makerEntryFeeRate: 0.00045,
  takerEntryFeeRate: 0.00045,
  takerExitFeeRate: 0.00045,
  slippageBps: 1,
  maxLeverage: 3,
  minNetRewardRisk: 1.2,
  sessionTimeZone: "America/New_York",
  sessionStartMinute: 7 * 60,
  sessionEndMinute: 10 * 60,
  closePositionAtSessionEnd: false,
  accountRiskControlsEnabled: false,
  stopExecutionMode: "hard" as const,
};
const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange(monthlyStart, monthlyEnd, symbol)),
  source.loadDays(dayRange(dailyStart, dailyEnd, symbol)),
]);
const candles = deduplicateCandles([...monthly.candles, ...daily.candles]);
const combinedMissingBarCount = countMissingBars(candles);
if (monthly.quality.missingBarCount > 0 || daily.quality.missingBarCount > 0 || combinedMissingBarCount > 0) {
  throw new Error([
    "ETHUSDT research data is incomplete.",
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
    datasetRole: "translated_rule_evaluation_seen_history",
  },
  {
    id: "calendar_2025",
    from: "2025-01-01",
    through: "2025-12-31",
    datasetRole: "translated_rule_evaluation_seen_history",
  },
  {
    id: "calendar_2026_through_latest_available_day",
    from: "2026-01-01",
    through: dailyEnd,
    datasetRole: "translated_rule_historical_recalculation_seen_history",
  },
  {
    id: "continuous_2024_through_latest_available_day",
    from: "2024-01-01",
    through: dailyEnd,
    datasetRole: "translated_rule_continuous_diagnostic_not_a_holdout",
  },
] as const;

const segments = Object.fromEntries(segmentDefinitions.map((definition) => {
  const segmentCandles = sliceUtcDays(candles, definition.from, definition.through);
  if (segmentCandles.length === 0) throw new Error(`Segment ${definition.id} contains no candles.`);
  const missingBarCount = countMissingBars(segmentCandles);
  if (missingBarCount > 0) throw new Error(`Segment ${definition.id} contains ${missingBarCount} missing 5m bars.`);
  return [definition.id, {
    ...definition,
    quality: {
      candleCount: segmentCandles.length,
      missingBarCount,
      firstCandleTime: segmentCandles[0]?.time ?? null,
      lastCandleTime: segmentCandles.at(-1)?.time ?? null,
    },
    ...runBacktest(segmentCandles),
  }];
}));

const annualSegmentIds = ["calendar_2024", "calendar_2025", "calendar_2026_through_latest_available_day"] as const;
const annualAssessments = Object.fromEntries(annualSegmentIds.map((id) => [id, assessPositiveExpectancy(segments[id].result)]));
const continuousAssessment = assessPositiveExpectancy(segments.continuous_2024_through_latest_available_day.result);
const baselinePassed = continuousAssessment.passed && annualSegmentIds.every((id) => annualAssessments[id].passed);

const report = {
  study: "ETHUSDT SMC/ICT Fibonacci-FVG-order-block V1 preregistered baseline",
  generatedAt: new Date().toISOString(),
  routeId,
  candidateVersion: "smc-ict-fib-fvg-ob-v1",
  symbol,
  venue: "binance_usdm_ethusdt_perpetual",
  source: "binance_vision_usdm",
  sourceUrl: "https://data.binance.vision/data/futures/um",
  researchOnly: true,
  automaticOrdersEnabled: false,
  executionScope: "historical_research_only_no_binance_trading_api",
  parameterSelection: "user_rule_translation_pre_registered_before_first_run",
  datasetRole: "translated_rule_evaluation_non_clean_seen_history",
  cleanHoldoutAvailable: false,
  limitations: [
    "Earlier ETH strategy routes and 2026 data were inspected before this baseline, so these periods are not a clean holdout.",
    "The 2026 period is historical recalculation through Binance Vision's latest confirmed complete daily archive, not forward performance.",
    "The 2024-through-current continuous result is diagnostic; calendar-year segments remain the primary stability check.",
    "The SMC/ICT terms were translated into fixed mechanical definitions before the first run; this Route ID must not be tuned after observing results.",
    "Fees and slippage are conservative research assumptions, not account-specific realized Binance fee tiers or market-impact estimates.",
  ],
  parameters: {
    strategy: strategyConfig,
    backtest: backtestConfig,
  },
  costAssumptions: {
    entry: "fvg_midpoint_limit_with_conservative_fee",
    exit: "hard_stop_or_fixed_2_5r_target",
    takerEntryFeeRate: backtestConfig.takerEntryFeeRate,
    takerExitFeeRate: backtestConfig.takerExitFeeRate,
    slippageBpsPerSide: backtestConfig.slippageBps,
    riskFractionPerTrade: strategyConfig.riskFraction,
    note: "Both entry and exit are charged 0.045%, with 1 bp adverse slippage per side.",
  },
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
  segments,
  baselineAssessment: {
    rule: "positive net PnL, profit factor above 1, and positive average R in the continuous period and every calendar segment",
    annual: annualAssessments,
    continuous: continuousAssessment,
    baselinePassed,
    status: baselinePassed ? "baseline_passed_requires_new_clean_forward_sample" : "baseline_rejected_no_same_route_tuning",
    shadowEligible: false,
    automaticExecutionEligible: false,
  },
};

const output = path.resolve(`research-ict-eth-smc-v1-baseline-through-${dailyEnd}.json`);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output,
  routeId,
  through: dailyEnd,
  quality: report.quality.combined,
  baselineAssessment: report.baselineAssessment,
  metrics: Object.fromEntries(Object.entries(segments).map(([id, segment]) => [id, segment.result.metrics])),
}, null, 2));

function runBacktest(segmentCandles: Candle[]) {
  const strategy = new EthSmcIctConfluenceStrategy(strategyConfig);
  try {
    const result = new BacktestEngine(strategy, backtestConfig).run(segmentCandles);
    return {
      result,
      sideMetrics: summarizeTrades(result.trades, (trade) => trade.side),
      regimeMetrics: summarizeTrades(result.trades, (trade) => trade.regimeKey),
      exitMetrics: summarizeTrades(result.trades, (trade) => trade.exitReason),
      entryMonthMetrics: summarizeTrades(result.trades, (trade) => new Date(trade.entryTime * 1000).toISOString().slice(0, 7)),
    };
  } finally {
    strategy.release();
  }
}

function assessPositiveExpectancy(result: BacktestResult) {
  const checks = {
    netPnlPositive: result.metrics.netPnl > 0,
    profitFactorAboveOne: result.metrics.profitFactor > 1,
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
    netPnl: number;
    averageR: number;
    fees: number;
  }> = {};
  for (const trade of trades) {
    const groupKey = key(trade);
    groups[groupKey] ??= { trades: 0, wins: 0, winRate: 0, netPnl: 0, averageR: 0, fees: 0 };
    const group = groups[groupKey];
    group.trades += 1;
    group.wins += trade.netPnl > 0 ? 1 : 0;
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
