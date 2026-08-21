import type { ExecutionOrderReferenceAssociation, ExecutionOrderReferenceStore } from "../cex/ExecutionOrderReferenceStore";
import type { BitgetCategory, BitgetOrderSide } from "./BitgetTypes";

type ExpectedOrderFacts = Readonly<{
  expectedProviderQuantity: string;
  expectedSide: BitgetOrderSide;
}>;

export type BitgetExecutionOrderReference = Readonly<{
  executionId: string;
  intentId: string;
  userId: string;
  accountId: string;
  instrumentId: string;
  category: BitgetCategory;
  symbol: string;
  orderId: string;
  clientOid: string;
  createdAt: number;
  updatedAt: number;
} & ExpectedOrderFacts>;

export type BitgetExecutionOrderRecoveryReference = Readonly<Omit<BitgetExecutionOrderReference, "orderId">>;

export interface BitgetExecutionOrderReferenceStore {
  create(reference: BitgetExecutionOrderReference): Promise<void> | void;
  createRecovery(reference: BitgetExecutionOrderRecoveryReference): Promise<void> | void;
  loadForUser(userId: string, executionId: string): Promise<BitgetExecutionOrderReference | null> | BitgetExecutionOrderReference | null;
  loadRecoveryForUser(userId: string, executionId: string): Promise<BitgetExecutionOrderRecoveryReference | null> | BitgetExecutionOrderRecoveryReference | null;
}

export function createBitgetExecutionOrderReference(input: unknown): BitgetExecutionOrderReference {
  const value = object(input, "BitgetExecutionOrderReference");
  exactKeys(value, [...commonKeys, "orderId"], "BitgetExecutionOrderReference");
  return Object.freeze({ ...normalizeCommon(value), orderId: identifier(value.orderId, "orderId") });
}

export function createBitgetExecutionOrderRecoveryReference(input: unknown): BitgetExecutionOrderRecoveryReference {
  const value = object(input, "BitgetExecutionOrderRecoveryReference");
  exactKeys(value, commonKeys, "BitgetExecutionOrderRecoveryReference");
  return Object.freeze(normalizeCommon(value));
}

export class InMemoryBitgetExecutionOrderReferenceStore implements BitgetExecutionOrderReferenceStore {
  private readonly values = new Map<string, Stored>();

  create(reference: BitgetExecutionOrderReference) {
    const normalized = createBitgetExecutionOrderReference(reference);
    const key = referenceKey(normalized.userId, normalized.executionId);
    const existing = this.values.get(key);
    if (existing?.kind === "complete") throw new Error("Bitget execution order reference already exists.");
    if (existing) assertRecoveryMatches(existing.value, normalized);
    this.values.set(key, { kind: "complete", value: normalized });
  }

  createRecovery(reference: BitgetExecutionOrderRecoveryReference) {
    const normalized = createBitgetExecutionOrderRecoveryReference(reference);
    const key = referenceKey(normalized.userId, normalized.executionId);
    if (this.values.has(key)) throw new Error("Bitget execution order recovery reference already exists.");
    this.values.set(key, { kind: "recovery", value: normalized });
  }

  loadForUser(userId: string, executionId: string) {
    const stored = this.values.get(referenceKey(identifier(userId, "userId"), identifier(executionId, "executionId")));
    return stored?.kind === "complete" ? stored.value : null;
  }

  loadRecoveryForUser(userId: string, executionId: string) {
    const stored = this.values.get(referenceKey(identifier(userId, "userId"), identifier(executionId, "executionId")));
    return stored?.kind === "recovery" ? stored.value : null;
  }
}

export class PersistentBitgetExecutionOrderReferenceStore implements BitgetExecutionOrderReferenceStore {
  constructor(private readonly references: ExecutionOrderReferenceStore) {}

  async create(reference: BitgetExecutionOrderReference) {
    const normalized = createBitgetExecutionOrderReference(reference);
    const association = completeAssociation(normalized);
    const existing = await this.references.loadForUser(normalized.userId, normalized.executionId, "bitget");
    if (!existing) return void await this.references.create(association);
    const stored = parsePayload(existing.referencePayload);
    if (stored.kind === "complete") throw new Error("Bitget execution order reference already exists.");
    assertRecoveryMatches(recoveryFromAssociation(existing, stored.payload), normalized);
    await this.references.replace(association);
  }

  async createRecovery(reference: BitgetExecutionOrderRecoveryReference) {
    await this.references.create(recoveryAssociation(createBitgetExecutionOrderRecoveryReference(reference)));
  }

  async loadForUser(userId: string, executionId: string) {
    const association = await this.references.loadForUser(userId, executionId, "bitget");
    if (!association) return null;
    const stored = parsePayload(association.referencePayload);
    return stored.kind === "complete" ? completeFromAssociation(association, stored.payload) : null;
  }

  async loadRecoveryForUser(userId: string, executionId: string) {
    const association = await this.references.loadForUser(userId, executionId, "bitget");
    if (!association) return null;
    const stored = parsePayload(association.referencePayload);
    return stored.kind === "recovery" ? recoveryFromAssociation(association, stored.payload) : null;
  }
}

const commonKeys = [
  "executionId", "intentId", "userId", "accountId", "instrumentId", "category", "symbol", "clientOid",
  "expectedProviderQuantity", "expectedSide", "createdAt", "updatedAt",
] as const;

