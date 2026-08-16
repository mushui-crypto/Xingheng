import { canonicalInstrumentFromId } from "../Instrument";
import { createPositionSnapshot, type PositionSnapshot } from "./PositionSnapshot";
import { isPositionSide, type PositionSide } from "./PositionSide";

export type ExpectedPosition = Readonly<{
  instrumentId: string;
  side: PositionSide;
  /** Canonical base-asset quantity represented as an unsigned Decimal string. */
  quantity: string;
  tolerance: string;
}>;

export type PositionVerificationStatus = "MATCHED" | "MISMATCH" | "UNKNOWN";

export type PositionVerificationUnknownReason =
  | "SNAPSHOT_UNAVAILABLE"
  | "SNAPSHOT_INVALID"
  | "INSTRUMENT_MISMATCH";

export type PositionVerificationResult = Readonly<{
  status: PositionVerificationStatus;
  directionMatches: boolean | null;
  quantityMatches: boolean | null;
  quantityDifference: string | null;
  reason: PositionVerificationUnknownReason | null;
}>;

export function verifyPosition(
  expected: ExpectedPosition,
  actual: PositionSnapshot | null,
): PositionVerificationResult {
  const normalizedExpected = normalizeExpected(expected);
  if (actual === null) return unknown("SNAPSHOT_UNAVAILABLE");

  let snapshot: PositionSnapshot;
  try {
    snapshot = createPositionSnapshot(actual);
  } catch {
    return unknown("SNAPSHOT_INVALID");
  }
  if (snapshot.instrumentId !== normalizedExpected.instrumentId) {
    return unknown("INSTRUMENT_MISMATCH");
  }

  const directionMatches = snapshot.side === normalizedExpected.side;
  const quantityDifference = absoluteDifference(snapshot.quantity, normalizedExpected.quantity);
  const quantityMatches = compareUnsignedDecimals(quantityDifference, normalizedExpected.tolerance) <= 0;

  return Object.freeze({
    status: directionMatches && quantityMatches ? "MATCHED" : "MISMATCH",
    directionMatches,
    quantityMatches,
    quantityDifference,
    reason: null,
  });
}

function normalizeExpected(expected: ExpectedPosition): ExpectedPosition {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error("ExpectedPosition must be an object.");
  }
  const value = expected as Record<string, unknown>;
  const allowed = new Set(["instrumentId", "side", "quantity", "tolerance"]);
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey) throw new Error(`ExpectedPosition contains unsupported field: ${unknownKey}.`);
  if (typeof value.instrumentId !== "string") {
    throw new Error("instrumentId must be a canonical instrument id.");
  }
  if (!isPositionSide(value.side)) throw new Error("side must be LONG, SHORT, or FLAT.");

  const quantity = unsignedDecimal(value.quantity, "quantity");
  const tolerance = unsignedDecimal(value.tolerance, "tolerance");
  if (value.side === "FLAT" && quantity !== "0") {
    throw new Error("Expected FLAT position quantity must be zero.");
  }
  if (value.side !== "FLAT" && quantity === "0") {
    throw new Error("Expected LONG or SHORT position quantity must be greater than zero.");
  }

  return Object.freeze({
    instrumentId: canonicalInstrumentFromId(value.instrumentId).instrumentId,
    side: value.side,
    quantity,
    tolerance,
  });
}

function unknown(reason: PositionVerificationUnknownReason): PositionVerificationResult {
  return Object.freeze({
    status: "UNKNOWN",
    directionMatches: null,
    quantityMatches: null,
    quantityDifference: null,
    reason,
  });
}

function unsignedDecimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} must be an unsigned Decimal string.`);
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
}

function compareUnsignedDecimals(left: string, right: string) {
  const aligned = alignUnsignedDecimals(left, right);
  return aligned.left === aligned.right ? 0 : aligned.left > aligned.right ? 1 : -1;
}

function absoluteDifference(left: string, right: string) {
  const aligned = alignUnsignedDecimals(left, right);
  const difference = aligned.left >= aligned.right
    ? aligned.left - aligned.right
    : aligned.right - aligned.left;
  return formatScaledInteger(difference, aligned.scale);
}

function alignUnsignedDecimals(left: string, right: string) {
  const parsedLeft = parseUnsignedDecimal(left);
  const parsedRight = parseUnsignedDecimal(right);
  const scale = Math.max(parsedLeft.scale, parsedRight.scale);
  return {
    left: parsedLeft.value * 10n ** BigInt(scale - parsedLeft.scale),
    right: parsedRight.value * 10n ** BigInt(scale - parsedRight.scale),
    scale,
  };
}

function parseUnsignedDecimal(value: string) {
  const normalized = unsignedDecimal(value, "quantity");
  const [integer, fraction = ""] = normalized.split(".");
  return { value: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function formatScaledInteger(value: bigint, scale: number) {
  if (value === 0n) return "0";
  const digits = value.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${integer}.${fraction}` : integer;
}
