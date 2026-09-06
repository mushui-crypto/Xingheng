export type ArbitrageHorizon = 90 | 365;
export type ArbitrageYieldMetric = "apr" | "apy";
export const ARBITRAGE_ASSET_ORDER = [
  "XAU",
  "GOLD",
  "XAUT",
  "PAXG",
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "DOGE",
  "MU",
  "NVDA",
  "GOOGL",
  "MSFT",
  "TSLA",
  "AAPL",
  "AMZN",
  "META",
  "COIN",
  "PLTR",
  "MSTR",
  "HOOD",
  "INTC",
  "AVGO",
  "ORCL",
  "NFLX",
  "CRM",
  "WMT",
  "CRCL",
  "SNDK",
  "QCOM",
  "UBER",
  "JPM",
  "V",
] as const;
export type ArbitrageAsset = (typeof ARBITRAGE_ASSET_ORDER)[number];
export type ArbitrageVenue = "binance" | "bybit" | "bitget" | "okx" | "tradexyz";
export type ArbitrageMarketStatus = "connected" | "degraded" | "disconnected";
export type ArbitrageRecommendation = "recommended" | "watch" | "neutral" | "blocked";
export type ArbitrageEntryStatus = "favorable" | "cautious" | "waiting" | "blocked";
export type ArbitrageStrategyType = "same_venue_neutral" | "cross_venue_arbitrage";
export type ArbitrageConfidence = "high" | "medium" | "low";
export type ArbitrageOpportunityDriver = "funding" | "basis" | "mixed";

export type ArbitrageMarket = {
  sourceUpdatedAt?: number | null;
  freshness?: "FRESH" | "STALE" | "UNAVAILABLE";
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
  freshness?: "FRESH" | "STALE";
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
  historicalQualityScore: number;
  confidence: ArbitrageConfidence;
  opportunityDriver: ArbitrageOpportunityDriver;
  opportunityDriverLabel: string;
  recommendation: ArbitrageRecommendation;
  entryStatus: ArbitrageEntryStatus;
  scoreBreakdown: {
    conservativeNetReturn: number;
    driverStrength: number;
    persistence: number;
    costEfficiency: number;
    liquidity: number;
    confidence: number;
  };
  disqualifiers: string[];
  warnings: string[];
  automationEligible: boolean;
  automationDisqualifiers: string[];
};

export type ArbitrageDashboardSnapshot = {
  /** Scan cache lifecycle only; independent of market fact freshness. */
  refreshState?: "FRESH" | "REFRESHING";
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
