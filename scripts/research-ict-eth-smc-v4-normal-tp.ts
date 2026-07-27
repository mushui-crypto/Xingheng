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
import { newYorkTime } from "../server/modules/strategy/ict/time";
import {
  EthMultiTimeframeSmcIctStrategy,
  ethMultiTimeframeSmcIctV4NormalTpConfigs,
  type EthMultiTimeframeSmcIctConfig,
} from "../server/modules/strategy/models/EthMultiTimeframeSmcIctStrategy";

const symbol = "ETHUSDT" as const;
const monthlyStart = process.argv[2] ?? "2024-01";
const monthlyEnd = process.argv[3] ?? "2026-06";
const dailyStart = process.argv[4] ?? "2026-07-01";
const dailyEnd = process.argv[5] ?? "2026-07-14";
const marginFractions = [0.02, 0.03, 0.04, 0.05] as const;
const routes = ethMultiTimeframeSmcIctV4NormalTpConfigs;

if (Date.parse(`${dailyEnd}T00:00:00Z`) < Date.parse(`${dailyStart}T00:00:00Z`)) {
  throw new Error(`Daily end ${dailyEnd} must be on or after ${dailyStart}.`);
}
if (dailyStart !== firstDayAfterMonth(monthlyEnd)) {
  throw new Error(`V4 requires the daily range to begin immediately after ${monthlyEnd}; expected ${firstDayAfterMonth(monthlyEnd)}.`);
}

const source = new BinanceVisionHistoricalDataSource();
const [monthly, daily] = await Promise.all([
  source.loadMonths(monthRange(monthlyStart, monthlyEnd, "ETHUSDT")),
  source.loadDays(dayRange(dailyStart, dailyEnd, "ETHUSDT")),
]);
if (
  monthly.quality.source !== "binance_vision_usdm" ||
  daily.quality.source !== "binance_vision_usdm" ||
  monthly.quality.market !== "ETHUSDT" ||
  daily.quality.market !== "ETHUSDT" ||
  !monthly.quality.checksumVerified ||
  !daily.quality.checksumVerified
) {
  throw new Error("V4 rejected the dataset because Binance Vision ETHUSDT USD-M identity/checksum verification failed.");
}

