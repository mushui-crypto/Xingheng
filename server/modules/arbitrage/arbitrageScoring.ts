import type {
  ArbitrageConfidence,
  ArbitrageMatchQuality,
  ArbitrageOpportunity,
  ArbitrageOpportunityDriver,
  ArbitrageOpportunityLeg,
  InternalArbitrageMarket,
} from "./arbitrageTypes";

const millisecondsPerDay = 24 * 60 * 60 * 1000;
const recommendedScoreThreshold = 80;
const watchScoreThreshold = 65;
const automationAssessmentDays = 90;
const automationMinimumNetApr = 6;
const automationMinimumPersistence = 0.75;
const automationMinimumCapacityUsd = 6_000;
const automationMaximumAbsoluteBasisBps = 50;

export function buildArbitrageOpportunities(
  markets: InternalArbitrageMarket[],
  holdingDays: number,
  lookbackDays = 90,
) {
  const opportunities: ArbitrageOpportunity[] = [];
  for (const shortMarket of markets) {
    if (shortMarket.kind !== "perpetual") continue;
    for (const longMarket of markets) {
      if (longMarket.id === shortMarket.id) continue;
      const sameAsset = longMarket.asset === shortMarket.asset;
      const bothGoldAssets = isGoldAsset(longMarket.asset) && isGoldAsset(shortMarket.asset);
      if (!sameAsset && !bothGoldAssets) continue;
      const sameVenue = longMarket.venue === shortMarket.venue;
      if (sameVenue && !isSameVenueNeutralPair(longMarket, shortMarket)) continue;
      if (!sameVenue && longMarket.kind === "perpetual" && sameFundingProfile(longMarket, shortMarket)) continue;
      opportunities.push(scoreOpportunity(longMarket, shortMarket, holdingDays, lookbackDays));
    }
  }
  return opportunities.sort((left, right) => right.score - left.score || right.netApr - left.netApr);
}

