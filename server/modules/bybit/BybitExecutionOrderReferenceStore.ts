import type { ExecutionOrderReferenceAssociation, ExecutionOrderReferenceStore } from "../cex/ExecutionOrderReferenceStore";
import type { BybitCategory, BybitMarketUnit, BybitOrderSide, BybitPositionIdx } from "./BybitTypes";

type ExpectedOrderFacts = Readonly<{
  expectedProviderQuantity: string;
  expectedSide: BybitOrderSide;
  marketUnit?: BybitMarketUnit;
  positionIdx?: BybitPositionIdx;
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
}>;

export type BybitExecutionOrderReference = Readonly<{
  executionId: string;
  intentId: string;
  userId: string;
  accountId: string;
  instrumentId: string;
  category: BybitCategory;
  symbol: string;
  orderId: string;
  orderLinkId: string;
  createdAt: number;
  updatedAt: number;
} & ExpectedOrderFacts>;

export type BybitExecutionOrderRecoveryReference = Readonly<{
  executionId: string;
  intentId: string;
  userId: string;
  accountId: string;
  instrumentId: string;
  category: BybitCategory;
  symbol: string;
  orderLinkId: string;
  createdAt: number;
  updatedAt: number;
} & ExpectedOrderFacts>;

export interface BybitExecutionOrderReferenceStore {
  create(reference: BybitExecutionOrderReference): Promise<void> | void;
  createRecovery(reference: BybitExecutionOrderRecoveryReference): Promise<void> | void;
  loadForUser(userId: string, executionId: string): Promise<BybitExecutionOrderReference | null> | BybitExecutionOrderReference | null;
  loadRecoveryForUser(userId: string, executionId: string): Promise<BybitExecutionOrderRecoveryReference | null> | BybitExecutionOrderRecoveryReference | null;
}

export function createBybitExecutionOrderReference(input: unknown): BybitExecutionOrderReference {
  const value = object(input, "BybitExecutionOrderReference");
  exactKeys(value, [
    "executionId", "intentId", "userId", "accountId", "instrumentId", "category", "symbol",
    "orderId", "orderLinkId", "expectedProviderQuantity", "expectedSide", "marketUnit", "positionIdx",
    "positionMode", "positionDirection",
    "createdAt", "updatedAt",
  ], "BybitExecutionOrderReference");
  return normalizeComplete(value);
}

export function createBybitExecutionOrderRecoveryReference(input: unknown): BybitExecutionOrderRecoveryReference {
  const value = object(input, "BybitExecutionOrderRecoveryReference");
  exactKeys(value, [
    "executionId", "intentId", "userId", "accountId", "instrumentId", "category", "symbol",
    "orderLinkId", "expectedProviderQuantity", "expectedSide", "marketUnit", "positionIdx", "createdAt", "updatedAt",
    "positionMode", "positionDirection",
  ], "BybitExecutionOrderRecoveryReference");
  return normalizeRecovery(value);
}

export class InMemoryBybitExecutionOrderReferenceStore implements BybitExecutionOrderReferenceStore {
  private readonly values = new Map<string, Stored>();

  create(reference: BybitExecutionOrderReference) {
    const normalized = createBybitExecutionOrderReference(reference);
    const key = referenceKey(normalized.userId, normalized.executionId);
    const existing = this.values.get(key);
    if (existing?.kind === "complete") throw new Error("Bybit execution order reference already exists.");
    if (existing) assertRecoveryMatches(existing.value, normalized);
    this.values.set(key, { kind: "complete", value: normalized });
  }

