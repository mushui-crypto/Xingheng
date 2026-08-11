import type { ExecutionIntent } from "./ExecutionIntent";
import type { ExecutionState, ExecutionStatus } from "./ExecutionState";

export type RemoteExecutionStatus = Exclude<ExecutionStatus, "CREATED">;

export type RemoteExecutionState = Readonly<{
  intentId: string;
  venue: ExecutionIntent["venue"];
  accountId: string;
  instrumentId: string;
  status: RemoteExecutionStatus;
  observedAt: number;
}>;

export type ExecutionReconciliationResult = Readonly<{
  intentId: string;
  status: "CONFIRMED" | "UNKNOWN";
  localStatus: ExecutionStatus;
  remoteStatus: RemoteExecutionStatus;
  reconciledAt: number;
}>;

export interface ExecutionReconciliation {
  reconcile(
    local: ExecutionState,
    remote: RemoteExecutionState,
  ): ExecutionReconciliationResult;
}

export class ExecutionStateReconciliation implements ExecutionReconciliation {
  reconcile(
    local: ExecutionState,
    remote: RemoteExecutionState,
  ): ExecutionReconciliationResult {
    assertTimestamp(remote.observedAt);
    const identityMatches = local.intentId === remote.intentId
      && local.venue === remote.venue
      && local.accountId === remote.accountId
      && local.instrumentId === remote.instrumentId;
    const stateMatches = remote.status !== "UNKNOWN"
      && local.status === remote.status
      && remote.observedAt >= local.updatedAt;

    return Object.freeze({
      intentId: local.intentId,
      status: identityMatches && stateMatches ? "CONFIRMED" : "UNKNOWN",
      localStatus: local.status,
      remoteStatus: remote.status,
      reconciledAt: remote.observedAt,
    });
  }
}

function assertTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Remote execution observation time must be a non-negative integer timestamp.");
  }
}