export function scoreOpportunity(
  longMarket: InternalArbitrageMarket,
  shortMarket: InternalArbitrageMarket,
  holdingDays: number,
  lookbackDays = 90,
): ArbitrageOpportunity {
  const strategyType = longMarket.venue === shortMarket.venue
    ? "same_venue_neutral"
    : "cross_venue_arbitrage";
  const matchQuality = getMatchQuality(longMarket.asset, shortMarket.asset);
  const dailySpreads = buildDailyFundingSpreads(longMarket, shortMarket, lookbackDays);
  const historicalGrossApr = dailySpreads.length > 0
    ? average(dailySpreads) * 365 * 100
    : (shortMarket.historicalFundingApr ?? 0) - (longMarket.historicalFundingApr ?? 0);
  const currentGrossApr = (shortMarket.currentFundingApr ?? 0) - (longMarket.currentFundingApr ?? 0);
  const persistenceRatio = dailySpreads.length > 0
    ? dailySpreads.filter((spread) => spread > 0).length / dailySpreads.length
    : 0;
  const longSlippage = longMarket.slippageBps10k ?? 25;
  const shortSlippage = shortMarket.slippageBps10k ?? 25;
  const roundTripCostBps = 2 * (
    longMarket.takerFeeBps + shortMarket.takerFeeBps + longSlippage + shortSlippage
  );
  const annualizedTradingCostApr = (roundTripCostBps / 100) * (365 / holdingDays);
  const netApr = historicalGrossApr - annualizedTradingCostApr;
  const capacityUsd = minNullable(longMarket.depthUsd, shortMarket.depthUsd);
  const entryBasisBps = calculateEntryBasisBps(longMarket.ask, shortMarket.bid);
  const coverageRatio = Math.min(
    marketCoverageRatio(longMarket, lookbackDays),
    marketCoverageRatio(shortMarket, lookbackDays),
  );
  const disqualifiers = buildDisqualifiers(longMarket, shortMarket, dailySpreads.length);
  const confidence = assessConfidence(longMarket, shortMarket, matchQuality, coverageRatio);
  const conservativeFundingApr = calculateConservativeFundingApr(currentGrossApr, dailySpreads);
  const conservativeFundingReturnBps = conservativeFundingApr * (holdingDays / 365) * 100;
  const conservativeBasisReturnBps = Math.max(entryBasisBps ?? 0, 0) * 0.5;
  const conservativeGrossReturnBps = conservativeFundingReturnBps + conservativeBasisReturnBps;
  const conservativeNetReturnBps = conservativeGrossReturnBps - roundTripCostBps;
  const conservativeNetApr = conservativeNetReturnBps * (365 / holdingDays) / 100;
  const opportunityDriver = determineOpportunityDriver(
    conservativeFundingReturnBps,
    conservativeBasisReturnBps,
  );
  const warnings = buildWarnings({
    longMarket,
    shortMarket,
    matchQuality,
    coverageRatio,
    netApr,
    conservativeNetReturnBps,
  });
  const automationDisqualifiers = buildAutomationDisqualifiers({
    longMarket,
    shortMarket,
    strategyType,
    matchQuality,
    historicalGrossApr,
    persistenceRatio,
    roundTripCostBps,
    entryBasisBps,
    capacityUsd,
    disqualifiers,
  });

  const scoreBreakdown = {
    conservativeNetReturn: roundScore(clamp(conservativeNetApr / 15, 0, 1) * 30),
    driverStrength: driverStrengthScore(opportunityDriver, currentGrossApr, entryBasisBps),
    persistence: roundScore(clamp(persistenceRatio * coverageRatio, 0, 1) * 15),
    costEfficiency: costEfficiencyScore(conservativeGrossReturnBps, roundTripCostBps),
    liquidity: currentLiquidityScore(capacityUsd),
    confidence: confidenceScore(confidence),
  };
  const historicalQualityScore = calculateHistoricalQualityScore({
    netApr,
    persistenceRatio,
    coverageRatio,
    matchQuality,
    capacityUsd,
    roundTripCostBps,
    longMarket,
    shortMarket,
  });
  let score = Math.round(Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0));
  if (matchQuality === "proxy") score = Math.min(score, 79);
  if (conservativeNetReturnBps <= 0) score = Math.min(score, 54);
  if (confidence === "low") score = Math.min(score, 69);
  if (opportunityDriver === "funding" && (shortMarket.fundingRate ?? 0) <= 0) {
    score = Math.min(score, 49);
  }
  const recommendation = disqualifiers.length > 0
    ? "blocked"
    : historicalQualityScore >= recommendedScoreThreshold
      ? "recommended"
      : historicalQualityScore >= watchScoreThreshold
        ? "watch"
        : "neutral";
  const entryStatus = assessEntryStatus({
    longMarket,
    shortMarket,
    disqualifiers,
    currentGrossApr,
    conservativeNetReturnBps,
    entryBasisBps,
    capacityUsd,
  });

  return {
    id: `${longMarket.id}--${shortMarket.id}`,
    longLeg: toLeg(longMarket),
    shortLeg: toLeg(shortMarket),
    strategyType,
    strategyLabel: strategyType === "same_venue_neutral" ? "同所中性" : "跨所套利",
    matchQuality,
    matchLabel: matchQuality === "exact" ? "精确匹配" : matchQuality === "oracle" ? "同类黄金指数" : "关联标的",
    currentGrossApr: roundMetric(currentGrossApr),
    historicalGrossApr: roundMetric(historicalGrossApr),
    netApr: roundMetric(netApr),
    persistenceRatio: roundMetric(persistenceRatio),
    annualizedTradingCostApr: roundMetric(annualizedTradingCostApr),
    roundTripCostBps: roundMetric(roundTripCostBps),
    entryBasisBps: entryBasisBps === null ? null : roundMetric(entryBasisBps),
    capacityUsd: capacityUsd === null ? null : Math.round(capacityUsd),
    score,
    historicalQualityScore,
    confidence,
    confidenceLabel: confidence === "high" ? "高" : confidence === "medium" ? "中" : "低",
    opportunityDriver,
    opportunityDriverLabel: opportunityDriver === "funding"
      ? "资金费率驱动"
      : opportunityDriver === "basis"
        ? "基差回归驱动"
        : "混合驱动",
    recommendation,
    entryStatus,
    scoreBreakdown,
    disqualifiers,
    warnings,
    automationEligible: automationDisqualifiers.length === 0,
    automationDisqualifiers,
  };
}

