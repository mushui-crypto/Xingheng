import type {
  CanonicalFundingRate,
  CexMarketType,
  CexVenue,
} from "../CexCanonicalModels";

export type FundingArbitrageStrategyType = "PERPETUAL_PERPETUAL" | "SPOT_PERPETUAL";
export type FundingArbitrageConfidence = "low" | "medium" | "high";

type FundingArbitrageLegBase = Readonly<{
  role: "long" | "short";
  venue: CexVenue;
  instrumentId: string;
  marketType: CexMarketType;
  baseQuantity: number;
}>;

export type SpotFundingArbitrageLeg = FundingArbitrageLegBase & Readonly<{
  marketType: "spot";
  fundingSnapshot: null;
}>;

export type PerpetualFundingArbitrageLeg = FundingArbitrageLegBase & Readonly<{
  marketType: "perpetual";
  fundingSnapshot: CanonicalFundingRate;
}>;

export type FundingArbitrageLeg = SpotFundingArbitrageLeg | PerpetualFundingArbitrageLeg;

type FundingArbitragePlanBase = Readonly<{
  planId: string;
  strategyType: FundingArbitrageStrategyType;
  instrument: Readonly<{
    baseAsset: string;
    quoteAsset: string;
    settlementAsset: string;
  }>;
  expectedFunding: Readonly<{
    netRate: number;
    amount: number | null;
    asset: string | null;
    fundingAt: number;
  }>;
  confidence: FundingArbitrageConfidence;
  createdAt: number;
  expiresAt: number;
}>;

type LongPerpetualLeg = PerpetualFundingArbitrageLeg & Readonly<{ role: "long" }>;
type ShortPerpetualLeg = PerpetualFundingArbitrageLeg & Readonly<{ role: "short" }>;
type LongSpotLeg = SpotFundingArbitrageLeg & Readonly<{ role: "long" }>;
type ShortSpotLeg = SpotFundingArbitrageLeg & Readonly<{ role: "short" }>;

export type PerpetualPerpetualFundingArbitragePlan = FundingArbitragePlanBase & Readonly<{
  strategyType: "PERPETUAL_PERPETUAL";
  legs: readonly [LongPerpetualLeg, ShortPerpetualLeg];
  details: Readonly<{
    fundingSpreadRate: number;
    fundingTimeSkewMs: number;
  }>;
}>;

export type SpotPerpetualFundingArbitragePlan = FundingArbitragePlanBase & Readonly<{
  strategyType: "SPOT_PERPETUAL";
  legs:
    | readonly [LongSpotLeg, ShortPerpetualLeg]
    | readonly [LongPerpetualLeg, ShortSpotLeg];
  details: Readonly<{
    perpetualFundingRate: number;
    entryBasisBps: number | null;
  }>;
}>;

export type FundingArbitragePlan =
  | PerpetualPerpetualFundingArbitragePlan
  | SpotPerpetualFundingArbitragePlan;
