import type { ExecutionIntent } from "./ExecutionIntent";

export type ExecutionStatus =
  | "CREATED"
  | "SUBMITTED"
  | "PENDING_CONFIRMATION"
  | "CONFIRMED"
  | "FAILED"
  | "UNKNOWN";

export type ExecutionState = Readonly<{
  intentId: string;
  userId: string;
  venue: ExecutionIntent["venue"];
  accountId: string;
  instrumentId: string;
  status: ExecutionStatus;
  createdAt: number;
  updatedAt: number;
}>;

export type ExecutionStateEvent =
  | Readonly<{ type: "SUBMISSION_STARTED"; occurredAt: number }>
  | Readonly<{ type: "SUBMISSION_ACCEPTED"; occurredAt: number }>
  | Readonly<{ type: "REMOTE_PENDING"; occurredAt: number }>
  | Readonly<{ type: "REMOTE_CONFIRMED"; occurredAt: number }>
  | Readonly<{ type: "REMOTE_FAILED"; occurredAt: number }>
  | Readonly<{ type: "REMOTE_UNKNOWN"; occurredAt: number }>;

export function createExecutionState(intent: ExecutionIntent): ExecutionState {
  return Object.freeze({
    intentId: intent.intentId,
    userId: intent.userId,
    venue: intent.venue,
    accountId: intent.accountId,
    instrumentId: intent.instrumentId,
    status: "CREATED",
    createdAt: intent.createdAt,
    updatedAt: intent.createdAt,
  });
}

export function transitionExecutionState(
  state: ExecutionState,
  event: ExecutionStateEvent,
): ExecutionState {
  assertTimestamp(event.occurredAt);
  if (event.occurredAt < state.updatedAt) {
    throw new Error("Execution state time cannot move backwards.");
  }

  const status = nextStatus(state.status, event.type);
  return Object.freeze({
    ...state,
    status,
    updatedAt: event.occurredAt,
  });
}

function nextStatus(
  status: ExecutionStatus,
  event: ExecutionStateEvent["type"],
): ExecutionStatus {
  if (event === "SUBMISSION_STARTED" && status === "CREATED") return "SUBMITTED";
  if (event === "SUBMISSION_ACCEPTED" && status === "SUBMITTED") return "PENDING_CONFIRMATION";
  if (event === "REMOTE_PENDING" && isAwaitingRemoteFact(status)) return "PENDING_CONFIRMATION";
  if (event === "REMOTE_UNKNOWN" && isAwaitingRemoteFact(status)) {
    return "UNKNOWN";
  }
  if (event === "REMOTE_CONFIRMED" && isAwaitingRemoteFact(status)) return "CONFIRMED";
  if (event === "REMOTE_FAILED" && isAwaitingRemoteFact(status)) return "FAILED";
  throw new Error(`Execution state ${status} does not accept ${event}.`);
}

function isAwaitingRemoteFact(status: ExecutionStatus) {
  return status === "CREATED" || status === "SUBMITTED" || status === "PENDING_CONFIRMATION" || status === "UNKNOWN";
}

function assertTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Execution state event time must be a non-negative integer timestamp.");
  }
}
