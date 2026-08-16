export type OkxExecutionOrderReference = Readonly<{
  executionId: string;
  intentId: string;
  userId: string;
  accountId: string;
  instrumentId: string;
  instId: string;
  ordId: string;
  clOrdId: string;
  createdAt: number;
  updatedAt: number;
}>;

export interface OkxExecutionOrderReferenceStore {
  create(reference: OkxExecutionOrderReference): Promise<void> | void;
  loadForUser(userId: string, executionId: string): Promise<OkxExecutionOrderReference | null> | OkxExecutionOrderReference | null;
}

export function createOkxExecutionOrderReference(input: unknown): OkxExecutionOrderReference {
  const value = object(input, "OkxExecutionOrderReference");
  assertExactKeys(value, [
    "executionId",
    "intentId",
    "userId",
    "accountId",
    "instrumentId",
    "instId",
    "ordId",
    "clOrdId",
    "createdAt",
    "updatedAt",
  ], "OkxExecutionOrderReference");
  const createdAt = timestamp(value.createdAt, "createdAt");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("updatedAt must be at or after createdAt.");

  return Object.freeze({
    executionId: identifier(value.executionId, "executionId"),
    intentId: identifier(value.intentId, "intentId"),
    userId: identifier(value.userId, "userId"),
    accountId: identifier(value.accountId, "accountId"),
    instrumentId: canonicalInstrumentId(value.instrumentId),
    instId: okxInstId(value.instId),
    ordId: okxOrdId(value.ordId),
    clOrdId: okxClOrdId(value.clOrdId),
    createdAt,
    updatedAt,
  });
}

export class InMemoryOkxExecutionOrderReferenceStore implements OkxExecutionOrderReferenceStore {
  private readonly references = new Map<string, OkxExecutionOrderReference>();

  create(reference: OkxExecutionOrderReference) {
    const normalized = createOkxExecutionOrderReference(reference);
    const key = referenceKey(normalized.userId, normalized.executionId);
    if (this.references.has(key)) throw new Error("OKX execution order reference already exists.");
    this.references.set(key, normalized);
  }

  loadForUser(userId: string, executionId: string) {
    return this.references.get(referenceKey(identifier(userId, "userId"), identifier(executionId, "executionId"))) ?? null;
  }
}

function referenceKey(userId: string, executionId: string) {
  return `${userId}\u0000${executionId}`;
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
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 200) throw new Error(`${name} is invalid.`);
  return text;
}

function canonicalInstrumentId(value: unknown) {
  const text = identifier(value, "instrumentId");
  if (!/^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}-(?:SPOT|PERP)$/u.test(text)) {
    throw new Error("instrumentId must be a canonical instrument id.");
  }
  return text;
}

function okxInstId(value: unknown) {
  const text = identifier(value, "instId");
  if (!/^[A-Z0-9]{2,12}-USDT-SWAP$/u.test(text)) throw new Error("instId must be an OKX USDT swap id.");
  return text;
}

function okxOrdId(value: unknown) {
  const text = identifier(value, "ordId");
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) throw new Error("ordId must be an OKX order id.");
  return text;
}

function okxClOrdId(value: unknown) {
  const text = identifier(value, "clOrdId");
  if (!/^[A-Za-z0-9]{1,32}$/u.test(text)) throw new Error("clOrdId must be an OKX client order id.");
  return text;
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}
