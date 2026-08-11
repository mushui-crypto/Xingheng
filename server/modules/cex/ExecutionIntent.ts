export type ExecutionVenue = "binance" | "okx" | "bybit" | "bitget";

export type ExecutionIntent = Readonly<{
  intentId: string;
  userId: string;
  venue: ExecutionVenue;
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: string;
  orderConstraints: Readonly<{
    reduceOnly: boolean;
  }>;
  executionMode: "PRICE_PRIORITY" | "EXECUTION_PRIORITY";
  createdAt: number;
  expiresAt: number;
}>;

export function createExecutionIntent(input: unknown): ExecutionIntent {
  const value = object(input);
  assertExactKeys(value, [
    "intentId",
    "userId",
    "venue",
    "accountId",
    "symbol",
    "side",
    "quantity",
    "orderConstraints",
    "executionMode",
    "createdAt",
    "expiresAt",
  ], "ExecutionIntent");
  const createdAt = timestamp(value.createdAt, "createdAt");
  const expiresAt = timestamp(value.expiresAt, "expiresAt");
  if (expiresAt <= createdAt) throw new Error("expiresAt must be after createdAt.");

  if (value.venue !== "binance" && value.venue !== "okx" && value.venue !== "bybit" && value.venue !== "bitget") {
    throw new Error("venue must be binance, okx, bybit, or bitget.");
  }
  if (value.side !== "buy" && value.side !== "sell") {
    throw new Error("side must be buy or sell.");
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
    userId: identifier(value.userId, "userId"),
    venue: value.venue,
    accountId: identifier(value.accountId, "accountId"),
    symbol: symbol(value.symbol),
    side: value.side,
    quantity: positiveDecimal(value.quantity),
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

function symbol(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z0-9]{3,30}$/u.test(value)) {
    throw new Error("symbol must be an uppercase venue symbol.");
  }
  return value;
}

function positiveDecimal(value: unknown) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("quantity must be a positive decimal string.");
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  const normalized = normalizedFraction ? `${integer}.${normalizedFraction}` : integer;
  if (normalized === "0") throw new Error("quantity must be greater than zero.");
  return normalized;
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}
