import type { ExecutionIntent } from "./ExecutionIntent";
import type { ExecutionState, ExecutionStatus } from "./ExecutionState";

export type ExecutionRecord = Readonly<{
  executionId: string;
  intentId: string;
  executionAttemptId?: string;
  userId: string;
  venue: ExecutionIntent["venue"];
  accountId: string;
  instrumentId: string;
  status: ExecutionStatus;
  remoteOrderId?: string;
  createdAt: number;
  updatedAt: number;
}>;

export function createExecutionRecord(input: unknown): ExecutionRecord {
  const value = object(input, "ExecutionRecord");
  assertExactKeys(value, [
    "executionId",
    "intentId",
    "executionAttemptId",
    "userId",
    "venue",
    "accountId",
    "instrumentId",
    "status",
    "remoteOrderId",
    "createdAt",
    "updatedAt",
  ], "ExecutionRecord");
  const createdAt = timestamp(value.createdAt, "createdAt");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("updatedAt must be at or after createdAt.");

  return freezeRecord({
    executionId: identifier(value.executionId, "executionId"),
    intentId: identifier(value.intentId, "intentId"),
    ...(value.executionAttemptId === undefined ? {} : { executionAttemptId: identifier(value.executionAttemptId, "executionAttemptId") }),
    userId: identifier(value.userId, "userId"),
    venue: venue(value.venue),
    accountId: identifier(value.accountId, "accountId"),
    instrumentId: instrumentId(value.instrumentId),
    status: status(value.status),
    ...(value.remoteOrderId === undefined ? {} : { remoteOrderId: identifier(value.remoteOrderId, "remoteOrderId") }),
    createdAt,
    updatedAt,
  });
}

export function createExecutionRecordFromIntent(
  executionId: string,
  intent: ExecutionIntent,
): ExecutionRecord {
  return freezeRecord({
    executionId: identifier(executionId, "executionId"),
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

export function syncExecutionRecordState(
  record: ExecutionRecord,
  state: ExecutionState,
): ExecutionRecord {
  assertSameIdentity(record, state);
  return freezeRecord({
    ...record,
    status: state.status,
    updatedAt: state.updatedAt,
  });
}

export function attachExecutionAttempt(
  record: ExecutionRecord,
  input: Readonly<{
    executionAttemptId: string;
    remoteOrderId?: string;
    status: ExecutionStatus;
    observedAt: number;
  }>,
): ExecutionRecord {
  const observedAt = timestamp(input.observedAt, "observedAt");
  if (observedAt < record.updatedAt) throw new Error("execution record time cannot move backwards.");
  return freezeRecord({
    ...record,
    executionAttemptId: identifier(input.executionAttemptId, "executionAttemptId"),
    ...(input.remoteOrderId === undefined ? {} : { remoteOrderId: identifier(input.remoteOrderId, "remoteOrderId") }),
    status: status(input.status),
    updatedAt: observedAt,
  });
}

function assertSameIdentity(record: ExecutionRecord, state: ExecutionState) {
  if (
    record.intentId !== state.intentId
    || record.userId !== state.userId
    || record.venue !== state.venue
    || record.accountId !== state.accountId
    || record.instrumentId !== state.instrumentId
  ) {
    throw new Error("execution record and state identity do not match.");
  }
}

function freezeRecord(input: ExecutionRecord): ExecutionRecord {
  return Object.freeze(input);
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

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function venue(value: unknown): ExecutionIntent["venue"] {
  if (value !== "binance" && value !== "okx" && value !== "bybit" && value !== "bitget") {
    throw new Error("venue must be binance, okx, bybit, or bitget.");
  }
  return value;
}

function instrumentId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}-(?:SPOT|PERP)$/u.test(value)) {
    throw new Error("instrumentId must be a canonical instrument id.");
  }
  return value;
}

function status(value: unknown): ExecutionStatus {
  if (
    value !== "CREATED"
    && value !== "SUBMITTED"
    && value !== "PENDING_CONFIRMATION"
    && value !== "CONFIRMED"
    && value !== "FAILED"
    && value !== "UNKNOWN"
  ) {
    throw new Error("status must be an ExecutionState status.");
  }
  return value;
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}
