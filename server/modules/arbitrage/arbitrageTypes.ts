export type ArbitrageVenue = "binance" | "bybit" | "bitget" | "okx" | "tradexyz";
export type ArbitrageAsset =
  | "XAU"
  | "GOLD"
  | "XAUT"
  | "PAXG"
  | "MU"
  | "NVDA"
  | "GOOGL"
  | "MSFT"
  | "TSLA"
  | "BTC"
  | "ETH"
  | "SOL"
  | "XRP"
  | "DOGE";
export type ArbitrageInstrumentKind = "spot" | "perpetual";
export type ArbitrageQuoteAsset = "USDT" | "USDC";
export type ArbitrageMarketStatus = "connected" | "degraded" | "disconnected";
export type ArbitrageMatchQuality = "exact" | "oracle" | "proxy";
export type ArbitrageRecommendation = "recommended" | "watch" | "neutral" | "blocked";
export type ArbitrageEntryStatus = "favorable" | "cautious" | "waiting" | "blocked";
export type ArbitrageStrategyType = "same_venue_neutral" | "cross_venue_arbitrage";
export type ArbitrageConfidence = "high" | "medium" | "low";
export type ArbitrageOpportunityDriver = "funding" | "basis" | "mixed";

export type FundingPoint = {
  rate: number;
  timestamp: number;
};

export type OrderbookLevel = {
  price: number;
  size: number;
};

export type ArbitrageMarket = {
  id: string;
  venue: ArbitrageVenue;
  venueLabel: string;
  symbol: string;
  asset: ArbitrageAsset;
  kind: ArbitrageInstrumentKind;
  quoteAsset: ArbitrageQuoteAsset;
  settlementAsset: ArbitrageQuoteAsset;
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
  fundingScheduleCompleteness?: "COMPLETE" | "INCOMPLETE";
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

export type ArbitrageScoreBreakdown = {
  conservativeNetReturn: number;
  driverStrength: number;
  persistence: number;
  costEfficiency: number;
  liquidity: number;
  confidence: number;
};

export type ArbitrageOpportunity = {
  id: string;
  longLeg: ArbitrageOpportunityLeg;
  shortLeg: ArbitrageOpportunityLeg;
  strategyType: ArbitrageStrategyType;
  strategyLabel: string;
  matchQuality: ArbitrageMatchQuality;
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
  historicalQualityScore: number;
  confidence: ArbitrageConfidence;
  confidenceLabel: string;
  opportunityDriver: ArbitrageOpportunityDriver;
  opportunityDriverLabel: string;
  recommendation: ArbitrageRecommendation;
  entryStatus: ArbitrageEntryStatus;
  scoreBreakdown: ArbitrageScoreBreakdown;
  disqualifiers: string[];
  warnings: string[];
  automationEligible: boolean;
  automationDisqualifiers: string[];
};

export type ArbitrageDashboardSnapshot = {
  horizonDays: 90 | 365;
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

export type InternalArbitrageMarket = ArbitrageMarket & {
  fundingHistory: FundingPoint[];
};
