import type { OkxInstrumentResolution } from "./OkxInstrumentMapping";
import { OKX_QUANTITY_RULES_MAX_AGE_MS } from "./OkxQuantitySemantics";

export type OkxSpotQuantityRulesSnapshot = Readonly<{
  instType: "SPOT";
  instId: string;
  baseCcy: string;
  quoteCcy: string;
  lotSz: string;
  minSz: string;
  tickSz: string;
  state: string;
  fetchedAt: number;
}>;

export type OkxSpotQuantityRulesSource = (
  instId: string,
) => Promise<OkxSpotQuantityRulesSnapshot | null> | OkxSpotQuantityRulesSnapshot | null;

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

/** Validates Spot facts and preserves the canonical base quantity as OKX Spot sz. */
export async function loadOkxSpotQuantityRules(
  source: OkxSpotQuantityRulesSource | undefined,
  instrument: OkxInstrumentResolution,
  now: number,
  maxAgeMs = OKX_QUANTITY_RULES_MAX_AGE_MS,
): Promise<OkxSpotQuantityRulesSnapshot> {
  if (!source) throw new Error("OKX Spot quantity rules are unavailable.");
  const rules = await source(instrument.venueInstrument.instId);
  if (!rules) throw new Error("OKX Spot quantity rules are unavailable.");
  if (instrument.canonicalInstrument.contractType !== "spot" || instrument.venueInstrument.contractType !== "spot"
    || rules.instType !== "SPOT" || rules.instId !== instrument.venueInstrument.instId
    || rules.baseCcy !== instrument.canonicalInstrument.baseAsset
    || rules.quoteCcy !== instrument.canonicalInstrument.quoteAsset || rules.state !== "live") {
    throw new Error("OKX Spot quantity rules instrument identity or trading state does not match the execution instrument.");
  }
  assertFresh(rules.fetchedAt, now, maxAgeMs);
  const lot = positive(rules.lotSz, "OKX Spot lotSz");
  const minimum = positive(rules.minSz, "OKX Spot minSz");
  positive(rules.tickSz, "OKX Spot tickSz");
  multiple(minimum, lot, "OKX Spot minSz");
  return rules;
}

export function okxBaseQuantityToSpotSize(baseQuantity: string, rules: OkxSpotQuantityRulesSnapshot): string {
  const base = positive(baseQuantity, "OKX canonical base quantity");
  const lot = positive(rules.lotSz, "OKX Spot lotSz");
  const minimum = positive(rules.minSz, "OKX Spot minSz");
  multiple(base, lot, "OKX canonical base quantity");
  if (compare(base, minimum) < 0) throw new Error("OKX Spot quantity is below minSz.");
  return format(base);
}

export function okxSpotSizeToBase(quantity: string, rules: OkxSpotQuantityRulesSnapshot): string {
  const size = unsigned(quantity, "OKX Spot order quantity");
  if (size.coefficient === 0n) return "0";
  multiple(size, positive(rules.lotSz, "OKX Spot lotSz"), "OKX Spot order quantity");
  return format(size);
}

function assertFresh(fetchedAt: number, now: number, maxAgeMs: number) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0
    || !Number.isSafeInteger(fetchedAt) || fetchedAt < 0 || fetchedAt > now) {
    throw new Error("OKX Spot quantity rules freshness is invalid.");
  }
  if (now - fetchedAt > maxAgeMs) throw new Error("OKX Spot quantity rules are stale.");
}

function unsigned(value: string, label: string): Decimal {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw new Error(`${label} is invalid.`);
  const [integer, fraction = ""] = value.split(".");
  return normalize({ coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length });
}

function positive(value: string, label: string) {
  const decimal = unsigned(value, label);
  if (decimal.coefficient === 0n) throw new Error(`${label} must be positive.`);
  return decimal;
}

function multiple(value: Decimal, step: Decimal, label: string) {
  const scale = Math.max(value.scale, step.scale);
  const left = value.coefficient * (10n ** BigInt(scale - value.scale));
  const right = step.coefficient * (10n ** BigInt(scale - step.scale));
  if (left % right !== 0n) throw new Error(`${label} does not satisfy OKX Spot lotSz.`);
}

function compare(left: Decimal, right: Decimal) {
  const scale = Math.max(left.scale, right.scale);
  const lhs = left.coefficient * (10n ** BigInt(scale - left.scale));
  const rhs = right.coefficient * (10n ** BigInt(scale - right.scale));
  return lhs === rhs ? 0 : lhs > rhs ? 1 : -1;
}

function normalize(value: Decimal): Decimal {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1; }
  return { coefficient, scale };
}

function format(value: Decimal) {
  if (value.scale === 0) return value.coefficient.toString();
  const digits = value.coefficient.toString().padStart(value.scale + 1, "0");
  return `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
}
