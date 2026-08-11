import { createExecutionRecord, syncExecutionRecordState, type ExecutionRecord } from "./ExecutionRecord";
import { transitionExecutionState } from "./ExecutionState";

export type ExecutionCancelObservation = Readonly<{
  state: "CANCEL_REQUESTED" | "CANCELLED" | "UNKNOWN";
  observedAt: number;
}>;

export interface ExecutionCancelCapability {
  cancel(record: ExecutionRecord): Promise<ExecutionCancelObservation>;
}

export function createExecutionCancelObservation(input: unknown): ExecutionCancelObservation {
  const value = object(input, "ExecutionCancelObservation");
  assertExactKeys(value, ["state", "observedAt"], "ExecutionCancelObservation");
  if (value.state !== "CANCEL_REQUESTED" && value.state !== "CANCELLED" && value.state !== "UNKNOWN") {
    throw new Error("ExecutionCancelObservation state is invalid.");
  }
  if (typeof value.observedAt !== "number" || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0) {
    throw new Error("observedAt must be a non-negative integer timestamp.");
  }
  return Object.freeze({ state: value.state, observedAt: value.observedAt });
}

export function applyExecutionCancelObservation(
  record: ExecutionRecord,
  observationInput: ExecutionCancelObservation,
): ExecutionRecord {
  const observation = createExecutionCancelObservation(observationInput);
  if (observation.observedAt < record.updatedAt) {
    throw new Error("Execution cancel observation cannot move record time backwards.");
  }
  if (record.status !== "PENDING_CONFIRMATION" && record.status !== "UNKNOWN") {
    throw new Error(`Execution record ${record.status} cannot accept cancellation.`);
  }
  if (observation.state === "CANCEL_REQUESTED") {
    return createExecutionRecord({ ...record, updatedAt: observation.observedAt });
  }
  const state = transitionExecutionState(record, {
    type: observation.state === "CANCELLED" ? "REMOTE_FAILED" : "REMOTE_UNKNOWN",
    occurredAt: observation.observedAt,
  });
  return syncExecutionRecordState(record, state);
}

function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`${name} contains unsupported field: ${unknown}.`);
}