export function calculateHistoricalFundingMetrics(history: Array<{ rate: number; timestamp: number }>, horizonDays: number) {
  if (history.length === 0) {
    return { apr: null, positiveRatio: null, coverageRatio: 0 };
  }
  const cutoff = Date.now() - horizonDays * millisecondsPerDay;
  const points = history.filter((point) => point.timestamp >= cutoff).sort((left, right) => left.timestamp - right.timestamp);
  if (points.length === 0) {
    return { apr: null, positiveRatio: null, coverageRatio: 0 };
  }
  const daily = aggregateDailyFunding(points);
  const apr = average([...daily.values()]) * 365 * 100;
  const positiveRatio = points.filter((point) => point.rate > 0).length / points.length;
  const firstTimestamp = points[0]?.timestamp ?? Date.now();
  const sampleDays = Math.min(horizonDays, Math.max(1, (Date.now() - firstTimestamp) / millisecondsPerDay));
  return {
    apr: roundMetric(apr),
    positiveRatio: roundMetric(positiveRatio),
    coverageRatio: roundMetric(clamp(sampleDays / horizonDays, 0, 1)),
  };
}

function buildDailyFundingSpreads(longMarket: InternalArbitrageMarket, shortMarket: InternalArbitrageMarket, horizonDays: number) {
  const cutoff = Math.max(
    Date.now() - horizonDays * millisecondsPerDay,
    longMarket.availableSince ?? 0,
    shortMarket.availableSince ?? 0,
  );
  const shortDaily = aggregateDailyFunding(shortMarket.fundingHistory.filter((point) => point.timestamp >= cutoff));
  if (shortDaily.size === 0) return [];
  if (longMarket.kind === "spot") return [...shortDaily.values()];
  const longDaily = aggregateDailyFunding(longMarket.fundingHistory.filter((point) => point.timestamp >= cutoff));
  return [...shortDaily.entries()]
    .filter(([day]) => longDaily.has(day))
    .map(([day, shortRate]) => shortRate - (longDaily.get(day) ?? 0));
}

function marketCoverageRatio(market: InternalArbitrageMarket, horizonDays: number) {
  const fundingCoverage = market.fundingCoverageRatio ?? (market.kind === "spot" ? 1 : 0);
  if (!market.availableSince) return fundingCoverage;
  const availableDays = Math.max(0, (Date.now() - market.availableSince) / millisecondsPerDay);
  return Math.min(fundingCoverage, clamp(availableDays / horizonDays, 0, 1));
}

function aggregateDailyFunding(history: Array<{ rate: number; timestamp: number }>) {
  const daily = new Map<string, number>();
  for (const point of history) {
    const day = new Date(point.timestamp).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + point.rate);
  }
  return daily;
}

function getMatchQuality(longAsset: string, shortAsset: string): ArbitrageMatchQuality {
  if (longAsset === shortAsset) return "exact";
  if (new Set([longAsset, shortAsset]).size === 2 && [longAsset, shortAsset].every((asset) => asset === "XAU" || asset === "GOLD")) {
    return "oracle";
  }
  return "proxy";
}

