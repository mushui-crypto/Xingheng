import type { FundingArbitrageExecutionIntent } from "./FundingArbitrageExecutionIntent";
import {
  createFundingArbitrageExecutionState,
  type FundingArbitrageExecutionState,
  type FundingArbitrageRemoteObservation,
  updateFundingArbitrageLegExecution,
} from "./FundingArbitrageExecutionState";

type ResolvedRemoteObservation = Exclude<FundingArbitrageRemoteObservation, "UNKNOWN_REMOTE_STATE">;

export type FundingArbitrageExecutionEvent =
  | Readonly<{ type: "START_EXECUTION"; occurredAt: number }>
  | Readonly<{ type: "LEG_SUBMIT_STARTED"; legId: string; occurredAt: number }>
  | Readonly<{
    type: "LEG_CONFIRMED_FILLED";
    legId: string;
    confirmedExecutedQuantity: string;
    occurredAt: number;
  }>
  | Readonly<{
    type: "LEG_CONFIRMED_PARTIAL";
    legId: string;
    confirmedExecutedQuantity: string;
    occurredAt: number;
  }>
  | Readonly<{ type: "LEG_REMOTE_UNKNOWN"; legId: string; occurredAt: number }>
  | Readonly<{
    type: "LEG_RECONCILIATION_RESOLVED";
    legId: string;
    confirmedExecutedQuantity: string;
    remoteObservation: ResolvedRemoteObservation;
    occurredAt: number;
  }>
  | Readonly<{ type: "MARK_COMPLETE"; occurredAt: number }>
  | Readonly<{ type: "MARK_FAILED"; occurredAt: number }>;

export class FundingArbitrageExecutionCoordinator {
  createExecution(intent: FundingArbitrageExecutionIntent): FundingArbitrageExecutionState {
    return createFundingArbitrageExecutionState(intent, intent.createdAt);
  }

  transition(
    state: FundingArbitrageExecutionState,
    event: FundingArbitrageExecutionEvent,
  ): FundingArbitrageExecutionState {
    assertEventTime(state, event.occurredAt);

    switch (event.type) {
      case "START_EXECUTION":
        if (state.status !== "CREATED") {
          throw new Error(`Execution can only start from CREATED, received ${state.status}.`);
        }
        return { ...state, status: "EXECUTING", updatedAt: event.occurredAt };

      case "LEG_SUBMIT_STARTED":
        assertExecutionStarted(state);
        return updateFundingArbitrageLegExecution(state, {
          legId: event.legId,
          confirmedExecutedQuantity: confirmedQuantityFor(state, event.legId),
          status: "PENDING_SUBMIT",
          remoteObservation: null,
          observedAt: event.occurredAt,
        });

      case "LEG_CONFIRMED_FILLED":
        assertExecutionStarted(state);
        return updateFundingArbitrageLegExecution(state, {
          legId: event.legId,
          confirmedExecutedQuantity: event.confirmedExecutedQuantity,
          status: "TERMINAL",
          remoteObservation: "FILLED",
          observedAt: event.occurredAt,
        });

      case "LEG_CONFIRMED_PARTIAL":
        assertExecutionStarted(state);
        return updateFundingArbitrageLegExecution(state, {
          legId: event.legId,
          confirmedExecutedQuantity: event.confirmedExecutedQuantity,
          status: "ACTIVE",
          remoteObservation: "OPEN",
          observedAt: event.occurredAt,
        });

      case "LEG_REMOTE_UNKNOWN":
        assertExecutionStarted(state);
        return updateFundingArbitrageLegExecution(state, {
          legId: event.legId,
          confirmedExecutedQuantity: confirmedQuantityFor(state, event.legId),
          status: "PENDING_RECONCILIATION",
          remoteObservation: "UNKNOWN_REMOTE_STATE",
          observedAt: event.occurredAt,
        });

      case "LEG_RECONCILIATION_RESOLVED":
        assertExecutionStarted(state);
        return updateFundingArbitrageLegExecution(state, {
          legId: event.legId,
          confirmedExecutedQuantity: event.confirmedExecutedQuantity,
          status: legStatusForResolvedObservation(event.remoteObservation),
          remoteObservation: event.remoteObservation,
          observedAt: event.occurredAt,
        });

      case "MARK_COMPLETE":
        if (!hasConfirmedHedge(state)) {
          throw new Error("Execution cannot complete without a confirmed quantity hedge.");
        }
        return { ...state, status: "HEDGED", updatedAt: event.occurredAt };

      case "MARK_FAILED":
        if (state.status === "PENDING_RECONCILIATION"
          || state.legs.some((leg) => leg.remoteObservation === "UNKNOWN_REMOTE_STATE")) {
          throw new Error("Unknown remote state cannot transition directly to FAILED.");
        }
        if (state.status === "HEDGED") throw new Error("A hedged execution cannot be marked FAILED.");
        return { ...state, status: "FAILED", updatedAt: event.occurredAt };
    }
  }
}

function confirmedQuantityFor(state: FundingArbitrageExecutionState, legId: string) {
  const leg = state.legs.find((candidate) => candidate.legId === legId);
  if (!leg) throw new Error(`Execution leg does not belong to intent: ${legId}.`);
  return leg.confirmedExecutedQuantity;
}

function legStatusForResolvedObservation(observation: ResolvedRemoteObservation) {
  return observation === "OPEN" ? "ACTIVE" as const : "TERMINAL" as const;
}

function hasConfirmedHedge(state: FundingArbitrageExecutionState) {
  return state.status === "HEDGED"
    && state.legs.every((leg) => leg.confirmedExecutedQuantity !== "0")
    && state.legs.every((leg) => leg.remoteObservation !== "UNKNOWN_REMOTE_STATE");
}

function assertExecutionStarted(state: FundingArbitrageExecutionState) {
  if (state.status === "CREATED") throw new Error("Execution must be started before leg events are accepted.");
  if (["HEDGED", "FAILED", "EXPIRED", "PAUSED_MANUAL_REVIEW"].includes(state.status)) {
    throw new Error(`Execution status ${state.status} does not accept leg events.`);
  }
}

function assertEventTime(state: FundingArbitrageExecutionState, occurredAt: number) {
  if (!Number.isFinite(occurredAt) || !Number.isInteger(occurredAt) || occurredAt < state.updatedAt) {
    throw new Error("Execution event time must be an integer at or after the current state time.");
  }
}
