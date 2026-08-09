import type { FundingArbitrageExecutionIntent } from "./FundingArbitrageExecutionIntent";
import type { FundingArbitrageStrategyType } from "./FundingArbitragePlan";

export type FundingArbitrageAggregateExecutionStatus =
  | "CREATED"
  | "EXECUTING"
  | "PENDING_RECONCILIATION"
  | "HEDGED"
  | "RESIDUAL"
  | "REPAIR_PENDING"
  | "REPAIRING"
  | "PAUSED_MANUAL_REVIEW"
  | "FAILED"
  | "EXPIRED";

export type FundingArbitrageLegExecutionStatus =
  | "NOT_STARTED"
  | "PENDING_SUBMIT"
  | "ACTIVE"
  | "PENDING_CANCEL"
  | "TERMINAL"
  | "PENDING_RECONCILIATION";

export type FundingArbitrageRemoteObservation =
  | "UNKNOWN_REMOTE_STATE"
  | "REMOTE_NOT_FOUND"
  | "OPEN"
  | "FILLED"
  | "CANCELED"
  | "REJECTED";

export type FundingArbitrageLegExecutionState = Readonly<{
  legId: string;
  intentId: string;
  role: "long" | "short";
  plannedQuantity: string;
  confirmedExecutedQuantity: string;
  remainingQuantity: string;
  status: FundingArbitrageLegExecutionStatus;
  remoteObservation: FundingArbitrageRemoteObservation | null;
}>;

type LegQuantities = Readonly<{
  long: string;
  short: string;
}>;

export type FundingArbitrageResidualExposure = Readonly<{
  plannedQuantity: LegQuantities;
  executedQuantity: LegQuantities;
  residualQuantity: string;
  calculatedAt: number;
}>;

export type FundingArbitrageExecutionState = Readonly<{
  intentId: string;
  sourcePlanId: string;
  strategyType: FundingArbitrageStrategyType;
  status: FundingArbitrageAggregateExecutionStatus;
  legs: readonly [FundingArbitrageLegExecutionState, FundingArbitrageLegExecutionState];
  residualExposure: FundingArbitrageResidualExposure;
  createdAt: number;
  updatedAt: number;
}>;

export type FundingArbitrageLegExecutionUpdate = Readonly<{
  legId: string;
  confirmedExecutedQuantity: string;
  status: FundingArbitrageLegExecutionStatus;
  remoteObservation: FundingArbitrageRemoteObservation | null;
  observedAt: number;
}>;

export function createFundingArbitrageExecutionState(
  intent: FundingArbitrageExecutionIntent,
  createdAt: number,
): FundingArbitrageExecutionState {
  assertTimestamp(createdAt, "Execution state creation time");
  const longLeg = toInitialLeg(intent.intentId, intent.legs[0]);
  const shortLeg = toInitialLeg(intent.intentId, intent.legs[1]);
  const legs = [longLeg, shortLeg] as const;

  return {
    intentId: intent.intentId,
    sourcePlanId: intent.sourcePlanId,
    strategyType: intent.strategyType,
    status: "CREATED",
    legs,
    residualExposure: calculateResidualExposure(legs, createdAt),
    createdAt,
    updatedAt: createdAt,
  };
}

export function updateFundingArbitrageLegExecution(
  state: FundingArbitrageExecutionState,
  update: FundingArbitrageLegExecutionUpdate,
): FundingArbitrageExecutionState {
  assertTimestamp(update.observedAt, "Execution observation time");
  if (update.observedAt < state.updatedAt) {
    throw new Error("Execution observations cannot move state time backwards.");
  }
  const confirmedExecutedQuantity = normalizeUnsignedDecimal(update.confirmedExecutedQuantity);
  const legIndex = state.legs.findIndex((leg) => leg.legId === update.legId);
  if (legIndex === -1) throw new Error(`Execution leg does not belong to intent: ${update.legId}.`);

  const currentLeg = state.legs[legIndex]!;
  const plannedComparison = alignDecimals(confirmedExecutedQuantity, currentLeg.plannedQuantity);
  if (plannedComparison.left > plannedComparison.right) {
    throw new Error("Confirmed executed quantity cannot exceed the planned quantity.");
  }
  const updatedLeg: FundingArbitrageLegExecutionState = {
    ...currentLeg,
    confirmedExecutedQuantity,
    remainingQuantity: subtractFloorZero(currentLeg.plannedQuantity, confirmedExecutedQuantity),
    status: update.status,
    remoteObservation: update.remoteObservation,
  };
  const legs = (legIndex === 0
    ? [updatedLeg, state.legs[1]]
    : [state.legs[0], updatedLeg]) as readonly [
      FundingArbitrageLegExecutionState,
      FundingArbitrageLegExecutionState,
    ];
  const residualExposure = calculateResidualExposure(legs, update.observedAt);

  return {
    ...state,
    status: deriveAggregateStatus(legs, residualExposure),
    legs,
    residualExposure,
    updatedAt: update.observedAt,
  };
}