function buildDisqualifiers(
  longMarket: InternalArbitrageMarket,
  shortMarket: InternalArbitrageMarket,
  spreadSampleDays: number,
) {
  const reasons: string[] = [];
  if (longMarket.status === "disconnected" || shortMarket.status === "disconnected") reasons.push("至少一个市场数据源不可用");
  if (longMarket.bid === null || longMarket.ask === null || shortMarket.bid === null || shortMarket.ask === null) reasons.push("缺少可执行报价");
  if (shortMarket.fundingRate === null || (longMarket.kind === "perpetual" && longMarket.fundingRate === null)) {
    reasons.push("缺少当前资金费率");
  }
  if (shortMarket.fundingHistory.length === 0 || (longMarket.kind === "perpetual" && longMarket.fundingHistory.length === 0)) reasons.push("缺少历史资金费率");
  if (spreadSampleDays === 0) reasons.push("历史费率无法对齐");
  return [...new Set(reasons)];
}

function buildWarnings(input: {
  longMarket: InternalArbitrageMarket;
  shortMarket: InternalArbitrageMarket;
  matchQuality: ArbitrageMatchQuality;
  coverageRatio: number;
  netApr: number;
  conservativeNetReturnBps: number;
}) {
  const { longMarket, shortMarket, matchQuality, coverageRatio } = input;
  const warnings = [...longMarket.warnings, ...shortMarket.warnings];
  if (matchQuality === "proxy") warnings.push("两腿为关联标的，跟踪口径不同，存在发行人、赎回与脱锚风险");
  if (matchQuality === "oracle") warnings.push("两腿指数源可能不同，存在标记价格与交易时段基差");
  if (isStockRwaAsset(longMarket.asset) || isStockRwaAsset(shortMarket.asset)) {
    warnings.push("股票代币与指数永续不代表同一法律权益，仍存在发行人、价格源、公司行动与交易时段差异");
  }
  if (longMarket.venue === shortMarket.venue) warnings.push("同所组合降低执行复杂度，但资金与持仓集中承担单一交易所风险");
  if (longMarket.settlementAsset !== shortMarket.settlementAsset) warnings.push("两腿结算资产不同，需单独计量 USDC/USDT 风险");
  if (coverageRatio < 0.8) warnings.push("历史数据覆盖不足，评分可靠性已降低");
  if ((shortMarket.fundingRate ?? 0) <= 0) warnings.push("当前空头腿未处于收取 Funding 状态");
  if (input.netApr <= 0) warnings.push("历史等效净收益无法覆盖往返成本");
  if (input.conservativeNetReturnBps <= 0) warnings.push("当前保守预期净收益无法覆盖往返成本");
  return [...new Set(warnings)];
}

function buildAutomationDisqualifiers(input: {
  longMarket: InternalArbitrageMarket;
  shortMarket: InternalArbitrageMarket;
  strategyType: ArbitrageOpportunity["strategyType"];
  matchQuality: ArbitrageMatchQuality;
  historicalGrossApr: number;
  persistenceRatio: number;
  roundTripCostBps: number;
  entryBasisBps: number | null;
  capacityUsd: number | null;
  disqualifiers: string[];
}) {
  const reasons: string[] = [];
  if (input.strategyType !== "same_venue_neutral") reasons.push("首版自动执行仅评估同所中性组合");
  if (!isSameVenueNeutralPair(input.longMarket, input.shortMarket) || input.matchQuality !== "exact") {
    reasons.push("首版仅允许同一资产的现货多头与永续空头");
  }
  if (input.disqualifiers.length > 0) reasons.push(...input.disqualifiers);
  if (input.longMarket.status !== "connected" || input.shortMarket.status !== "connected") reasons.push("自动执行要求两腿行情状态正常");
  if ((input.shortMarket.fundingRate ?? 0) <= 0) reasons.push("当前空头腿未处于收取 Funding 状态");
  if (input.persistenceRatio < automationMinimumPersistence) reasons.push("近90天有利天数不足75%");
  const fixedAssessmentNetApr = input.historicalGrossApr
    - (input.roundTripCostBps / 100) * (365 / automationAssessmentDays);
  if (fixedAssessmentNetApr < automationMinimumNetApr) reasons.push("按90天固定评估的等效净APR低于6%");
  if (input.capacityUsd === null || input.capacityUsd < automationMinimumCapacityUsd) reasons.push("公开盘口容量不足6,000美元");
  if (input.entryBasisBps === null || Math.abs(input.entryBasisBps) > automationMaximumAbsoluteBasisBps) {
    reasons.push("入场基差绝对值超过50bps或暂不可计算");
  }
  return [...new Set(reasons)];
}

