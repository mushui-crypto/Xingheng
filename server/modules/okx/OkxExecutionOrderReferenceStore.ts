import type {
  ExecutionOrderReferenceAssociation,
  ExecutionOrderReferenceStore,
} from "../cex/ExecutionOrderReferenceStore";

export type OkxExecutionOrderReference = Readonly<{
  executionId: string;
  intentId: string;
  userId: string;
  accountId: string;
  instrumentId: string;
  instId: string;
  ordId: string;
  clOrdId: string;
  expectedProviderQuantity?: string;
  expectedSide?: "buy" | "sell";
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
  posSide?: "long" | "short";
  createdAt: number;
  updatedAt: number;
}>;

export type OkxExecutionOrderRecoveryReference = Readonly<{
  executionId: string;
  intentId: string;
  userId: string;
  accountId: string;
  instrumentId: string;
  instId: string;
  clOrdId: string;
  expectedProviderQuantity?: string;
  expectedSide?: "buy" | "sell";
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
  posSide?: "long" | "short";
  createdAt: number;
  updatedAt: number;
}>;

export interface OkxExecutionOrderReferenceStore {
  create(reference: OkxExecutionOrderReference): Promise<void> | void;
  createRecovery(reference: OkxExecutionOrderRecoveryReference): Promise<void> | void;
  loadForUser(userId: string, executionId: string): Promise<OkxExecutionOrderReference | null> | OkxExecutionOrderReference | null;
  loadRecoveryForUser(
    userId: string,
    executionId: string,
  ): Promise<OkxExecutionOrderRecoveryReference | null> | OkxExecutionOrderRecoveryReference | null;
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
    "expectedProviderQuantity",
    "expectedSide",
    "positionMode", "positionDirection", "posSide",
    "createdAt",
    "updatedAt",
  ], "OkxExecutionOrderReference");
  const createdAt = timestamp(value.createdAt, "createdAt");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("updatedAt must be at or after createdAt.");
  const instrumentId = canonicalInstrumentId(value.instrumentId);

  return Object.freeze({
    executionId: identifier(value.executionId, "executionId"),
    intentId: identifier(value.intentId, "intentId"),
    userId: identifier(value.userId, "userId"),
    accountId: identifier(value.accountId, "accountId"),
    instrumentId,
    instId: okxInstId(value.instId),
    ordId: okxOrdId(value.ordId),
    clOrdId: okxClOrdId(value.clOrdId),
    ...expectedOrderFacts(value, instrumentId),
    createdAt,
    updatedAt,
  });
}

export function createOkxExecutionOrderRecoveryReference(
  input: unknown,
): OkxExecutionOrderRecoveryReference {
  const value = object(input, "OkxExecutionOrderRecoveryReference");
  assertExactKeys(value, [
    "executionId",
    "intentId",
    "userId",
    "accountId",
    "instrumentId",
    "instId",
    "clOrdId",
    "expectedProviderQuantity",
    "expectedSide",
    "positionMode", "positionDirection", "posSide",
    "createdAt",
    "updatedAt",
  ], "OkxExecutionOrderRecoveryReference");
  const createdAt = timestamp(value.createdAt, "createdAt");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("updatedAt must be at or after createdAt.");
  const instrumentId = canonicalInstrumentId(value.instrumentId);
  return Object.freeze({
    executionId: identifier(value.executionId, "executionId"),
    intentId: identifier(value.intentId, "intentId"),
    userId: identifier(value.userId, "userId"),
    accountId: identifier(value.accountId, "accountId"),
    instrumentId,
    instId: okxInstId(value.instId),
    clOrdId: okxClOrdId(value.clOrdId),
    ...expectedOrderFacts(value, instrumentId),
    createdAt,
    updatedAt,
  });
}

export class InMemoryOkxExecutionOrderReferenceStore implements OkxExecutionOrderReferenceStore {
  private readonly references = new Map<string, OkxStoredReference>();

  create(reference: OkxExecutionOrderReference) {
    const normalized = createOkxExecutionOrderReference(reference);
    const key = referenceKey(normalized.userId, normalized.executionId);
    const existing = this.references.get(key);
    if (existing?.kind === "complete") throw new Error("OKX execution order reference already exists.");
    if (existing) assertRecoveryMatchesReference(existing.value, normalized);
    this.references.set(key, { kind: "complete", value: normalized });
  }

  createRecovery(reference: OkxExecutionOrderRecoveryReference) {
    const normalized = createOkxExecutionOrderRecoveryReference(reference);
    const key = referenceKey(normalized.userId, normalized.executionId);
    if (this.references.has(key)) throw new Error("OKX execution order recovery reference already exists.");
    this.references.set(key, { kind: "recovery", value: normalized });
  }

