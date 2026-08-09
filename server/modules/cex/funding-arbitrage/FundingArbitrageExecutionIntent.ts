import type { CexMarketType, CexVenue } from "../CexCanonicalModels";
import type { FundingArbitrageStrategyType } from "./FundingArbitragePlan";

export type FundingArbitrageExecutionObjective = "ESTABLISH_HEDGE";

type FundingArbitrageExecutionIntentLegBase = Readonly<{
  legId: string;
  role: "long" | "short";
  venue: CexVenue;
  instrumentId: string;
  marketType: CexMarketType;
  targetDeltaBaseQuantity: string;
}>;

export type PerpetualFundingArbitrageExecutionIntentLeg =
  FundingArbitrageExecutionIntentLegBase & Readonly<{ marketType: "perpetual" }>;

export type SpotFundingArbitrageExecutionIntentLeg =
  FundingArbitrageExecutionIntentLegBase & Readonly<{ marketType: "spot" }>;

type FundingArbitrageExecutionIntentBase = Readonly<{
  intentId: string;
  sourcePlanId: string;
  strategyType: FundingArbitrageStrategyType;
  objective: FundingArbitrageExecutionObjective;
  createdAt: number;
  expiresAt: number;
  constraints: Readonly<{
    maxResidualBaseQuantity: string;
    maxLegStartSkewMs: number;
  }>;
}>;

type LongPerpetualIntentLeg = PerpetualFundingArbitrageExecutionIntentLeg & Readonly<{ role: "long" }>;
type ShortPerpetualIntentLeg = PerpetualFundingArbitrageExecutionIntentLeg & Readonly<{ role: "short" }>;
type LongSpotIntentLeg = SpotFundingArbitrageExecutionIntentLeg & Readonly<{ role: "long" }>;
type ShortSpotIntentLeg = SpotFundingArbitrageExecutionIntentLeg & Readonly<{ role: "short" }>;

export type PerpetualPerpetualFundingArbitrageExecutionIntent =
  FundingArbitrageExecutionIntentBase & Readonly<{
    strategyType: "PERPETUAL_PERPETUAL";
    legs: readonly [LongPerpetualIntentLeg, ShortPerpetualIntentLeg];
  }>;

export type SpotPerpetualFundingArbitrageExecutionIntent =
  FundingArbitrageExecutionIntentBase & Readonly<{
    strategyType: "SPOT_PERPETUAL";
    legs:
      | readonly [LongSpotIntentLeg, ShortPerpetualIntentLeg]
      | readonly [LongPerpetualIntentLeg, ShortSpotIntentLeg];
  }>;

export type FundingArbitrageExecutionIntent =
  | PerpetualPerpetualFundingArbitrageExecutionIntent
  | SpotPerpetualFundingArbitrageExecutionIntent;
