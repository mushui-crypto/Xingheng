export type TradingRulesPrecision = Readonly<{
  quantity?: number;
  price?: number;
}>;

export type TradingRules = Readonly<{
  quantityStep: string;
  minQuantity: string;
  priceTick: string;
  minNotional?: string;
  contractSize?: string;
  precision: TradingRulesPrecision;
}>;

export function createTradingRules(input: unknown): TradingRules {
  const value = object(input, "TradingRules");
  assertExactKeys(value, [
    "quantityStep",
    "minQuantity",
    "priceTick",
    "minNotional",
    "contractSize",
    "precision",
  ], "TradingRules");

  return Object.freeze({
    quantityStep: positiveDecimal(value.quantityStep, "quantityStep"),
    minQuantity: positiveDecimal(value.minQuantity, "minQuantity"),
    priceTick: positiveDecimal(value.priceTick, "priceTick"),
    ...(value.minNotional === undefined ? {} : { minNotional: positiveDecimal(value.minNotional, "minNotional") }),
    ...(value.contractSize === undefined ? {} : { contractSize: positiveDecimal(value.contractSize, "contractSize") }),
    precision: precision(value.precision),
  });
}

export function decimalStepFromPrecision(value: unknown, name: string) {
  const places = nonNegativeInteger(value, name);
  return places === 0 ? "1" : `0.${"0".repeat(places - 1)}1`;
}

function precision(input: unknown): TradingRulesPrecision {
  if (input === undefined) return Object.freeze({});
  const value = object(input, "precision");
  assertExactKeys(value, ["quantity", "price"], "precision");

  return Object.freeze({
    ...(value.quantity === undefined ? {} : { quantity: nonNegativeInteger(value.quantity, "precision.quantity") }),
    ...(value.price === undefined ? {} : { price: nonNegativeInteger(value.price, "precision.price") }),
  });
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

function positiveDecimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} must be a positive decimal string.`);
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  const normalized = normalizedFraction ? `${integer}.${normalizedFraction}` : integer;
  if (normalized === "0") throw new Error(`${name} must be greater than zero.`);
  return normalized;
}

function nonNegativeInteger(value: unknown, name: string) {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < 0 || numeric > 30) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return numeric;
}
