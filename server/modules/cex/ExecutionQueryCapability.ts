import { createExecutionRecord, syncExecutionRecordState, type ExecutionRecord } from "./ExecutionRecord";
import { transitionExecutionState, type ExecutionStateEvent } from "./ExecutionState";

export type ExecutionQueryObservation = Readonly<{
  state: "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED" | "UNKNOWN";
  filledBaseQuantity: string;
  observedAt: number;
}>;

export interface ExecutionQueryCapability {
  query(record: ExecutionRecord): Promise<ExecutionQueryObservation>;
}

export function createExecutionQueryObservation(input: unknown): ExecutionQueryObservation {
  const value = object(input, "ExecutionQueryObservation");
  assertExactKeys(value, ["state", "filledBaseQuantity", "observedAt"], "ExecutionQueryObservation");
  if (
    value.state !== "CONFIRMED"
    && value.state !== "PENDING_CONFIRMATION"
    && value.state !== "FAILED"
    && value.state !== "UNKNOWN"
  ) {
    throw new Error("ExecutionQueryObservation state is invalid.");
  }
  if (typeof value.filledBaseQuantity !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value.filledBaseQuantity)) {
    throw new Error("filledBaseQuantity must be an unsigned decimal string.");
  }
  if (typeof value.observedAt !== "number" || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0) {
    throw new Error("observedAt must be a non-negative integer timestamp.");
  }
  return Object.freeze({
    state: value.state,
    filledBaseQuantity: value.filledBaseQuantity,
    observedAt: value.observedAt,
  });
}

export function applyExecutionQueryObservation(
  record: ExecutionRecord,
  observationInput: ExecutionQueryObservation,
): ExecutionRecord {
  const observation = createExecutionQueryObservation(observationInput);
  if (observation.observedAt < record.updatedAt) {
    throw new Error("Execution query observation cannot move record time backwards.");
  }
  if (record.status === observation.state) {
    return createExecutionRecord({ ...record, updatedAt: observation.observedAt });
  }

  const event: ExecutionStateEvent = {
    type: eventTypeFor(observation.state),
    occurredAt: observation.observedAt,
  };
  return syncExecutionRecordState(record, transitionExecutionState(record, event));
}

function eventTypeFor(state: ExecutionQueryObservation["state"]): ExecutionStateEvent["type"] {
  if (state === "CONFIRMED") return "REMOTE_CONFIRMED";
  if (state === "PENDING_CONFIRMATION") return "REMOTE_PENDING";
  if (state === "FAILED") return "REMOTE_FAILED";
  return "REMOTE_UNKNOWN";
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
