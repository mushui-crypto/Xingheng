export type FundingOpportunityVenue = "binance" | "okx" | "bybit" | "bitget";
export type FundingOpportunityConfidence = "low" | "medium" | "high";
export type FundingOpportunitySort = "estimatedNetYield" | "confidence" | "expiresAt";

export type FundingOpportunityView = {
  symbol: string;
  longVenue: FundingOpportunityVenue;
  shortVenue: FundingOpportunityVenue;
  fundingSpread: number;
  estimatedCost: number;
  estimatedNetYield: number;
  confidence: FundingOpportunityConfidence;
  createdAt: number;
  expiresAt: number;
};

export type FundingOpportunitySnapshot = {
  generatedAt: number;
  opportunities: FundingOpportunityView[];
};
