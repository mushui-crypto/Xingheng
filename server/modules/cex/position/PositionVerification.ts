import { canonicalInstrumentFromId } from "../Instrument";
import { createPositionSnapshot, type PositionMode, type PositionSnapshot } from "./PositionSnapshot";
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

export type ExecutionDeltaVerificationRequest = Readonly<{
  instrumentId: string;
  positionMode: PositionMode;
  positionDirection: "LONG" | "SHORT";
  /** Signed ONE_WAY delta, or unsigned magnitude for HEDGE. */
  executionDelta: string;
  /** Mutation-time baseline; it is not an ownership source. */
  baseline: PositionSnapshot;
  tolerance: string;
}>;

export type ExecutionDeltaVerificationResult = Readonly<{
  status: PositionVerificationStatus;
  expectedSignedNetQuantity: string | null;
  observedSignedNetQuantity: string | null;
  expectedBucketQuantity: string | null;
  observedBucketQuantity: string | null;
  quantityDifference: string | null;
  reason: PositionVerificationUnknownReason | "POSITION_MODE_MISMATCH" | "POSITION_BUCKET_UNAVAILABLE" | null;
}>;

/** Converts a canonical position snapshot to its signed net-base quantity. */
export function signedCurrentNet(snapshot: PositionSnapshot) {
  const normalized = createPositionSnapshot(snapshot);
  if (normalized.positionMode === "ONE_WAY" && normalized.signedNetQuantity !== null) {
    return normalized.signedNetQuantity;
  }
  return null;
}

/** Verifies only the result of one execution delta against its read baseline. */
export function verifyExecutionDelta(
  request: ExecutionDeltaVerificationRequest,
  actual: PositionSnapshot | null,
): ExecutionDeltaVerificationResult {
  if (actual === null) return deltaUnknown("SNAPSHOT_UNAVAILABLE");
  let baseline: PositionSnapshot;
  let observed: PositionSnapshot;
  try {
    baseline = createPositionSnapshot(request.baseline);
    observed = createPositionSnapshot(actual);
  } catch {
    return deltaUnknown("SNAPSHOT_INVALID");
  }
  const instrumentId = canonicalInstrumentFromId(request.instrumentId).instrumentId;
  if (baseline.instrumentId !== instrumentId || observed.instrumentId !== instrumentId) {
    return deltaUnknown("INSTRUMENT_MISMATCH");
  }
  if (baseline.positionMode !== request.positionMode || observed.positionMode !== request.positionMode) {
    return deltaUnknown("POSITION_MODE_MISMATCH");
  }
  const tolerance = unsignedDecimal(request.tolerance, "tolerance");
  const delta = normalizeSignedDecimal(request.executionDelta, "executionDelta");
  if (request.positionMode === "ONE_WAY") {
    const baselineNet = signedCurrentNet(baseline);
    const observedNet = signedCurrentNet(observed);
    if (baselineNet === null || observedNet === null) return deltaUnknown("POSITION_MODE_MISMATCH");
    const expected = addSigned(baselineNet, delta);
    const difference = absoluteDifference(unsignedMagnitude(expected), unsignedMagnitude(observedNet));
    return Object.freeze({
      status: compareUnsignedDecimals(difference, tolerance) <= 0 ? "MATCHED" : "MISMATCH",
      expectedSignedNetQuantity: expected,
      observedSignedNetQuantity: observedNet,
      expectedBucketQuantity: null,
      observedBucketQuantity: null,
      quantityDifference: difference,
      reason: null,
    });
  }

  const magnitude = unsignedMagnitude(delta);
  const baselineBucket = request.positionDirection === "LONG" ? baseline.longQuantity : baseline.shortQuantity;
  const observedBucket = request.positionDirection === "LONG" ? observed.longQuantity : observed.shortQuantity;
  const expectedBucket = addUnsigned(baselineBucket, magnitude);
  const difference = absoluteDifference(expectedBucket, observedBucket);
  return Object.freeze({
    status: compareUnsignedDecimals(difference, tolerance) <= 0 ? "MATCHED" : "MISMATCH",
    expectedSignedNetQuantity: null,
    observedSignedNetQuantity: null,
    expectedBucketQuantity: expectedBucket,
    observedBucketQuantity: observedBucket,
    quantityDifference: difference,
    reason: null,
  });
}

/**
 * A reversal can use reduce-only only when the managed slice being reversed
 * reduces the account's current net position without crossing flat. It does
 * not establish ownership.
 */
export function reduceOnlyEligible(currentNet: string, managedSliceToReverse: string) {
  const current = normalizeSignedDecimal(currentNet, "currentNet");
  const managed = normalizeSignedDecimal(managedSliceToReverse, "managedSliceToReverse");
  if (current === "0" || managed === "0" || isNegative(current) !== isNegative(managed)) return false;
  return compareUnsignedDecimals(unsignedMagnitude(current), unsignedMagnitude(managed)) >= 0;
}

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

function deltaUnknown(reason: ExecutionDeltaVerificationResult["reason"]): ExecutionDeltaVerificationResult {
  return Object.freeze({
    status: "UNKNOWN",
    expectedSignedNetQuantity: null,
    observedSignedNetQuantity: null,
    expectedBucketQuantity: null,
    observedBucketQuantity: null,
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

function normalizeSignedDecimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} must be a signed Decimal string.`);
  }
  const negative = value.startsWith("-");
  const normalized = unsignedDecimal(negative ? value.slice(1) : value, name);
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

function addSigned(left: string, right: string) {
  const leftNegative = isNegative(left);
  const rightNegative = isNegative(right);
  if (leftNegative === rightNegative) {
    const sum = addUnsigned(unsignedMagnitude(left), unsignedMagnitude(right));
    return leftNegative && sum !== "0" ? `-${sum}` : sum;
  }
  const leftMagnitude = unsignedMagnitude(left);
  const rightMagnitude = unsignedMagnitude(right);
  const comparison = compareUnsignedDecimals(leftMagnitude, rightMagnitude);
  if (comparison === 0) return "0";
  const difference = comparison > 0
    ? absoluteDifference(leftMagnitude, rightMagnitude)
    : absoluteDifference(rightMagnitude, leftMagnitude);
  const negative = comparison > 0 ? leftNegative : rightNegative;
  return negative ? `-${difference}` : difference;
}

function addUnsigned(left: string, right: string) {
  const aligned = alignUnsignedDecimals(left, right);
  return formatScaledInteger(aligned.left + aligned.right, aligned.scale);
}

function isNegative(value: string) {
  return value.startsWith("-");
}

function unsignedMagnitude(value: string) {
  return isNegative(value) ? value.slice(1) : value;
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
