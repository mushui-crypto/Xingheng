export type ArbitrageHorizon = 90 | 365;
export type ArbitrageYieldMetric = "apr" | "apy";
export type ArbitrageAsset =
  | "XAU"
  | "GOLD"
  | "XAUT"
  | "PAXG"
  | "MU"
  | "NVDA"
  | "GOOGL"
  | "MSFT"
  | "TSLA";
export type ArbitrageVenue = "binance" | "bybit" | "bitget" | "okx" | "tradexyz";
export type ArbitrageMarketStatus = "connected" | "degraded" | "disconnected";
export type ArbitrageRecommendation = "recommended" | "watch" | "neutral" | "blocked";
export type ArbitrageStrategyType = "same_venue_neutral" | "cross_venue_arbitrage";

export type ArbitrageMarket = {
  id: string;
  venue: ArbitrageVenue;
  venueLabel: string;
  symbol: string;
  asset: ArbitrageAsset;
  kind: "spot" | "perpetual";
  quoteAsset: "USDT" | "USDC";
  settlementAsset: "USDT" | "USDC";
  bid: number | null;
  ask: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  spreadBps: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  currentFundingApr: number | null;
  historicalFundingApr: number | null;
  fundingPositiveRatio: number | null;
  fundingCoverageRatio: number | null;
  slippageBps10k: number | null;
  slippageBps100k: number | null;
  depthUsd: number | null;
  volume24h: number | null;
  openInterest: number | null;
  nextFundingTime: number | null;
  takerFeeBps: number;
  status: ArbitrageMarketStatus;
  fetchedAt: number;
  availableSince?: number | null;
  warnings: string[];
};

export type ArbitrageOpportunityLeg = Pick<
  ArbitrageMarket,
  "id" | "venue" | "venueLabel" | "symbol" | "asset" | "kind" | "quoteAsset" | "settlementAsset" | "bid" | "ask" | "fundingRate" | "fundingIntervalHours" | "currentFundingApr" | "historicalFundingApr" | "nextFundingTime"
>;

export type ArbitrageOpportunity = {
  id: string;
  longLeg: ArbitrageOpportunityLeg;
  shortLeg: ArbitrageOpportunityLeg;
  strategyType: ArbitrageStrategyType;
  strategyLabel: string;
  matchQuality: "exact" | "oracle" | "proxy";
  matchLabel: string;
  currentGrossApr: number;
  historicalGrossApr: number;
  netApr: number;
  persistenceRatio: number;
  annualizedTradingCostApr: number;
  roundTripCostBps: number;
  entryBasisBps: number | null;
  capacityUsd: number | null;
  score: number;
  recommendation: ArbitrageRecommendation;
  scoreBreakdown: {
    netApr: number;
    persistence: number;
    matching: number;
    liquidity: number;
    cost: number;
    reliability: number;
  };
  disqualifiers: string[];
  warnings: string[];
  automationEligible: boolean;
  automationDisqualifiers: string[];
};

export type ArbitrageDashboardSnapshot = {
  horizonDays: ArbitrageHorizon;
  generatedAt: number;
  markets: ArbitrageMarket[];
  opportunities: ArbitrageOpportunity[];
  summary: {
    bestScore: number | null;
    bestNetApr: number | null;
    eligibleOpportunityCount: number;
    connectedVenueCount: number;
    totalVenueCount: number;
    trackedMarketCount: number;
    usdcUsdtPrice: number | null;
    stablecoinBasisBps: number | null;
  };
  warnings: string[];
};
