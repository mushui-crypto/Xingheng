import {
  createExecutionQueryObservation,
  type ExecutionQueryObservation,
} from "../ExecutionQueryCapability";
import type { ExecutionRecord } from "../ExecutionRecord";
import type { FundingLegExecutionLink } from "./FundingLegExecutionLinkStore";
import {
  updateFundingArbitrageLegExecution,
  type FundingArbitrageExecutionState,
  type FundingArbitrageLegExecutionStatus,
  type FundingArbitrageRemoteObservation,
} from "./FundingArbitrageExecutionState";

export type FundingLegExecutionStateBridgeInput = Readonly<{
  authenticatedUserId: string;
  fundingState: FundingArbitrageExecutionState;
  legId: string;
  link: FundingLegExecutionLink;
  executionRecord: ExecutionRecord;
  observation: ExecutionQueryObservation;
}>;

export class FundingLegExecutionStateBridge {
  apply(input: FundingLegExecutionStateBridgeInput): FundingArbitrageExecutionState {
    const userId = identifier(input.authenticatedUserId, "authenticated userId");
    const record = input.executionRecord;
    const observation = createExecutionQueryObservation(input.observation);
    if (record.userId !== userId) {
      throw new Error("ExecutionRecord userId does not match the authenticated funding user.");
    }
    if (input.link.executionIntentId !== record.intentId
      || input.link.executionRecordId !== record.executionId) {
      throw new Error("Funding leg execution link does not match the ExecutionRecord identity.");
    }
    if (record.status !== observation.state) {
      throw new Error("ExecutionRecord status does not match the execution observation.");
    }
    if (observation.observedAt < record.updatedAt) {
      throw new Error("Funding bridge observation cannot predate the ExecutionRecord.");
    }
    const leg = input.fundingState.legs.find((candidate) => candidate.legId === input.legId);
    if (!leg) throw new Error("Funding leg does not belong to the funding flow state.");

    const mapping = fundingMappingFor(observation.state);
    return updateFundingArbitrageLegExecution(input.fundingState, {
      legId: leg.legId,
      confirmedExecutedQuantity: maxDecimal(
        leg.confirmedExecutedQuantity,
        observation.filledBaseQuantity,
      ),
      status: mapping.status,
      remoteObservation: mapping.remoteObservation,
      observedAt: observation.observedAt,
    });
  }
}

function fundingMappingFor(state: ExecutionQueryObservation["state"]): Readonly<{
  status: FundingArbitrageLegExecutionStatus;
  remoteObservation: FundingArbitrageRemoteObservation;
}> {
  if (state === "CONFIRMED") return { status: "TERMINAL", remoteObservation: "FILLED" };
  if (state === "FAILED") return { status: "FAILED", remoteObservation: "REJECTED" };
  if (state === "UNKNOWN") {
    return { status: "PENDING_RECONCILIATION", remoteObservation: "UNKNOWN_REMOTE_STATE" };
  }
  return { status: "ACTIVE", remoteObservation: "OPEN" };
}

function maxDecimal(left: string, right: string) {
  const leftValue = decimal(left);
  const rightValue = decimal(right);
  const scale = Math.max(leftValue.scale, rightValue.scale);
  const scaledLeft = leftValue.value * 10n ** BigInt(scale - leftValue.scale);
  const scaledRight = rightValue.value * 10n ** BigInt(scale - rightValue.scale);
  return scaledLeft >= scaledRight ? left : right;
}

function decimal(value: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Funding bridge quantity must be an unsigned decimal string.");
  }
  const [integer, fraction = ""] = value.split(".");
  return { value: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
