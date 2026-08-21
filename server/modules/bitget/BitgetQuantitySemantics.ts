import type { BitgetInstrumentResolution } from "./BitgetInstrumentMapping";
import type { BitgetCategory } from "./BitgetTypes";

export const BITGET_QUANTITY_RULES_MAX_AGE_MS = 5 * 60 * 1_000;

export type BitgetQuantityRulesSnapshot = Readonly<{
  category: BitgetCategory;
  symbol: string;
  status: string;
  baseCoin: string;
  quoteCoin: string;
  quantityStep: string;
  minOrderQty: string;
  minNotional: string | null;
  contractSize: string;
  quantityUnit: "base";
  fetchedAt: number;
}>;

export type BitgetQuantityRulesSource = (
  category: BitgetCategory,
  symbol: string,
) => Promise<BitgetQuantityRulesSnapshot | null> | BitgetQuantityRulesSnapshot | null;

export async function loadBitgetQuantityRules(
  source: BitgetQuantityRulesSource | undefined,
  instrument: BitgetInstrumentResolution,
  now: number | (() => number),
  maxAgeMs = BITGET_QUANTITY_RULES_MAX_AGE_MS,
) {
  if (!source) throw new Error("Bitget quantity rules are unavailable.");
  const snapshot = await source(instrument.venueInstrument.category, instrument.venueInstrument.symbol);
  if (!snapshot) throw new Error("Bitget quantity rules are unavailable.");
  assertIdentity(snapshot, instrument);
  assertFreshness(snapshot, typeof now === "function" ? now() : now, maxAgeMs);
  const step = positiveDecimal(snapshot.quantityStep, "Bitget quantityStep");
  const minimum = positiveDecimal(snapshot.minOrderQty, "Bitget minOrderQty");
  integerMultiple(minimum, step, "Bitget minOrderQty");
  if (snapshot.minNotional !== null) positiveDecimal(snapshot.minNotional, "Bitget minNotional");
  const contractSize = positiveDecimal(snapshot.contractSize, "Bitget contractSize");
  if (format(contractSize) !== "1" || snapshot.quantityUnit !== "base") {
    throw new Error("Bitget UTA execution requires base-quantity size semantics with contractSize=1.");
  }
  return snapshot;
}

/** Bitget UTA Spot limit/SELL and USDT-FUTURES qty are base-coin quantities. */
export function bitgetBaseQuantityToProvider(quantity: string, rules: BitgetQuantityRulesSnapshot) {
  const value = positiveDecimal(quantity, "Bitget canonical base quantity");
  const step = positiveDecimal(rules.quantityStep, "Bitget quantityStep");
  const minimum = positiveDecimal(rules.minOrderQty, "Bitget minOrderQty");
  if (format(positiveDecimal(rules.contractSize, "Bitget contractSize")) !== "1" || rules.quantityUnit !== "base") {
    throw new Error("Bitget Provider quantity contract is not canonical base quantity.");
  }
  integerMultiple(value, step, "Bitget canonical base quantity");
  if (compare(value, minimum) < 0) throw new Error("Bitget quantity is below minOrderQty.");
  return format(value);
}

export function bitgetProviderQuantityToBase(quantity: string, rules: BitgetQuantityRulesSnapshot) {
  const value = unsignedDecimal(quantity, "Bitget Provider quantity");
  if (value.coefficient === 0n) return "0";
  if (format(positiveDecimal(rules.contractSize, "Bitget contractSize")) !== "1" || rules.quantityUnit !== "base") {
    throw new Error("Bitget Provider quantity contract is not canonical base quantity.");
  }
  integerMultiple(value, positiveDecimal(rules.quantityStep, "Bitget quantityStep"), "Bitget Provider quantity");
  return format(value);
}

function assertIdentity(snapshot: BitgetQuantityRulesSnapshot, instrument: BitgetInstrumentResolution) {
  const canonical = instrument.canonicalInstrument;
  const venue = instrument.venueInstrument;
  if (snapshot.category !== venue.category || snapshot.symbol !== venue.symbol
    || snapshot.baseCoin !== canonical.baseAsset || snapshot.quoteCoin !== canonical.quoteAsset
    || snapshot.status !== "online") {
    throw new Error("Bitget quantity rules instrument identity or trading state does not match the execution instrument.");
  }
}

function assertFreshness(snapshot: BitgetQuantityRulesSnapshot, now: number, maxAgeMs: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Bitget quantity rules clock is invalid.");
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error("Bitget quantity rules max age is invalid.");
  if (!Number.isSafeInteger(snapshot.fetchedAt) || snapshot.fetchedAt < 0 || snapshot.fetchedAt > now) {
    throw new Error("Bitget quantity rules fetchedAt is invalid.");
  }
  if (now - snapshot.fetchedAt > maxAgeMs) throw new Error("Bitget quantity rules are stale.");
}

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;
function unsignedDecimal(value: string, label: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw new Error(`${label} is invalid.`);
  const [integer, fraction = ""] = value.split(".");
  return normalize({ coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length });
}
function positiveDecimal(value: string, label: string) {
  const parsed = unsignedDecimal(value, label);
  if (parsed.coefficient === 0n) throw new Error(`${label} must be positive.`);
  return parsed;
}
function normalize(value: Decimal): Decimal {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1; }
  return { coefficient, scale };
}
function integerMultiple(value: Decimal, step: Decimal, label: string) {
  const scale = Math.max(value.scale, step.scale);
  const numerator = value.coefficient * 10n ** BigInt(scale - value.scale);
  const denominator = step.coefficient * 10n ** BigInt(scale - step.scale);
  if (numerator % denominator !== 0n) throw new Error(`${label} does not satisfy Bitget quantityStep.`);
}
function compare(left: Decimal, right: Decimal) {
  const scale = Math.max(left.scale, right.scale);
  const a = left.coefficient * 10n ** BigInt(scale - left.scale);
  const b = right.coefficient * 10n ** BigInt(scale - right.scale);
  return a < b ? -1 : a > b ? 1 : 0;
}
function format(value: Decimal) {
  const normalized = normalize(value);
  if (normalized.scale === 0) return normalized.coefficient.toString();
  const digits = normalized.coefficient.toString().padStart(normalized.scale + 1, "0");
  return `${digits.slice(0, -normalized.scale)}.${digits.slice(-normalized.scale)}`;
}