const candles = deduplicateCandles([...monthly.candles, ...daily.candles]);
const combinedMissingBarCount = countMissingBars(candles);
if (monthly.quality.missingBarCount > 0 || daily.quality.missingBarCount > 0 || combinedMissingBarCount > 0) {
  throw new Error([
    "ETHUSDT V4 research data is incomplete.",
    `monthly gaps=${monthly.quality.missingBarCount}`,
    `daily gaps=${daily.quality.missingBarCount}`,
    `combined gaps=${combinedMissingBarCount}`,
  ].join(" "));
}
if (candles.some((candle) => candle.symbol !== "ETHUSDT" || candle.interval !== "5m")) {
  throw new Error("V4 research received a candle outside ETHUSDT 5m.");
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

type SegmentId = (typeof segmentDefinitions)[number]["id"];
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
})) as Record<SegmentId, {
  id: SegmentId;
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

const passedCandidateKeys = Object.entries(candidates)
  .filter(([, candidate]) => candidate.assessment.baselinePassed)
  .map(([key]) => key);
const weekendEntryCount = Object.values(candidates).reduce((sum, candidate) => (
  sum + candidate.segments.continuous_2024_through_latest_available_day.executionSummary.weekendNewEntries
), 0);
if (weekendEntryCount !== 0) {
  throw new Error(`V4 violated its frozen weekday rule: ${weekendEntryCount} weekend entries were found.`);
}

const report = {
  study: "ETHUSDT SMC/ICT 4h-1h trend, 15m direction, 5m sweep-FVG-OB V4 normal-TP preregistered baseline",
  generatedAt: new Date().toISOString(),
  frozenRuleDocument: "docs/strategy/archive/STRATEGY_ETH_SMC_ICT_V4_NORMAL_TP.md",
  candidateVersion: "smc-ict-eth-multi-timeframe-v4-normal-tp",
  routes: routes.map((route) => ({
    routeId: route.routeId,
    finalRewardRisk: route.finalRewardRisk,
    takeProfit: `100%@${route.finalRewardRisk}R single target; no partial TP; no break-even stop move`,
  })),
  symbol,
  contract: "ETHUSDT USD-M perpetual (U-margined)",
  venue: "binance_usdm_ethusdt_perpetual",
  source: "binance_vision_usdm",
  sourceUrl: "https://data.binance.vision/data/futures/um",
  researchOnly: true,
  automaticOrdersEnabled: false,
  executionScope: "historical_research_only_no_binance_trading_api",
  parameterSelection: "user-requested normal take-profit derivative preregistered before first v4-normal-tp run",
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
    maximumNewEntriesPerNewYorkDay: 2,
    frequencyInterpretation: "maximum/target opportunity frequency; not a guarantee of two entries each day",
    weekdayEntryRule: "Monday-Friday in America/New_York; Saturday/Sunday entries prohibited",
    weekendHoldingRule: "open positions may remain open across weekends",
    accountRiskControlsEnabled: false,
    consecutiveLossEntryLockEnabled: false,
    dailyLossEntryLockEnabled: false,
    entryFeeRate: 0.00045,
    exitFeeRate: 0.00045,
    slippageBpsPerFill: 1,
    liquidationMaintenanceMarginRate: 0.005,
    liquidationFeeRate: 0.0125,
    maintenanceMarginRateStatus: "explicit research simplification; not the account-specific Binance leverage bracket",
    quantityModel: "continuous ETH quantity; no exchange step-size rounding in this baseline",
    pointStop: "structural stop expanded to 20 USDT points when closer; 20-40 retained; signals above 40 rejected without truncation",
    multiTimeframe: "4h and 1h observe trend; 15m determines direction; 5m enters",
    entrySessionsNewYorkTime: ["London 02:00-05:00", "New York 07:00-11:00"],
    forcedSessionClose: false,
    maximumHoldingTime: null,
    takeProfitMode: "single full-position target; 100% at 1.5R, 2R, or 2.5R",
    breakEvenStopMoveEnabled: false,
  },
  limitations: [
    "The 2024-01-01 through 2026-07-14 history is not a clean holdout because earlier ETH/BTC strategy research already touched it.",
    "Funding payments are excluded.",
    "The 0.50% maintenance margin rate is a research simplification and must be replaced by the account-specific ETHUSDT leverage bracket before forward or execution review.",
    "ETH quantity remains continuous; Binance quantity step, price tick, minimum notional, leverage bracket and order validation are not modeled.",
    "Five-minute OHLC cannot reveal intrabar path, so liquidation and the initial stop are evaluated before the single full-position target.",
    "Cross-margin liquidation assumes no other positions or orders consume wallet collateral.",
    "A 100x exchange leverage setting with 2%-5% initial margin creates approximately 2x-5x initial account notional exposure, not 100x whole-account exposure.",
    "Historical acceptance cannot establish live usability; any accepted candidate still requires a new forward-paper/shadow sample.",
  ],
  requestedRange: { monthlyStart, monthlyEnd, dailyStart, dailyEnd },
  quality: {
    checksumPolicy: "official_sha256_verified_before_using_parsed_cache",
    checksumVerified: monthly.quality.checksumVerified && daily.quality.checksumVerified,
    monthly: monthly.quality,
    daily: daily.quality,
    combined: {
      market: symbol,
      venue: "binance_usdm_ethusdt_perpetual",
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
    continuousRule: "trades>=100, netPnl>0, PF>=1.20, AvgR>=0.10, maxDD<=20%, liquidations=0",
    annualRule: "each 2024/2025/2026-through-07-14 segment trades>=20, netPnl>0, PF>1, AvgR>0",
    candidateCount: Object.keys(candidates).length,
    passedCandidateKeys,
    status: passedCandidateKeys.length > 0
      ? "one_or_more_candidates_passed_requires_new_clean_forward_sample"
      : "all_candidates_rejected_no_same_route_tuning",
    shadowEligible: passedCandidateKeys.length > 0,
    automaticExecutionEligible: false,
  },
};

const jsonOutput = path.resolve(`research-ict-eth-smc-v4-normal-tp-baseline-through-${dailyEnd}.json`);
const markdownOutput = path.resolve("docs/strategy/archive/STRATEGY_ETH_SMC_ICT_V4_NORMAL_TP_RESULT.md");
await Promise.all([
  writeFile(jsonOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(markdownOutput, renderMarkdownReport(report), "utf8"),
]);
console.log(JSON.stringify({
  jsonOutput,
  markdownOutput,
  through: dailyEnd,
  quality: report.quality.combined,
  baselineAssessment: report.baselineAssessment,
  candidates: Object.fromEntries(Object.entries(candidates).map(([key, candidate]) => [key, {
    routeId: candidate.routeId,
    finalRewardRisk: candidate.finalRewardRisk,
    marginFraction: candidate.marginFraction,
    assessment: candidate.assessment,
    continuousMetrics: candidate.segments.continuous_2024_through_latest_available_day.result.metrics,
    executionSummary: candidate.segments.continuous_2024_through_latest_available_day.executionSummary,
  }])),
}, null, 2));

function runCandidate(strategyConfig: EthMultiTimeframeSmcIctConfig, marginFraction: number) {
  const backtestConfig: BacktestConfig = {
    ...defaultBacktestConfig,
    initialEquity: 10_000,
    makerEntryFeeRate: 0.00045,
    takerEntryFeeRate: 0.00045,
    takerExitFeeRate: 0.00045,
    slippageBps: 1,
    maxLeverage: 100,
    minNetRewardRisk: 0,
    sessionTimeZone: "America/New_York",
    sessionStartMinute: 0,
    sessionEndMinute: 0,
    closePositionAtSessionEnd: false,
    accountRiskControlsEnabled: false,
    maxNewEntriesPerDay: 2,
    stopExecutionMode: "hard",
    positionSizingMode: "fixed_margin_fraction",
    positionMarginFraction: marginFraction,
    positionLeverage: 100,
    positionMarginMode: "cross",
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
  })) as Record<SegmentId, ReturnType<typeof runBacktest> & {
    id: SegmentId;
    from: string;
    through: string;
    datasetRole: string;
    quality: typeof preparedSegments[SegmentId]["quality"];
  }>;

  const annualIds = ["calendar_2024", "calendar_2025", "calendar_2026_through_latest_available_day"] as const;
  const annual = Object.fromEntries(annualIds.map((id) => [id, assessAnnual(segments[id].result)])) as Record<(typeof annualIds)[number], ReturnType<typeof assessAnnual>>;
  const continuous = assessContinuous(
    segments.continuous_2024_through_latest_available_day.result,
    segments.continuous_2024_through_latest_available_day.executionSummary,
  );
  const baselinePassed = continuous.passed && annualIds.every((id) => annual[id].passed);
  return {
    routeId: strategyConfig.routeId,
    finalRewardRisk: strategyConfig.finalRewardRisk,
    takeProfit: `100%@${strategyConfig.finalRewardRisk}R`,
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
      shadowEligible: baselinePassed,
      automaticExecutionEligible: false,
    },
  };
}

