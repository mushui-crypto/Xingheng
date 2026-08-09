import type { CexMarketType, CexVenue } from "../CexCanonicalModels";
import type { FundingArbitrageRemoteObservation } from "./FundingArbitrageExecutionState";

export type FundingArbitrageSubmitLegRequest = Readonly<{
  executionId: string;
  executionAttemptId: string;
  legId: string;
  role: "long" | "short";
  venue: CexVenue;
  instrumentId: string;
  marketType: CexMarketType;
  targetDeltaBaseQuantity: string;
}>;

export type FundingArbitrageExecutionAttemptIdentity = Readonly<{
  executionAttemptId: string;
}>;

export type FundingArbitrageLegExecutionReference = Readonly<{
  executionId: string;
  legId: string;
  executionAttemptId: string;
}>;

export type FundingArbitrageLegObservation = Readonly<{
  executionAttemptId: string;
  observation: FundingArbitrageRemoteObservation;
  confirmedExecutedQuantity: string;
  observedAt: number;
}>;

export type FundingArbitrageCancelLegResult = Readonly<{
  executionAttemptId: string;
  result: "CANCEL_REQUESTED" | "NO_ACTIVE_EXECUTION";
  observedAt: number;
}>;

export interface FundingArbitrageExecutionCapability {
  submitLeg(request: FundingArbitrageSubmitLegRequest): Promise<FundingArbitrageExecutionAttemptIdentity>;
  queryLegState(request: FundingArbitrageLegExecutionReference): Promise<FundingArbitrageLegObservation>;
  cancelLeg(request: FundingArbitrageLegExecutionReference): Promise<FundingArbitrageCancelLegResult>;
  reconcileLeg(request: FundingArbitrageLegExecutionReference): Promise<FundingArbitrageLegObservation>;
}
