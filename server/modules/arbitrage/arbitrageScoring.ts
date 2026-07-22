import type {
  ArbitrageMatchQuality,
  ArbitrageOpportunity,
  ArbitrageOpportunityLeg,
  InternalArbitrageMarket,
} from "./arbitrageTypes";

const millisecondsPerDay = 24 * 60 * 60 * 1000;
const recommendedScoreThreshold = 75;
const watchScoreThreshold = 60;

export function buildArbitrageOpportunities(
  markets: InternalArbitrageMarket[],
  holdingDays: number,
  lookbackDays = 90,
) {
  const opportunities: ArbitrageOpportunity[] = [];
  for (const shortMarket of markets) {
    if (shortMarket.kind !== "perpetual") continue;
    for (const longMarket of markets) {
      if (longMarket.venue === shortMarket.venue || longMarket.id === shortMarket.id) continue;
      if (!isGoldAsset(longMarket.asset) || !isGoldAsset(shortMarket.asset)) continue;
      if (longMarket.kind === "perpetual" && sameFundingProfile(longMarket, shortMarket)) continue;
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
  const coverageRatio = Math.min(longMarket.fundingCoverageRatio ?? 1, shortMarket.fundingCoverageRatio ?? 1);
  const disqualifiers = buildDisqualifiers(longMarket, shortMarket, netApr, dailySpreads.length);
  const warnings = buildWarnings(longMarket, shortMarket, matchQuality, coverageRatio);

  const scoreBreakdown = {
    netApr: roundScore(clamp(netApr / 15, 0, 1) * 30),
    persistence: roundScore(clamp(persistenceRatio * coverageRatio, 0, 1) * 20),
    matching: matchQuality === "exact" ? 15 : matchQuality === "oracle" ? 11 : 7,
    liquidity: liquidityScore(capacityUsd),
    cost: roundScore(clamp((100 - roundTripCostBps) / 80, 0, 1) * 10),
    reliability: reliabilityScore(longMarket, shortMarket, coverageRatio),
  };
  let score = Math.round(Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0));
  if (disqualifiers.length > 0) score = Math.min(score, 49);
  const recommendation = disqualifiers.length > 0
    ? "blocked"
    : score >= recommendedScoreThreshold
      ? "recommended"
      : score >= watchScoreThreshold
        ? "watch"
        : "neutral";

  return {
    id: `${longMarket.id}--${shortMarket.id}`,
    longLeg: toLeg(longMarket),
    shortLeg: toLeg(shortMarket),
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
    recommendation,
    scoreBreakdown,
    disqualifiers,
    warnings,
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
  const cutoff = Date.now() - horizonDays * millisecondsPerDay;
  const shortDaily = aggregateDailyFunding(shortMarket.fundingHistory.filter((point) => point.timestamp >= cutoff));
  if (shortDaily.size === 0) return [];
  if (longMarket.kind === "spot") return [...shortDaily.values()];
  const longDaily = aggregateDailyFunding(longMarket.fundingHistory.filter((point) => point.timestamp >= cutoff));
  return [...shortDaily.entries()]
    .filter(([day]) => longDaily.has(day))
    .map(([day, shortRate]) => shortRate - (longDaily.get(day) ?? 0));
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
  netApr: number,
  spreadSampleDays: number,
) {
  const reasons: string[] = [];
  if (longMarket.status === "disconnected" || shortMarket.status === "disconnected") reasons.push("至少一个市场数据源不可用");
  if (longMarket.bid === null || longMarket.ask === null || shortMarket.bid === null || shortMarket.ask === null) reasons.push("缺少可执行报价");
  if (shortMarket.fundingHistory.length === 0 || (longMarket.kind === "perpetual" && longMarket.fundingHistory.length === 0)) reasons.push("缺少历史资金费率");
  if (spreadSampleDays === 0) reasons.push("历史费率无法对齐");
  if (netApr <= 0) reasons.push("预估收益无法覆盖往返成本");
  return [...new Set(reasons)];
}

function buildWarnings(
  longMarket: InternalArbitrageMarket,
  shortMarket: InternalArbitrageMarket,
  matchQuality: ArbitrageMatchQuality,
  coverageRatio: number,
) {
  const warnings = [...longMarket.warnings, ...shortMarket.warnings];
  if (matchQuality === "proxy") warnings.push("两腿为关联标的，跟踪口径不同，存在发行人、赎回与脱锚风险");
  if (matchQuality === "oracle") warnings.push("两腿指数源可能不同，存在标记价格与交易时段基差");
  if (longMarket.settlementAsset !== shortMarket.settlementAsset) warnings.push("两腿结算资产不同，需单独计量 USDC/USDT 风险");
  if (coverageRatio < 0.8) warnings.push("历史数据覆盖不足，评分可靠性已降低");
  return [...new Set(warnings)];
}

function liquidityScore(capacityUsd: number | null) {
  if (capacityUsd === null || capacityUsd < 10_000) return 0;
  if (capacityUsd >= 100_000) return 15;
  return roundScore(6 + ((capacityUsd - 10_000) / 90_000) * 9);
}

function reliabilityScore(
  longMarket: InternalArbitrageMarket,
  shortMarket: InternalArbitrageMarket,
  coverageRatio: number,
) {
  const statusFactor = longMarket.status === "connected" && shortMarket.status === "connected" ? 1 : 0.6;
  const settlementFactor = longMarket.settlementAsset === shortMarket.settlementAsset ? 1 : 0.8;
  return roundScore(10 * statusFactor * settlementFactor * clamp(coverageRatio, 0.25, 1));
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

function average(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
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