function isSameVenueNeutralPair(longMarket: InternalArbitrageMarket, shortMarket: InternalArbitrageMarket) {
  return longMarket.venue === shortMarket.venue
    && longMarket.kind === "spot"
    && shortMarket.kind === "perpetual"
    && longMarket.asset === shortMarket.asset;
}

function assessEntryStatus(input: {
  longMarket: InternalArbitrageMarket;
  shortMarket: InternalArbitrageMarket;
  disqualifiers: string[];
  currentGrossApr: number;
  conservativeNetReturnBps: number;
  entryBasisBps: number | null;
  capacityUsd: number | null;
}): ArbitrageOpportunity["entryStatus"] {
  if (input.disqualifiers.length > 0) return "blocked";
  if (input.currentGrossApr <= 0) return "waiting";
  const connected = input.longMarket.status === "connected" && input.shortMarket.status === "connected";
  const basisWithinRange = input.entryBasisBps !== null
    && Math.abs(input.entryBasisBps) <= automationMaximumAbsoluteBasisBps;
  const sufficientCapacity = input.capacityUsd !== null
    && input.capacityUsd >= automationMinimumCapacityUsd;
  return connected && basisWithinRange && sufficientCapacity && input.conservativeNetReturnBps > 0
    ? "favorable"
    : "cautious";
}

function calculateConservativeFundingApr(currentGrossApr: number, dailySpreads: number[]) {
  if (currentGrossApr <= 0 || dailySpreads.length === 0) return Math.min(currentGrossApr, 0);
  const lowerQuartileApr = percentile(dailySpreads, 0.25) * 365 * 100;
  return Math.min(currentGrossApr, lowerQuartileApr);
}

function determineOpportunityDriver(
  conservativeFundingReturnBps: number,
  conservativeBasisReturnBps: number,
): ArbitrageOpportunityDriver {
  const hasFunding = conservativeFundingReturnBps > 1;
  const hasBasis = conservativeBasisReturnBps > 1;
  if (hasFunding && hasBasis) return "mixed";
  if (hasBasis) return "basis";
  return "funding";
}

function driverStrengthScore(
  driver: ArbitrageOpportunityDriver,
  currentGrossApr: number,
  entryBasisBps: number | null,
) {
  const fundingStrength = clamp(Math.max(currentGrossApr, 0) / 20, 0, 1) * 20;
  const basisStrength = clamp(Math.max(entryBasisBps ?? 0, 0) / 100, 0, 1) * 20;
  const score = driver === "funding"
    ? fundingStrength
    : driver === "basis"
      ? basisStrength
      : Math.max(fundingStrength, basisStrength) + Math.min(fundingStrength, basisStrength) * 0.35;
  return roundScore(Math.min(20, score));
}

function costEfficiencyScore(conservativeGrossReturnBps: number, roundTripCostBps: number) {
  if (conservativeGrossReturnBps <= 0) return 0;
  if (roundTripCostBps <= 0) return 15;
  return roundScore(clamp((conservativeGrossReturnBps - roundTripCostBps) / conservativeGrossReturnBps, 0, 1) * 15);
}

function currentLiquidityScore(capacityUsd: number | null) {
  if (capacityUsd === null || capacityUsd < 10_000) return 0;
  if (capacityUsd >= 100_000) return 10;
  return roundScore(4 + ((capacityUsd - 10_000) / 90_000) * 6);
}

function historicalLiquidityScore(capacityUsd: number | null) {
  if (capacityUsd === null || capacityUsd < 10_000) return 0;
  if (capacityUsd >= 100_000) return 15;
  return roundScore(6 + ((capacityUsd - 10_000) / 90_000) * 9);
}