  loadForUser(userId: string, executionId: string) {
    const stored = this.references.get(referenceKey(identifier(userId, "userId"), identifier(executionId, "executionId")));
    return stored?.kind === "complete" ? stored.value : null;
  }

  loadRecoveryForUser(userId: string, executionId: string) {
    const stored = this.references.get(referenceKey(identifier(userId, "userId"), identifier(executionId, "executionId")));
    return stored?.kind === "recovery" ? stored.value : null;
  }
}

export class PersistentOkxExecutionOrderReferenceStore implements OkxExecutionOrderReferenceStore {
  constructor(private readonly references: ExecutionOrderReferenceStore) {}

  async create(reference: OkxExecutionOrderReference) {
    const normalized = createOkxExecutionOrderReference(reference);
    const association = completeAssociation(normalized);
    const existing = await this.references.loadForUser(normalized.userId, normalized.executionId, "okx");
    if (!existing) {
      await this.references.create(association);
      return;
    }
    const stored = parseStoredPayload(existing.referencePayload);
    if (stored.kind === "complete") throw new Error("OKX execution order reference already exists.");
    const recovery = recoveryFromAssociation(existing, stored.payload);
    assertRecoveryMatchesReference(recovery, normalized);
    await this.references.replace(association);
  }

  async createRecovery(reference: OkxExecutionOrderRecoveryReference) {
    const normalized = createOkxExecutionOrderRecoveryReference(reference);
    await this.references.create({
      executionId: normalized.executionId,
      userId: normalized.userId,
      venue: "okx",
      referencePayload: JSON.stringify({
        recovery: "clOrdId",
        intentId: normalized.intentId,
        accountId: normalized.accountId,
        instrumentId: normalized.instrumentId,
        instId: normalized.instId,
        clOrdId: normalized.clOrdId,
        ...(normalized.expectedProviderQuantity === undefined ? {} : {
          expectedProviderQuantity: normalized.expectedProviderQuantity,
          expectedSide: normalized.expectedSide,
        }),
        ...(normalized.positionMode === undefined ? {} : { positionMode: normalized.positionMode }),
        ...(normalized.positionDirection === undefined ? {} : { positionDirection: normalized.positionDirection }),
        ...(normalized.posSide === undefined ? {} : { posSide: normalized.posSide }),
      }),
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
    });
  }

  async loadForUser(userId: string, executionId: string) {
    const association = await this.references.loadForUser(userId, executionId, "okx");
    if (!association) return null;
    const stored = parseStoredPayload(association.referencePayload);
    return stored.kind === "complete" ? completeFromAssociation(association, stored.payload) : null;
  }

  async loadRecoveryForUser(userId: string, executionId: string) {
    const association = await this.references.loadForUser(userId, executionId, "okx");
    if (!association) return null;
    const stored = parseStoredPayload(association.referencePayload);
    return stored.kind === "recovery" ? recoveryFromAssociation(association, stored.payload) : null;
  }
}

type OkxStoredReference =
  | Readonly<{ kind: "complete"; value: OkxExecutionOrderReference }>
  | Readonly<{ kind: "recovery"; value: OkxExecutionOrderRecoveryReference }>;

function referenceKey(userId: string, executionId: string) {
  return `${userId}\u0000${executionId}`;
}

function completeAssociation(
  reference: OkxExecutionOrderReference,
): ExecutionOrderReferenceAssociation {
  return {
    executionId: reference.executionId,
    userId: reference.userId,
    venue: "okx",
    referencePayload: JSON.stringify({
      intentId: reference.intentId,
      accountId: reference.accountId,
      instrumentId: reference.instrumentId,
      instId: reference.instId,
      ordId: reference.ordId,
      clOrdId: reference.clOrdId,
      ...(reference.expectedProviderQuantity === undefined ? {} : {
        expectedProviderQuantity: reference.expectedProviderQuantity,
        expectedSide: reference.expectedSide,
      }),
      ...(reference.positionMode === undefined ? {} : { positionMode: reference.positionMode }),
      ...(reference.positionDirection === undefined ? {} : { positionDirection: reference.positionDirection }),
      ...(reference.posSide === undefined ? {} : { posSide: reference.posSide }),
    }),
    createdAt: reference.createdAt,
    updatedAt: reference.updatedAt,
  };
}