type Stored =
  | Readonly<{ kind: "complete"; value: BitgetExecutionOrderReference }>
  | Readonly<{ kind: "recovery"; value: BitgetExecutionOrderRecoveryReference }>;

function normalizeCommon(value: Record<string, unknown>) {
  const createdAt = timestamp(value.createdAt, "createdAt");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("updatedAt must be at or after createdAt.");
  return {
    executionId: identifier(value.executionId, "executionId"), intentId: identifier(value.intentId, "intentId"),
    userId: identifier(value.userId, "userId"), accountId: identifier(value.accountId, "accountId"),
    instrumentId: instrumentId(value.instrumentId), category: category(value.category), symbol: symbol(value.symbol),
    clientOid: clientOid(value.clientOid), expectedProviderQuantity: positiveDecimal(value.expectedProviderQuantity),
    expectedSide: side(value.expectedSide), createdAt, updatedAt,
  } as const;
}

function completeAssociation(reference: BitgetExecutionOrderReference): ExecutionOrderReferenceAssociation {
  return association(reference, { orderId: reference.orderId });
}
function recoveryAssociation(reference: BitgetExecutionOrderRecoveryReference): ExecutionOrderReferenceAssociation {
  return association(reference, { recovery: "clientOid" });
}
function association(reference: BitgetExecutionOrderRecoveryReference, extra: Record<string, string>): ExecutionOrderReferenceAssociation {
  return {
    executionId: reference.executionId, userId: reference.userId, venue: "bitget",
    referencePayload: JSON.stringify({
      ...extra, intentId: reference.intentId, accountId: reference.accountId, instrumentId: reference.instrumentId,
      category: reference.category, symbol: reference.symbol, clientOid: reference.clientOid,
      expectedProviderQuantity: reference.expectedProviderQuantity, expectedSide: reference.expectedSide,
    }),
    createdAt: reference.createdAt, updatedAt: reference.updatedAt,
  };
}
function parsePayload(input: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { throw new Error("Persisted Bitget execution order reference is invalid."); }
  const value = object(parsed, "Persisted Bitget execution order reference");
  const recovery = value.recovery !== undefined;
  exactKeys(value, recovery
    ? ["recovery", "intentId", "accountId", "instrumentId", "category", "symbol", "clientOid", "expectedProviderQuantity", "expectedSide"]
    : ["orderId", "intentId", "accountId", "instrumentId", "category", "symbol", "clientOid", "expectedProviderQuantity", "expectedSide"],
  recovery ? "Persisted Bitget recovery reference" : "Persisted Bitget order reference");
  if (recovery && value.recovery !== "clientOid") throw new Error("Persisted Bitget recovery strategy is invalid.");
  return recovery ? { kind: "recovery" as const, payload: value } : { kind: "complete" as const, payload: value };
}
function completeFromAssociation(association: ExecutionOrderReferenceAssociation, payload: Record<string, unknown>) {
  return createBitgetExecutionOrderReference({ executionId: association.executionId, userId: association.userId, ...payload,
    createdAt: association.createdAt, updatedAt: association.updatedAt });
}
function recoveryFromAssociation(association: ExecutionOrderReferenceAssociation, payload: Record<string, unknown>) {
  const { recovery: _recovery, ...reference } = payload;
  return createBitgetExecutionOrderRecoveryReference({ executionId: association.executionId, userId: association.userId, ...reference,
    createdAt: association.createdAt, updatedAt: association.updatedAt });
}
function assertRecoveryMatches(recovery: BitgetExecutionOrderRecoveryReference, complete: BitgetExecutionOrderReference) {
  for (const key of commonKeys) if (recovery[key] !== complete[key]) {
    throw new Error("Bitget completed order reference does not match its recovery reference.");
  }
}
function referenceKey(userId: string, executionId: string) { return `${userId}\u0000${executionId}`; }
function object(value: unknown, name: string) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string) { const keys = new Set(allowed); const unknown = Object.keys(value).find((key) => !keys.has(key)); if (unknown) throw new Error(`${name} contains unsupported field: ${unknown}.`); }
function identifier(value: unknown, name: string) { if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error(`${name} is invalid.`); return value.trim(); }
function instrumentId(value: unknown) { const id = identifier(value, "instrumentId"); if (!/^[A-Z0-9]{2,12}-USDT-(?:SPOT|PERP)$/u.test(id)) throw new Error("Bitget instrumentId is invalid."); return id; }
function category(value: unknown): BitgetCategory { if (value !== "SPOT" && value !== "USDT-FUTURES") throw new Error("Bitget category is invalid."); return value; }
function symbol(value: unknown) { const text = identifier(value, "symbol"); if (!/^[A-Z0-9]{4,24}$/u.test(text)) throw new Error("Bitget symbol is invalid."); return text; }
function clientOid(value: unknown) { const id = identifier(value, "clientOid"); if (!/^[A-Za-z0-9_-]{1,32}$/u.test(id)) throw new Error("Bitget clientOid is invalid."); return id; }
function positiveDecimal(value: unknown) { if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) throw new Error("expectedProviderQuantity is invalid."); return value; }
function side(value: unknown): BitgetOrderSide { if (value !== "buy" && value !== "sell") throw new Error("Bitget expectedSide is invalid."); return value; }
function timestamp(value: unknown, name: string) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid.`); return value; }