  createRecovery(reference: BybitExecutionOrderRecoveryReference) {
    const normalized = createBybitExecutionOrderRecoveryReference(reference);
    const key = referenceKey(normalized.userId, normalized.executionId);
    if (this.values.has(key)) throw new Error("Bybit execution order recovery reference already exists.");
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

export class PersistentBybitExecutionOrderReferenceStore implements BybitExecutionOrderReferenceStore {
  constructor(private readonly references: ExecutionOrderReferenceStore) {}

  async create(reference: BybitExecutionOrderReference) {
    const normalized = createBybitExecutionOrderReference(reference);
    const association = completeAssociation(normalized);
    const existing = await this.references.loadForUser(normalized.userId, normalized.executionId, "bybit");
    if (!existing) {
      await this.references.create(association);
      return;
    }
    const stored = parsePayload(existing.referencePayload);
    if (stored.kind === "complete") throw new Error("Bybit execution order reference already exists.");
    const recovery = recoveryFromAssociation(existing, stored.payload);
    assertRecoveryMatches(recovery, normalized);
    await this.references.replace(association);
  }

  async createRecovery(reference: BybitExecutionOrderRecoveryReference) {
    const normalized = createBybitExecutionOrderRecoveryReference(reference);
    await this.references.create(recoveryAssociation(normalized));
  }

  async loadForUser(userId: string, executionId: string) {
    const association = await this.references.loadForUser(userId, executionId, "bybit");
    if (!association) return null;
    const stored = parsePayload(association.referencePayload);
    return stored.kind === "complete" ? completeFromAssociation(association, stored.payload) : null;
  }

  async loadRecoveryForUser(userId: string, executionId: string) {
    const association = await this.references.loadForUser(userId, executionId, "bybit");
    if (!association) return null;
    const stored = parsePayload(association.referencePayload);
    return stored.kind === "recovery" ? recoveryFromAssociation(association, stored.payload) : null;
  }
}

type Stored =
  | Readonly<{ kind: "complete"; value: BybitExecutionOrderReference }>
  | Readonly<{ kind: "recovery"; value: BybitExecutionOrderRecoveryReference }>;

function normalizeComplete(value: Record<string, unknown>): BybitExecutionOrderReference {
  const common = normalizeCommon(value);
  return Object.freeze({ ...common, orderId: orderId(value.orderId) });
}

function normalizeRecovery(value: Record<string, unknown>): BybitExecutionOrderRecoveryReference {
  return Object.freeze(normalizeCommon(value));
}

function normalizeCommon(value: Record<string, unknown>) {
  const createdAt = timestamp(value.createdAt, "createdAt");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("updatedAt must be at or after createdAt.");
  const category = bybitCategory(value.category);
  const marketUnitValue = value.marketUnit === undefined ? undefined : marketUnit(value.marketUnit);
  const positionIdxValue = value.positionIdx === undefined ? undefined : positionIdx(value.positionIdx);
  if (category === "spot" && positionIdxValue !== undefined) throw new Error("Bybit Spot reference must not include positionIdx.");
  const mode = value.positionMode === undefined ? undefined : positionMode(value.positionMode);
  const direction = value.positionDirection === undefined ? undefined : positionDirection(value.positionDirection);
  if (category === "spot" && (positionIdxValue !== undefined || mode !== undefined || direction !== undefined)) {
    throw new Error("Bybit Spot reference must not contain position bucket facts.");
  }
  if (category === "linear" && (marketUnitValue !== undefined || (mode === "ONE_WAY" && positionIdxValue !== 0)
    || (mode === "HEDGE" && (positionIdxValue !== 1 && positionIdxValue !== 2)))) {
    throw new Error("Bybit Linear reference position facts do not match the persisted mode.");
  }
  if (category === "linear" && mode === "HEDGE" && direction !== undefined
    && positionIdxValue !== (direction === "LONG" ? 1 : 2)) {
    throw new Error("Bybit Linear reference bucket does not match positionDirection.");
  }
  return {
    executionId: identifier(value.executionId, "executionId"),
    intentId: identifier(value.intentId, "intentId"),
    userId: identifier(value.userId, "userId"),
    accountId: identifier(value.accountId, "accountId"),
    instrumentId: instrumentId(value.instrumentId),
    category,
    symbol: symbol(value.symbol),
    orderLinkId: orderLinkId(value.orderLinkId),
    expectedProviderQuantity: positiveDecimal(value.expectedProviderQuantity, "expectedProviderQuantity"),
    expectedSide: side(value.expectedSide),
    ...(marketUnitValue === undefined ? {} : { marketUnit: marketUnitValue }),
    ...(positionIdxValue === undefined ? {} : { positionIdx: positionIdxValue }),
    ...(mode === undefined ? {} : { positionMode: mode }),
    ...(direction === undefined ? {} : { positionDirection: direction }),
    createdAt,
    updatedAt,
  } as const;
}

function completeAssociation(reference: BybitExecutionOrderReference): ExecutionOrderReferenceAssociation {
  return {
    executionId: reference.executionId,
    userId: reference.userId,
    venue: "bybit",
    referencePayload: JSON.stringify({
      intentId: reference.intentId,
      accountId: reference.accountId,
      instrumentId: reference.instrumentId,
      category: reference.category,
      symbol: reference.symbol,
      orderId: reference.orderId,
      orderLinkId: reference.orderLinkId,
      expectedProviderQuantity: reference.expectedProviderQuantity,
      expectedSide: reference.expectedSide,
      ...(reference.marketUnit === undefined ? {} : { marketUnit: reference.marketUnit }),
      ...(reference.positionIdx === undefined ? {} : { positionIdx: reference.positionIdx }),
      ...(reference.positionMode === undefined ? {} : { positionMode: reference.positionMode }),
      ...(reference.positionDirection === undefined ? {} : { positionDirection: reference.positionDirection }),
    }),
    createdAt: reference.createdAt,
    updatedAt: reference.updatedAt,
  };
}

function recoveryAssociation(reference: BybitExecutionOrderRecoveryReference): ExecutionOrderReferenceAssociation {
  return {
    executionId: reference.executionId,
    userId: reference.userId,
    venue: "bybit",
    referencePayload: JSON.stringify({
      recovery: "orderLinkId",
      intentId: reference.intentId,
      accountId: reference.accountId,
      instrumentId: reference.instrumentId,
      category: reference.category,
      symbol: reference.symbol,
      orderLinkId: reference.orderLinkId,
      expectedProviderQuantity: reference.expectedProviderQuantity,
      expectedSide: reference.expectedSide,
      ...(reference.marketUnit === undefined ? {} : { marketUnit: reference.marketUnit }),
      ...(reference.positionIdx === undefined ? {} : { positionIdx: reference.positionIdx }),
      ...(reference.positionMode === undefined ? {} : { positionMode: reference.positionMode }),
      ...(reference.positionDirection === undefined ? {} : { positionDirection: reference.positionDirection }),
    }),
    createdAt: reference.createdAt,
    updatedAt: reference.updatedAt,
  };
}

function parsePayload(input: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { throw new Error("Persisted Bybit execution order reference is invalid."); }
  const value = object(parsed, "Persisted Bybit execution order reference");
  const recovery = value.recovery !== undefined;
  exactKeys(value, recovery
    ? ["recovery", "intentId", "accountId", "instrumentId", "category", "symbol", "orderLinkId", "expectedProviderQuantity", "expectedSide", "marketUnit", "positionIdx", "positionMode", "positionDirection"]
    : ["intentId", "accountId", "instrumentId", "category", "symbol", "orderId", "orderLinkId", "expectedProviderQuantity", "expectedSide", "marketUnit", "positionIdx", "positionMode", "positionDirection"],
  recovery ? "Persisted Bybit recovery reference" : "Persisted Bybit order reference");
  if (recovery && value.recovery !== "orderLinkId") throw new Error("Persisted Bybit recovery strategy is invalid.");
  return recovery ? { kind: "recovery" as const, payload: value } : { kind: "complete" as const, payload: value };
}

function completeFromAssociation(association: ExecutionOrderReferenceAssociation, payload: Record<string, unknown>) {
  return createBybitExecutionOrderReference({
    executionId: association.executionId, userId: association.userId, ...payload,
    createdAt: association.createdAt, updatedAt: association.updatedAt,
  });
}

function recoveryFromAssociation(association: ExecutionOrderReferenceAssociation, payload: Record<string, unknown>) {
  const { recovery: _recovery, ...reference } = payload;
  return createBybitExecutionOrderRecoveryReference({
    executionId: association.executionId, userId: association.userId, ...reference,
    createdAt: association.createdAt, updatedAt: association.updatedAt,
  });
}

function assertRecoveryMatches(recovery: BybitExecutionOrderRecoveryReference, complete: BybitExecutionOrderReference) {
  for (const key of [
    "executionId", "intentId", "userId", "accountId", "instrumentId", "category", "symbol", "orderLinkId",
    "expectedProviderQuantity", "expectedSide", "marketUnit", "positionIdx", "positionMode", "positionDirection",
  ] as const) {
    if (recovery[key] !== complete[key]) throw new Error("Bybit completed order reference does not match its recovery reference.");
  }
}

function referenceKey(userId: string, executionId: string) { return `${userId}\u0000${executionId}`; }
function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  const keys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`${name} contains unsupported field: ${unknown}.`);
}
function positionMode(value: unknown): "ONE_WAY" | "HEDGE" {
  if (value !== "ONE_WAY" && value !== "HEDGE") throw new Error("Bybit positionMode is invalid.");
  return value;
}
function positionDirection(value: unknown): "LONG" | "SHORT" {
  if (value !== "LONG" && value !== "SHORT") throw new Error("Bybit positionDirection is invalid.");
  return value;
}
function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error(`${name} is invalid.`);
  return value.trim();
}
function instrumentId(value: unknown) {
  const id = identifier(value, "instrumentId");
  if (!/^[A-Z0-9]{2,12}-USDT-(?:SPOT|PERP)$/u.test(id)) throw new Error("Bybit instrumentId is invalid.");
  return id;
}
function bybitCategory(value: unknown): BybitCategory {
  if (value !== "spot" && value !== "linear") throw new Error("Bybit category is invalid.");
  return value;
}
function symbol(value: unknown) {
  const text = identifier(value, "symbol");
  if (!/^[A-Z0-9]{4,24}$/u.test(text)) throw new Error("Bybit symbol is invalid.");
  return text;
}
function orderId(value: unknown) { return identifier(value, "orderId"); }
function orderLinkId(value: unknown) {
  const id = identifier(value, "orderLinkId");
  if (!/^[A-Za-z0-9_-]{1,36}$/u.test(id)) throw new Error("Bybit orderLinkId is invalid.");
  return id;
}
function positiveDecimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}
function side(value: unknown): BybitOrderSide {
  if (value !== "Buy" && value !== "Sell") throw new Error("Bybit expectedSide is invalid.");
  return value;
}
function marketUnit(value: unknown): BybitMarketUnit {
  if (value !== "baseCoin") throw new Error("Bybit marketUnit is invalid.");
  return value;
}
function positionIdx(value: unknown): BybitPositionIdx {
  if (value !== 0 && value !== 1 && value !== 2) throw new Error("Bybit positionIdx is invalid.");
  return value;
}
function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid.`);
  return value;
}