function parseStoredPayload(input: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Persisted OKX execution order reference is invalid.");
  }
  const value = object(parsed, "Persisted OKX execution order reference");
  if (value.recovery !== undefined) {
    assertExactKeys(value, [
      "recovery",
      "intentId",
      "accountId",
      "instrumentId",
      "instId",
      "clOrdId",
      "expectedProviderQuantity",
      "expectedSide",
      "positionMode", "positionDirection", "posSide",
    ], "Persisted OKX execution order recovery reference");
    if (value.recovery !== "clOrdId") {
      throw new Error("Persisted OKX execution order recovery strategy is invalid.");
    }
    return { kind: "recovery" as const, payload: value };
  }
  assertExactKeys(value, [
    "intentId",
    "accountId",
    "instrumentId",
    "instId",
    "ordId",
    "clOrdId",
    "expectedProviderQuantity",
    "expectedSide",
    "positionMode", "positionDirection", "posSide",
  ], "Persisted OKX execution order reference");
  return { kind: "complete" as const, payload: value };
}

function completeFromAssociation(
  association: ExecutionOrderReferenceAssociation,
  payload: Record<string, unknown>,
) {
  return createOkxExecutionOrderReference({
    executionId: association.executionId,
    userId: association.userId,
    ...payload,
    createdAt: association.createdAt,
    updatedAt: association.updatedAt,
  });
}

function recoveryFromAssociation(
  association: ExecutionOrderReferenceAssociation,
  payload: Record<string, unknown>,
) {
  const { recovery: _recovery, ...reference } = payload;
  return createOkxExecutionOrderRecoveryReference({
    executionId: association.executionId,
    userId: association.userId,
    ...reference,
    createdAt: association.createdAt,
    updatedAt: association.updatedAt,
  });
}

function assertRecoveryMatchesReference(
  recovery: OkxExecutionOrderRecoveryReference,
  reference: OkxExecutionOrderReference,
) {
  if (
    recovery.executionId !== reference.executionId
    || recovery.intentId !== reference.intentId
    || recovery.userId !== reference.userId
    || recovery.accountId !== reference.accountId
    || recovery.instrumentId !== reference.instrumentId
    || recovery.instId !== reference.instId
    || recovery.clOrdId !== reference.clOrdId
    || recovery.expectedProviderQuantity !== reference.expectedProviderQuantity
    || recovery.expectedSide !== reference.expectedSide
    || recovery.positionMode !== reference.positionMode
    || recovery.positionDirection !== reference.positionDirection
    || recovery.posSide !== reference.posSide
    || recovery.createdAt !== reference.createdAt
  ) {
    throw new Error("OKX recovered order identity does not match the persisted recovery reference.");
  }
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
  if (!/^[A-Z0-9]{2,12}-USDT(?:-SWAP)?$/u.test(text)) {
    throw new Error("instId must be an OKX USDT spot or swap id.");
  }
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

function expectedOrderFacts(value: Record<string, unknown>, instrumentId: string) {
  const expectedProviderQuantity = value.expectedProviderQuantity;
  const expectedSide = value.expectedSide;
  const required = instrumentId.endsWith("-SPOT");
  if (expectedProviderQuantity === undefined && expectedSide === undefined) {
    if (required) throw new Error("OKX Spot order reference is missing expected order facts.");
    return {};
  }
  if (typeof expectedProviderQuantity !== "string"
    || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(expectedProviderQuantity)
    || /^0(?:\.0+)?$/u.test(expectedProviderQuantity)) {
    throw new Error("expectedProviderQuantity must be a positive OKX Decimal string.");
  }
  if (expectedSide !== "buy" && expectedSide !== "sell") {
    throw new Error("expectedSide must be an OKX order side.");
  }
  const positionMode = value.positionMode === undefined ? undefined : value.positionMode;
  const positionDirection = value.positionDirection === undefined ? undefined : value.positionDirection;
  const posSide = value.posSide === undefined ? undefined : value.posSide;
  if (positionMode !== undefined && positionMode !== "ONE_WAY" && positionMode !== "HEDGE") throw new Error("OKX positionMode is invalid.");
  if (positionDirection !== undefined && positionDirection !== "LONG" && positionDirection !== "SHORT") throw new Error("OKX positionDirection is invalid.");
  if (posSide !== undefined && posSide !== "long" && posSide !== "short") throw new Error("OKX posSide is invalid.");
  if (positionMode === "HEDGE" && posSide !== (positionDirection === "LONG" ? "long" : "short")) throw new Error("OKX persisted bucket does not match direction.");
  return { expectedProviderQuantity, expectedSide, ...(positionMode === undefined ? {} : { positionMode }), ...(positionDirection === undefined ? {} : { positionDirection }), ...(posSide === undefined ? {} : { posSide }) } as const;
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}