function runBacktest(
  segmentCandles: Candle[],
  strategyConfig: EthMultiTimeframeSmcIctConfig,
  backtestConfig: BacktestConfig,
) {
  const strategy = new EthMultiTimeframeSmcIctStrategy(strategyConfig);
  try {
    const result = new BacktestEngine(strategy, backtestConfig).run(segmentCandles);
    return {
      result,
      sideMetrics: summarizeTrades(result.trades, (trade) => trade.side),
      sessionMetrics: summarizeTrades(result.trades, (trade) => entrySession(trade.entryTime)),
      regimeMetrics: summarizeTrades(result.trades, (trade) => trade.regimeKey),
      exitMetrics: summarizeTrades(result.trades, (trade) => trade.exitReason),
      entryMonthMetrics: summarizeTrades(result.trades, (trade) => new Date(trade.entryTime * 1000).toISOString().slice(0, 7)),
      entriesPerNewYorkDay: summarizeEntriesPerNewYorkDay(result.trades, segmentCandles),
      executionSummary: summarizeExecution(result.trades),
    };
  } finally {
    strategy.release();
  }
}

function assessContinuous(result: BacktestResult, execution: ReturnType<typeof summarizeExecution>) {
  const checks = {
    atLeast100Trades: result.metrics.tradeCount >= 100,
    netPnlPositive: result.metrics.netPnl > 0,
    profitFactorAtLeast1_20: result.metrics.profitFactor !== null && result.metrics.profitFactor >= 1.2,
    averageRAtLeast0_10: result.metrics.averageR >= 0.1,
    maxDrawdownAtMost20Pct: result.metrics.maxDrawdownFraction <= 0.2,
    noLiquidations: execution.liquidations === 0,
    noWeekendEntries: execution.weekendNewEntries === 0,
    noMoreThanTwoEntriesPerNyDay: execution.maximumEntriesOnAnyNewYorkDay <= 2,
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}

function assessAnnual(result: BacktestResult) {
  const checks = {
    atLeast20Trades: result.metrics.tradeCount >= 20,
    netPnlPositive: result.metrics.netPnl > 0,
    profitFactorAboveOne: result.metrics.profitFactor !== null && result.metrics.profitFactor > 1,
    averageRPositive: result.metrics.averageR > 0,
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}

function summarizeTrades(trades: BacktestTrade[], key: (trade: BacktestTrade) => string) {
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
  let targetTrades = 0;
  let stopTrades = 0;
  let liquidations = 0;
  let weekendNewEntries = 0;
  let positionsHeldAcrossWeekend = 0;
  let longestHoldingSeconds = 0;
  let maximumEntryNotional = 0;
  let maximumAllocatedMargin = 0;
  const entriesByNewYorkDay: Record<string, number> = {};
  for (const trade of trades) {
    targetTrades += trade.exitReason === "target" ? 1 : 0;
    stopTrades += trade.exitReason === "stop" ? 1 : 0;
    liquidations += trade.exitReason === "liquidation" ? 1 : 0;
    const entryLocal = newYorkTime(trade.entryTime);
    weekendNewEntries += entryLocal.isWeekend ? 1 : 0;
    positionsHeldAcrossWeekend += crossesNewYorkWeekend(trade.entryTime, trade.exitTime) ? 1 : 0;
    entriesByNewYorkDay[entryLocal.dateKey] = (entriesByNewYorkDay[entryLocal.dateKey] ?? 0) + 1;
    longestHoldingSeconds = Math.max(longestHoldingSeconds, trade.exitTime - trade.entryTime);
    maximumEntryNotional = Math.max(maximumEntryNotional, trade.entryPrice * trade.quantity);
    maximumAllocatedMargin = Math.max(maximumAllocatedMargin, trade.allocatedMargin ?? 0);
  }
  return {
    liquidations,
    targetTrades,
    stopTrades,
    weekendNewEntries,
    positionsHeldAcrossWeekend,
    longestHoldingSeconds,
    longestHoldingHours: longestHoldingSeconds / 3600,
    maximumEntriesOnAnyNewYorkDay: Math.max(0, ...Object.values(entriesByNewYorkDay)),
    maximumEntryNotional,
    maximumAllocatedMargin,
  };
}

function summarizeEntriesPerNewYorkDay(trades: BacktestTrade[], segmentCandles: Candle[]) {
  const entryCounts = new Map<string, number>();
  for (const trade of trades) {
    const dateKey = newYorkTime(trade.entryTime).dateKey;
    entryCounts.set(dateKey, (entryCounts.get(dateKey) ?? 0) + 1);
  }
  const weekdays = new Set<string>();
  for (const candle of segmentCandles) {
    const local = newYorkTime(candle.time);
    if (!local.isWeekend) weekdays.add(local.dateKey);
  }
  const histogram = { zero: 0, one: 0, two: 0, overTwo: 0 };
  for (const dateKey of weekdays) {
    const count = entryCounts.get(dateKey) ?? 0;
    if (count === 0) histogram.zero += 1;
    else if (count === 1) histogram.one += 1;
    else if (count === 2) histogram.two += 1;
    else histogram.overTwo += 1;
  }
  return {
    observedNewYorkWeekdays: weekdays.size,
    histogram,
    averageEntriesPerObservedWeekday: weekdays.size ? trades.length / weekdays.size : 0,
    maximumEntriesOnAnyDay: Math.max(0, ...entryCounts.values()),
    daysWithEntries: entryCounts.size,
  };
}

function entrySession(timestamp: number) {
  const minute = newYorkTime(timestamp).minuteOfDay;
  if (minute >= 2 * 60 && minute < 5 * 60) return "london";
  if (minute >= 7 * 60 && minute < 11 * 60) return "new_york";
  return "outside_frozen_entry_window";
}

function crossesNewYorkWeekend(entryTime: number, exitTime: number) {
  if (exitTime <= entryTime) return false;
  const start = Math.floor(entryTime / 86_400) * 86_400;
  const end = Math.floor(exitTime / 86_400) * 86_400;
  for (let time = start; time <= end; time += 86_400) {
    const noon = time + 12 * 3600;
    if (noon >= entryTime && noon <= exitTime && newYorkTime(noon).isWeekend) return true;
  }
  return false;
}

function renderMarkdownReport(input: typeof report) {
  const rows = Object.values(input.candidates).map((candidate) => {
    const segment = candidate.segments.continuous_2024_through_latest_available_day;
    const metrics = segment.result.metrics;
    const execution = segment.executionSummary;
    return `| ${candidate.finalRewardRisk}R | ${(candidate.marginFraction * 100).toFixed(0)}% | ${metrics.tradeCount} | ${formatMoney(metrics.netPnl)} | ${formatNumber(metrics.profitFactor)} | ${formatNumber(metrics.averageR)} | ${formatPercent(metrics.maxDrawdownFraction)} | ${execution.targetTrades} | ${execution.stopTrades} | ${execution.liquidations} | ${execution.weekendNewEntries} | ${execution.positionsHeldAcrossWeekend} | ${formatNumber(execution.longestHoldingHours)} | ${candidate.assessment.baselinePassed ? "通过" : "拒绝"} |`;
  });
  const annualRows = Object.values(input.candidates).flatMap((candidate) => ([
    ["2024", candidate.assessment.annual.calendar_2024, candidate.segments.calendar_2024.result.metrics],
    ["2025", candidate.assessment.annual.calendar_2025, candidate.segments.calendar_2025.result.metrics],
    ["2026-07-14", candidate.assessment.annual.calendar_2026_through_latest_available_day, candidate.segments.calendar_2026_through_latest_available_day.result.metrics],
  ] as const).map(([year, assessment, metrics]) => (
    `| ${candidate.finalRewardRisk}R | ${(candidate.marginFraction * 100).toFixed(0)}% | ${year} | ${metrics.tradeCount} | ${formatMoney(metrics.netPnl)} | ${formatNumber(metrics.profitFactor)} | ${formatNumber(metrics.averageR)} | ${assessment.passed ? "通过" : "拒绝"} |`
  )));
  const status = input.baselineAssessment.passedCandidateKeys.length > 0
    ? "存在历史门槛通过组合，但只能进入新的 forward paper / shadow；仍不得自动实盘。"
    : "全部组合未通过冻结门槛。本 V4 正常止盈路线按 all_candidates_rejected_no_same_route_tuning 冻结，不在同一路线上事后调参。";
  return `# ETHUSDT SMC + ICT V4 正常止盈首次冻结回测结果\n\n` +
    `- 生成时间：${input.generatedAt}\n` +
    `- 冻结规则：\`${input.frozenRuleDocument}\`\n` +
    `- 数据：Binance Vision \`ETHUSDT\` USD-M / U 本位永续 5m\n` +
    `- 区间：${input.requestedRange.monthlyStart} 至 ${input.requestedRange.dailyEnd}\n` +
    `- 校验：官方 SHA256=${input.quality.checksumVerified ? "通过" : "失败"}；缺失 5m K 线=${input.quality.combined.missingBarCount}\n` +
    `- 结论：**${status}**\n\n` +
    `## 冻结执行口径\n\n` +
    `- 4h/1h 观察趋势，15m 决定方向，5m 执行。\n` +
    `- 仅纽约本地周一至周五允许新开仓；周末不新开仓，但持仓可跨周末。\n` +
    `- 每个纽约交易日最多两次实际新开仓；这是频率上限/目标，不保证每天两单。\n` +
    `- 连续止损与每日亏损停止开仓均关闭。\n` +
    `- 止损按结构寻找：不足 20 点扩到 20 点，20–40 点保留，超过 40 点拒绝且不截短。\n` +
    `- 100x 为交易所杠杆；2%–5% 初始保证金约对应账户权益 2x–5x 初始名义敞口。\n` +
    `- 三套正常止盈：不分批、不移动保本，100% 仓位分别在 1.5R / 2R / 2.5R 单目标退出。\n` +
    `- funding 未计入；研究脚本不连接 Binance 下单 API。\n\n` +
    `## 连续区间（2024-01-01 至 ${input.requestedRange.dailyEnd}）\n\n` +
    `| 全仓目标 | 保证金 | 交易数 | 净收益 | PF | Avg R | 最大回撤 | 止盈 | 止损 | 清算 | 周末开仓 | 跨周末持仓 | 最长持仓(h) | 判定 |\n` +
    `|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n` +
    `${rows.join("\n")}\n\n` +
    `连续门槛：${input.baselineAssessment.continuousRule}。\n\n` +
    `## 年度分段\n\n` +
    `| 最终目标 | 保证金 | 分段 | 交易数 | 净收益 | PF | Avg R | 判定 |\n` +
    `|---:|---:|---|---:|---:|---:|---:|---|\n` +
    `${annualRows.join("\n")}\n\n` +
    `年度门槛：${input.baselineAssessment.annualRule}。\n\n` +
    `## 使用边界\n\n` +
    `历史回测通过不等于可真实应用。任何通过组合都必须使用新的未参与参数选择的数据进行 forward paper / shadow 验证；\`automaticExecutionEligible\` 始终为 \`false\`。\n`;
}

function formatMoney(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : String(value);
}

function formatNumber(value: number | null) {
  return value === null ? "∞" : Number.isFinite(value) ? value.toFixed(4) : String(value);
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
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
  return milliseconds / 1_000;
}
