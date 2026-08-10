import type { CexVenue } from "../CexCanonicalModels";

export type FundingSpreadStrategyType = "PERPETUAL_PERPETUAL";
export type FundingSpreadConfidence = "low" | "medium" | "high";

export type FundingSpreadPlan = Readonly<{
  strategyType: FundingSpreadStrategyType;
  symbol: string;
  longVenue: CexVenue;
  shortVenue: CexVenue;
  longInstrumentId: string;
  shortInstrumentId: string;
  longFundingRate: number;
  shortFundingRate: number;
  fundingSpread: number;
  estimatedCost: number;
  estimatedNetYield: number;
  confidence: FundingSpreadConfidence;
  createdAt: number;
  expiresAt: number;
}>;