function toInitialLeg(
  intentId: string,
  leg: FundingArbitrageExecutionIntent["legs"][number],
): FundingArbitrageLegExecutionState {
  const plannedQuantity = normalizePositiveDecimal(leg.targetDeltaBaseQuantity);
  return {
    legId: leg.legId,
    intentId,
    role: leg.role,
    plannedQuantity,
    confirmedExecutedQuantity: "0",
    remainingQuantity: plannedQuantity,
    status: "NOT_STARTED",
    remoteObservation: null,
  };
}

function calculateResidualExposure(
  legs: readonly [FundingArbitrageLegExecutionState, FundingArbitrageLegExecutionState],
  calculatedAt: number,
): FundingArbitrageResidualExposure {
  const longLeg = legs.find((leg) => leg.role === "long");
  const shortLeg = legs.find((leg) => leg.role === "short");
  if (!longLeg || !shortLeg) throw new Error("Execution state requires one long leg and one short leg.");
  return {
    plannedQuantity: {
      long: longLeg.plannedQuantity,
      short: shortLeg.plannedQuantity,
    },
    executedQuantity: {
      long: longLeg.confirmedExecutedQuantity,
      short: shortLeg.confirmedExecutedQuantity,
    },
    residualQuantity: absoluteDifference(
      longLeg.confirmedExecutedQuantity,
      shortLeg.confirmedExecutedQuantity,
    ),
    calculatedAt,
  };
}

function deriveAggregateStatus(
  legs: readonly [FundingArbitrageLegExecutionState, FundingArbitrageLegExecutionState],
  exposure: FundingArbitrageResidualExposure,
): FundingArbitrageAggregateExecutionStatus {
  if (legs.some((leg) => leg.status === "PENDING_RECONCILIATION"
    || leg.remoteObservation === "UNKNOWN_REMOTE_STATE")) {
    return "PENDING_RECONCILIATION";
  }
  if (exposure.residualQuantity !== "0") return "RESIDUAL";
  if (legs.every((leg) => leg.remainingQuantity === "0"
    && leg.status === "TERMINAL"
    && leg.remoteObservation !== null
    && leg.remoteObservation !== "OPEN"
    && leg.remoteObservation !== "UNKNOWN_REMOTE_STATE")) {
    return "HEDGED";
  }
  if (legs.every((leg) => leg.status === "NOT_STARTED")) return "CREATED";
  return "EXECUTING";
}

function normalizePositiveDecimal(value: string) {
  const normalized = normalizeUnsignedDecimal(value);
  if (normalized === "0") throw new Error("Planned execution quantity must be positive.");
  return normalized;
}

function normalizeUnsignedDecimal(value: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Execution quantities must be unsigned decimal strings.");
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
}

function subtractFloorZero(left: string, right: string) {
  const aligned = alignDecimals(left, right);
  return aligned.left <= aligned.right
    ? "0"
    : formatScaledInteger(aligned.left - aligned.right, aligned.scale);
}

function absoluteDifference(left: string, right: string) {
  const aligned = alignDecimals(left, right);
  const difference = aligned.left >= aligned.right
    ? aligned.left - aligned.right
    : aligned.right - aligned.left;
  return formatScaledInteger(difference, aligned.scale);
}

function alignDecimals(left: string, right: string) {
  const parsedLeft = parseDecimal(left);
  const parsedRight = parseDecimal(right);
  const scale = Math.max(parsedLeft.scale, parsedRight.scale);
  return {
    left: parsedLeft.value * 10n ** BigInt(scale - parsedLeft.scale),
    right: parsedRight.value * 10n ** BigInt(scale - parsedRight.scale),
    scale,
  };
}

function parseDecimal(value: string) {
  const normalized = normalizeUnsignedDecimal(value);
  const [integer, fraction = ""] = normalized.split(".");
  return {
    value: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

function formatScaledInteger(value: bigint, scale: number) {
  if (value === 0n) return "0";
  const digits = value.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function assertTimestamp(value: number, label: string) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer timestamp.`);
  }
}
