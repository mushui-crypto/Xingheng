import { createAssetQuantity, type AssetQuantity } from "./AssetQuantity";

export type ExecutionVenue = "binance" | "okx" | "bybit" | "bitget";
export type PositionDirection = "LONG" | "SHORT";

export type ExecutionIntent = Readonly<{
  intentId: string;
  arbitrageId?: string;
  legId?: string;
  userId: string;
  venue: ExecutionVenue;
  accountId: string;
  instrumentId: string;
  side: "buy" | "sell";
  /** Canonical perpetual position bucket. Spot intents must omit this field. */
  positionDirection?: PositionDirection;
  quantity: AssetQuantity;
  orderConstraints: Readonly<{
    reduceOnly: boolean;
  }>;
  executionMode: "PRICE_PRIORITY" | "EXECUTION_PRIORITY";
  createdAt: number;
  expiresAt: number;
}>;

export function createExecutionIntent(input: unknown): ExecutionIntent {
  return parseExecutionIntent(input, false);
}

/**
 * Parses a pre-direction legacy one-way intent for an explicit recovery path.
 * New execution callers must use createExecutionIntent and provide direction.
 */
export function createLegacyOneWayExecutionIntent(input: unknown): ExecutionIntent {
  return parseExecutionIntent(input, true);
}

function parseExecutionIntent(input: unknown, allowLegacyOneWay: boolean): ExecutionIntent {
  const value = object(input);
  assertExactKeys(value, [
    "intentId",
    "arbitrageId",
    "legId",
    "userId",
    "venue",
    "accountId",
    "instrumentId",
    "side",
    "positionDirection",
    "quantity",
    "orderConstraints",
    "executionMode",
    "createdAt",
    "expiresAt",
  ], "ExecutionIntent");
  const createdAt = timestamp(value.createdAt, "createdAt");
  const expiresAt = timestamp(value.expiresAt, "expiresAt");
  if (expiresAt <= createdAt) throw new Error("expiresAt must be after createdAt.");
  if ((value.arbitrageId === undefined) !== (value.legId === undefined)) {
    throw new Error("arbitrageId and legId must be provided together.");
  }

  if (value.venue !== "binance" && value.venue !== "okx" && value.venue !== "bybit" && value.venue !== "bitget") {
    throw new Error("venue must be binance, okx, bybit, or bitget.");
  }
  if (value.side !== "buy" && value.side !== "sell") {
    throw new Error("side must be buy or sell.");
  }
  const canonicalInstrument = instrumentId(value.instrumentId);
  const perpetual = canonicalInstrument.endsWith("-PERP");
  if (perpetual && value.positionDirection !== undefined
    && value.positionDirection !== "LONG" && value.positionDirection !== "SHORT") {
    throw new Error("positionDirection must be LONG or SHORT.");
  }
  if (perpetual && value.positionDirection === undefined && !allowLegacyOneWay) {
    throw new Error("Perpetual ExecutionIntent requires positionDirection.");
  }
  // Legacy one-way recovery preserves its historical side-derived semantics;
  // it never enables HEDGE or claims to identify an account position.
  const positionDirection = perpetual
    ? value.positionDirection === "LONG" || value.positionDirection === "SHORT"
      ? value.positionDirection
      : value.side === "buy" ? "LONG" as const : "SHORT" as const
    : undefined;
  if (!perpetual && value.positionDirection !== undefined) {
    throw new Error("Spot ExecutionIntent must not contain positionDirection.");
  }
  if (value.executionMode !== "PRICE_PRIORITY" && value.executionMode !== "EXECUTION_PRIORITY") {
    throw new Error("executionMode must be PRICE_PRIORITY or EXECUTION_PRIORITY.");
  }

  const constraints = object(value.orderConstraints, "orderConstraints");
  assertExactKeys(constraints, ["reduceOnly"], "orderConstraints");
  if (typeof constraints.reduceOnly !== "boolean") {
    throw new Error("orderConstraints.reduceOnly must be a boolean.");
  }

  return Object.freeze({
    intentId: identifier(value.intentId, "intentId"),
    ...(value.arbitrageId === undefined
      ? {}
      : {
          arbitrageId: identifier(value.arbitrageId, "arbitrageId"),
          legId: identifier(value.legId, "legId"),
        }),
    userId: identifier(value.userId, "userId"),
    venue: value.venue,
    accountId: identifier(value.accountId, "accountId"),
    instrumentId: canonicalInstrument,
    side: value.side,
    ...(perpetual ? { positionDirection } : {}),
    quantity: createAssetQuantity(value.quantity),
    orderConstraints: Object.freeze({ reduceOnly: constraints.reduceOnly }),
    executionMode: value.executionMode,
    createdAt,
    expiresAt,
  });
}

function object(value: unknown, name = "ExecutionIntent") {
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

function instrumentId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}-(?:SPOT|PERP)$/u.test(value)) {
    throw new Error("instrumentId must be a canonical instrument id.");
  }
  return value;
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}
