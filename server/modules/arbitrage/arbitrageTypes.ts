export type ArbitrageVenue = "binance" | "bybit" | "bitget" | "okx" | "tradexyz";
export type ArbitrageAsset = "XAU" | "GOLD" | "XAUT" | "PAXG";
export type ArbitrageInstrumentKind = "spot" | "perpetual";
export type ArbitrageQuoteAsset = "USDT" | "USDC";
export type ArbitrageMarketStatus = "connected" | "degraded" | "disconnected";
export type ArbitrageMatchQuality = "exact" | "oracle" | "proxy";
export type ArbitrageRecommendation = "recommended" | "watch" | "neutral" | "blocked";

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
  takerFeeBps: number;
  status: ArbitrageMarketStatus;
  fetchedAt: number;
  warnings: string[];
};

export type ArbitrageOpportunityLeg = Pick<
  ArbitrageMarket,
  "id" | "venue" | "venueLabel" | "symbol" | "asset" | "kind" | "quoteAsset" | "settlementAsset" | "bid" | "ask" | "fundingRate" | "fundingIntervalHours" | "currentFundingApr" | "historicalFundingApr" | "nextFundingTime"
>;

export type ArbitrageScoreBreakdown = {
  netApr: number;
  persistence: number;
  matching: number;
  liquidity: number;
  cost: number;
  reliability: number;
};

export type ArbitrageOpportunity = {
  id: string;
  longLeg: ArbitrageOpportunityLeg;
  shortLeg: ArbitrageOpportunityLeg;
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
  recommendation: ArbitrageRecommendation;
  scoreBreakdown: ArbitrageScoreBreakdown;
  disqualifiers: string[];
  warnings: string[];
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