function assessConfidence(
  longMarket: InternalArbitrageMarket,
  shortMarket: InternalArbitrageMarket,
  matchQuality: ArbitrageMatchQuality,
  coverageRatio: number,
): ArbitrageConfidence {
  if (
    longMarket.status === "disconnected"
    || shortMarket.status === "disconnected"
    || coverageRatio < 0.5
  ) return "low";
  if (
    longMarket.status !== "connected"
    || shortMarket.status !== "connected"
    || coverageRatio < 0.8
    || matchQuality !== "exact"
    || longMarket.settlementAsset !== shortMarket.settlementAsset
  ) return "medium";
  return "high";
}

function confidenceScore(confidence: ArbitrageConfidence) {
  return confidence === "high" ? 10 : confidence === "medium" ? 6 : 2;
}

function historicalReliabilityScore(
  longMarket: InternalArbitrageMarket,
  shortMarket: InternalArbitrageMarket,
  coverageRatio: number,
) {
  const statusFactor = longMarket.status === "connected" && shortMarket.status === "connected" ? 1 : 0.6;
  const settlementFactor = longMarket.settlementAsset === shortMarket.settlementAsset ? 1 : 0.8;
  return roundScore(10 * statusFactor * settlementFactor * clamp(coverageRatio, 0.25, 1));
}

function calculateHistoricalQualityScore(input: {
  netApr: number;
  persistenceRatio: number;
  coverageRatio: number;
  matchQuality: ArbitrageMatchQuality;
  capacityUsd: number | null;
  roundTripCostBps: number;
  longMarket: InternalArbitrageMarket;
  shortMarket: InternalArbitrageMarket;
}) {
  const score = Math.round(
    roundScore(clamp(input.netApr / 15, 0, 1) * 30)
    + roundScore(clamp(input.persistenceRatio * input.coverageRatio, 0, 1) * 20)
    + (input.matchQuality === "exact" ? 15 : input.matchQuality === "oracle" ? 11 : 7)
    + historicalLiquidityScore(input.capacityUsd)
    + roundScore(clamp((100 - input.roundTripCostBps) / 80, 0, 1) * 10)
    + historicalReliabilityScore(input.longMarket, input.shortMarket, input.coverageRatio),
  );
  return input.matchQuality === "proxy" ? Math.min(score, 79) : score;
}

function toLeg(market: InternalArbitrageMarket): ArbitrageOpportunityLeg {
  return {
    id: market.id,
    venue: market.venue,
    venueLabel: market.venueLabel,
    symbol: market.symbol,
    asset: market.asset,
    kind: market.kind,
    quoteAsset: market.quoteAsset,
    settlementAsset: market.settlementAsset,
    bid: market.bid,
    ask: market.ask,
    fundingRate: market.fundingRate,
    fundingIntervalHours: market.fundingIntervalHours,
    currentFundingApr: market.currentFundingApr,
    historicalFundingApr: market.historicalFundingApr,
    nextFundingTime: market.nextFundingTime,
  };
}

function calculateEntryBasisBps(longAsk: number | null, shortBid: number | null) {
  if (!longAsk || !shortBid) return null;
  return ((shortBid - longAsk) / ((shortBid + longAsk) / 2)) * 10_000;
}

function minNullable(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function sameFundingProfile(left: InternalArbitrageMarket, right: InternalArbitrageMarket) {
  return left.asset === right.asset && left.venue === right.venue;
}

function isGoldAsset(value: string) {
  return value === "XAU" || value === "GOLD" || value === "XAUT" || value === "PAXG";
}

function isStockRwaAsset(value: string) {
  return value === "MU" || value === "NVDA" || value === "GOOGL" || value === "MSFT" || value === "TSLA";
}

function average(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.floor((sorted.length - 1) * clamp(ratio, 0, 1));
  return sorted[index] ?? 0;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundMetric(value: number) {
  return Number(value.toFixed(4));
}

function roundScore(value: number) {
  return Number(value.toFixed(2));
}
