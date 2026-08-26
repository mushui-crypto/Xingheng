import type { ExecutionQuantityInput, ExecutionQuantityPlan, ExecutionQuantityPlannerErrorCode } from "../cex/ExecutionQuantityPlanner";
import type { TradingRules } from "../cex/TradingRules";

export type ArbitrageExecutionDraftStrategyType = "PERPETUAL_PERPETUAL" | "SPOT_PERPETUAL";
export type ArbitrageExecutionDraftVenue = "binance" | "okx" | "bybit" | "bitget";
export type ArbitrageExecutionMode = "PRICE_PRIORITY" | "EXECUTION_PRIORITY";

export type ArbitrageExecutionCapability = Readonly<{
  status: "AVAILABLE" | "UNAVAILABLE";
  reasonCode:
    | "AVAILABLE"
    | "EXECUTION_CAPABILITY_NOT_IMPLEMENTED"
    | "EXECUTION_MODE_NOT_SUPPORTED"
    | "CREDENTIAL_NOT_CONFIGURED";
}>;

export type ArbitrageExecutionDraftPlanning =
  | Readonly<{ status: "NOT_REQUESTED" }>
  | Readonly<{ status: "PLANNED"; plan: ExecutionQuantityPlan }>
  | Readonly<{
      status: "UNAVAILABLE" | "ERROR";
      errorCode: "INSTRUMENT_CONTEXT_UNAVAILABLE" | ExecutionQuantityPlannerErrorCode;
      minimumRequiredAssetQuantity?: string;
      minimumRequiredVenueQuantity?: string;
      minimumRequiredNotionalUsdt?: string;
      nearestLegalAssetQuantity?: string;
    }>;

export type ArbitrageExecutionDraftLeg = Readonly<{
  legId: string;
  role: "LONG" | "SHORT";
  venue: ArbitrageExecutionDraftVenue;
  instrumentId: string;
  providerSymbol: string | null;
  side: "buy" | "sell";
  marketType: "spot" | "perpetual";
  quote: Readonly<{ bid: string; ask: string; updatedAt: number }> | null;
  tradingRules: TradingRules | null;
  capability: ArbitrageExecutionCapability;
  planning: ArbitrageExecutionDraftPlanning;
  executionAvailable: boolean;
}>;

export type ArbitrageExecutionDraft = Readonly<{
  opportunityId: string;
  sourceIdentity: string;
  sourceSnapshotGeneratedAt: number;
  horizonDays: 90 | 365;
  executionMode: ArbitrageExecutionMode;
  strategyType: ArbitrageExecutionDraftStrategyType;
  quantityInput?: ExecutionQuantityInput;
  legs: readonly [ArbitrageExecutionDraftLeg, ArbitrageExecutionDraftLeg];
  allLegsExecutable: boolean;
  generatedAt: number;
}>;
