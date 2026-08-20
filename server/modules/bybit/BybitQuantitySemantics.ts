import type { BybitInstrumentResolution } from "./BybitInstrumentMapping";
import type { BybitCategory } from "./BybitTypes";

export const BYBIT_QUANTITY_RULES_MAX_AGE_MS = 5 * 60 * 1_000;

export type BybitQuantityRulesSnapshot = Readonly<{
  category: BybitCategory;
  symbol: string;
  status: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string | null;
  qtyStep: string;
  minOrderQty: string;
  minNotionalValue: string | null;
  fetchedAt: number;
}>;

export type BybitQuantityRulesSource = (
  category: BybitCategory,
  symbol: string,
) => Promise<BybitQuantityRulesSnapshot | null> | BybitQuantityRulesSnapshot | null;

export async function loadBybitQuantityRules(
  source: BybitQuantityRulesSource | undefined,
  instrument: BybitInstrumentResolution,
  now: number | (() => number),
  maxAgeMs = BYBIT_QUANTITY_RULES_MAX_AGE_MS,
) {
  if (!source) throw new Error("Bybit quantity rules are unavailable.");
  const snapshot = await source(instrument.venueInstrument.category, instrument.venueInstrument.symbol);
  if (!snapshot) throw new Error("Bybit quantity rules are unavailable.");
  assertIdentity(snapshot, instrument);
  assertFreshness(snapshot, typeof now === "function" ? now() : now, maxAgeMs);
  const step = positiveDecimal(snapshot.qtyStep, "Bybit qtyStep");
  const minimum = positiveDecimal(snapshot.minOrderQty, "Bybit minOrderQty");
  integerMultiple(minimum, step, "Bybit minOrderQty");
  if (snapshot.minNotionalValue !== null) {
    positiveDecimal(snapshot.minNotionalValue, "Bybit minNotionalValue");
  }
  return snapshot;
}

export function bybitBaseQuantityToProvider(quantity: string, rules: BybitQuantityRulesSnapshot) {
  const value = positiveDecimal(quantity, "Bybit canonical base quantity");
  const step = positiveDecimal(rules.qtyStep, "Bybit qtyStep");
  const minimum = positiveDecimal(rules.minOrderQty, "Bybit minOrderQty");
  integerMultiple(value, step, "Bybit canonical base quantity");
  if (compare(value, minimum) < 0) throw new Error("Bybit quantity is below minOrderQty.");
  return format(value);
}

export function bybitProviderQuantityToBase(quantity: string, rules: BybitQuantityRulesSnapshot) {
  const value = unsignedDecimal(quantity, "Bybit provider quantity");
  if (value.coefficient === 0n) return "0";
  integerMultiple(value, positiveDecimal(rules.qtyStep, "Bybit qtyStep"), "Bybit provider quantity");
  return format(value);
}

function assertIdentity(snapshot: BybitQuantityRulesSnapshot, instrument: BybitInstrumentResolution) {
  const canonical = instrument.canonicalInstrument;
  const venue = instrument.venueInstrument;
  if (snapshot.category !== venue.category
    || snapshot.symbol !== venue.symbol
    || snapshot.baseCoin !== canonical.baseAsset
    || snapshot.quoteCoin !== canonical.quoteAsset
    || snapshot.status !== "Trading"
    || (venue.category === "linear" && snapshot.settleCoin !== canonical.quoteAsset)
    || (venue.category === "spot" && snapshot.settleCoin !== null)) {
    throw new Error("Bybit quantity rules instrument identity or trading state does not match the execution instrument.");
  }
}

function assertFreshness(snapshot: BybitQuantityRulesSnapshot, now: number, maxAgeMs: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Bybit quantity rules clock is invalid.");
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error("Bybit quantity rules max age is invalid.");
  if (!Number.isSafeInteger(snapshot.fetchedAt) || snapshot.fetchedAt < 0 || snapshot.fetchedAt > now) {
    throw new Error("Bybit quantity rules fetchedAt is invalid.");
  }
  if (now - snapshot.fetchedAt > maxAgeMs) throw new Error("Bybit quantity rules are stale.");
}

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

function unsignedDecimal(value: string, label: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw new Error(`${label} is invalid.`);
  return decimal(value);
}

function positiveDecimal(value: string, label: string) {
  const parsed = unsignedDecimal(value, label);
  if (parsed.coefficient === 0n) throw new Error(`${label} must be positive.`);
  return parsed;
}

function decimal(value: string): Decimal {
  const [integer, fraction = ""] = value.split(".");
  return normalize({ coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length });
}

function normalize(value: Decimal): Decimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function integerMultiple(value: Decimal, step: Decimal, label: string) {
  const scale = Math.max(value.scale, step.scale);
  const numerator = value.coefficient * 10n ** BigInt(scale - value.scale);
  const denominator = step.coefficient * 10n ** BigInt(scale - step.scale);
  if (numerator % denominator !== 0n) throw new Error(`${label} does not satisfy Bybit qtyStep.`);
}

function compare(left: Decimal, right: Decimal) {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightValue = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function format(value: Decimal) {
  if (value.scale === 0) return value.coefficient.toString();
  const digits = value.coefficient.toString().padStart(value.scale + 1, "0");
  return `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
}
