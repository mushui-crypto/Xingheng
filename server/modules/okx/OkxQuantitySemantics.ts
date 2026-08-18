import type { OkxInstrumentResolution } from "./OkxInstrumentMapping";

export const OKX_QUANTITY_RULES_MAX_AGE_MS = 5 * 60 * 1_000;

export type OkxQuantityRulesSnapshot = Readonly<{
  instType: "SWAP";
  instId: string;
  uly: string;
  ctType: string;
  ctValCcy: string;
  settleCcy: string;
  lotSz: string;
  minSz: string;
  ctVal: string;
  state: string;
  fetchedAt: number;
}>;

export type OkxQuantityRulesSource = (
  instId: string,
) => Promise<OkxQuantityRulesSnapshot | null> | OkxQuantityRulesSnapshot | null;

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

export async function loadOkxQuantityRules(
  source: OkxQuantityRulesSource | undefined,
  instrument: OkxInstrumentResolution,
  now: number | (() => number),
  maxAgeMs = OKX_QUANTITY_RULES_MAX_AGE_MS,
): Promise<OkxQuantityRulesSnapshot> {
  if (!source) throw new Error("OKX quantity rules are unavailable.");
  const snapshot = await source(instrument.venueInstrument.instId);
  if (!snapshot) throw new Error("OKX quantity rules are unavailable.");
  assertRulesIdentity(snapshot, instrument);
  assertRulesFreshness(snapshot, typeof now === "function" ? now() : now, maxAgeMs);
  positiveDecimal(snapshot.lotSz, "OKX lotSz");
  positiveDecimal(snapshot.minSz, "OKX minSz");
  positiveDecimal(snapshot.ctVal, "OKX ctVal");
  integerMultiple(decimal(snapshot.minSz, "OKX minSz"), decimal(snapshot.lotSz, "OKX lotSz"), "OKX minSz");
  return snapshot;
}

export function okxBaseQuantityToContracts(
  baseQuantity: string,
  rules: OkxQuantityRulesSnapshot,
): string {
  const base = positiveDecimal(baseQuantity, "OKX canonical base quantity");
  const contractValue = positiveDecimal(rules.ctVal, "OKX ctVal");
  const lotSize = positiveDecimal(rules.lotSz, "OKX lotSz");
  const minimum = positiveDecimal(rules.minSz, "OKX minSz");
  const basePerLot = multiply(contractValue, lotSize);
  const lots = integerMultiple(base, basePerLot, "OKX canonical base quantity");
  const contracts = multiplyByInteger(lotSize, lots);
  if (compare(contracts, minimum) < 0) {
    throw new Error("OKX contract quantity is below minSz.");
  }
  return format(contracts);
}

export function okxContractQuantityToBase(
  contractQuantity: string,
  rules: OkxQuantityRulesSnapshot,
): string {
  const contracts = unsignedDecimal(contractQuantity, "OKX contract quantity");
  if (contracts.coefficient === 0n) return "0";
  const lotSize = positiveDecimal(rules.lotSz, "OKX lotSz");
  integerMultiple(contracts, lotSize, "OKX contract quantity");
  return format(multiply(contracts, positiveDecimal(rules.ctVal, "OKX ctVal")));
}

function assertRulesIdentity(snapshot: OkxQuantityRulesSnapshot, instrument: OkxInstrumentResolution) {
  if (
    snapshot.instType !== "SWAP"
    || snapshot.instId !== instrument.venueInstrument.instId
    || snapshot.uly !== `${instrument.canonicalInstrument.baseAsset}-${instrument.canonicalInstrument.quoteAsset}`
    || snapshot.ctType !== "linear"
    || snapshot.ctValCcy !== instrument.canonicalInstrument.baseAsset
    || snapshot.settleCcy !== instrument.canonicalInstrument.quoteAsset
    || snapshot.state !== "live"
  ) {
    throw new Error("OKX quantity rules instrument identity or trading state does not match the execution instrument.");
  }
}

function assertRulesFreshness(snapshot: OkxQuantityRulesSnapshot, now: number, maxAgeMs: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("OKX quantity rules clock is invalid.");
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error("OKX quantity rules max age is invalid.");
  if (!Number.isSafeInteger(snapshot.fetchedAt) || snapshot.fetchedAt < 0 || snapshot.fetchedAt > now) {
    throw new Error("OKX quantity rules fetchedAt is invalid.");
  }
  if (now - snapshot.fetchedAt > maxAgeMs) throw new Error("OKX quantity rules are stale.");
}

function unsignedDecimal(value: string, label: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw new Error(`${label} is invalid.`);
  return decimal(value, label);
}

function positiveDecimal(value: string, label: string) {
  const parsed = unsignedDecimal(value, label);
  if (parsed.coefficient === 0n) throw new Error(`${label} must be positive.`);
  return parsed;
}

function decimal(value: string, label: string): Decimal {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) throw new Error(`${label} is invalid.`);
  const fraction = match[2] ?? "";
  return normalize({ coefficient: BigInt(`${match[1]}${fraction}`), scale: fraction.length });
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

function multiply(left: Decimal, right: Decimal) {
  return normalize({
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  });
}

function multiplyByInteger(value: Decimal, multiplier: bigint) {
  return normalize({ coefficient: value.coefficient * multiplier, scale: value.scale });
}

function integerMultiple(value: Decimal, step: Decimal, label: string) {
  const scale = Math.max(value.scale, step.scale);
  const numerator = value.coefficient * powerOfTen(scale - value.scale);
  const denominator = step.coefficient * powerOfTen(scale - step.scale);
  if (numerator % denominator !== 0n) throw new Error(`${label} does not satisfy OKX lotSz.`);
  return numerator / denominator;
}

function compare(left: Decimal, right: Decimal) {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * powerOfTen(scale - left.scale);
  const rightValue = right.coefficient * powerOfTen(scale - right.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function powerOfTen(exponent: number) {
  return 10n ** BigInt(exponent);
}

function format(value: Decimal) {
  if (value.scale === 0) return value.coefficient.toString();
  const digits = value.coefficient.toString().padStart(value.scale + 1, "0");
  return `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
}
