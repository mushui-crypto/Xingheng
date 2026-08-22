import type { InstrumentVenue } from "../Instrument";
import { canonicalInstrumentFromId } from "../Instrument";
import { isPositionSide, type PositionSide } from "./PositionSide";

export type PositionSnapshot = Readonly<{
  venue: InstrumentVenue;
  accountId: string;
  instrumentId: string;
  positionMode: PositionMode;
  side: PositionSide;
  /** Canonical base-asset quantity represented as an unsigned Decimal string. */
  quantity: string;
  /** Signed net quantity. Authoritative only for ONE_WAY snapshots. */
  signedNetQuantity: string | null;
  /** HEDGE bucket quantities; also populated as derived buckets for ONE_WAY. */
  longQuantity: string;
  shortQuantity: string;
  fetchedAt: number;
}>;

export type PositionMode = "ONE_WAY" | "HEDGE";

export type PositionSnapshotInput = Readonly<{
  venue: InstrumentVenue;
  accountId: string;
  instrumentId: string;
  positionMode?: PositionMode;
  side: PositionSide;
  quantity: string;
  signedNetQuantity?: string | null;
  longQuantity?: string;
  shortQuantity?: string;
  fetchedAt: number;
}>;

export function createPositionSnapshot(input: PositionSnapshotInput | unknown): PositionSnapshot {
  const value = object(input, "PositionSnapshot");
  assertExactKeys(value, [
    "venue",
    "accountId",
    "instrumentId",
    "positionMode",
    "side",
    "quantity",
    "signedNetQuantity",
    "longQuantity",
    "shortQuantity",
    "fetchedAt",
  ], "PositionSnapshot");

  const mode = positionMode(value.positionMode);
  const side = positionSide(value.side);
  const quantity = unsignedDecimal(value.quantity, "quantity");
  assertSideQuantity(mode, side, quantity);
  const signedNetQuantity = mode === "ONE_WAY"
    ? signedDecimal(value.signedNetQuantity ?? (side === "SHORT" ? `-${quantity}` : quantity), "signedNetQuantity")
    : null;
  if (mode === "HEDGE" && (value.longQuantity === undefined || value.shortQuantity === undefined)) {
    throw new Error("HEDGE position buckets are required.");
  }
  const longQuantity = unsignedDecimal(
    value.longQuantity ?? (mode === "ONE_WAY" && side === "LONG" ? quantity : "0"),
    "longQuantity",
  );
  const shortQuantity = unsignedDecimal(
    value.shortQuantity ?? (mode === "ONE_WAY" && side === "SHORT" ? quantity : "0"),
    "shortQuantity",
  );
  if (mode === "HEDGE" && longQuantity === "0" && shortQuantity === "0" && quantity !== "0") {
    throw new Error("HEDGE position buckets cannot both be zero for a non-flat quantity.");
  }
  if (mode === "HEDGE" && quantity !== addUnsigned(longQuantity, shortQuantity)) {
    throw new Error("HEDGE position quantity must equal the long and short buckets.");
  }

  return Object.freeze({
    venue: venue(value.venue),
    accountId: identifier(value.accountId, "accountId"),
    instrumentId: instrumentId(value.instrumentId),
    positionMode: mode,
    side,
    quantity,
    signedNetQuantity,
    longQuantity,
    shortQuantity,
    fetchedAt: timestamp(value.fetchedAt, "fetchedAt"),
  });
}

function assertSideQuantity(mode: PositionMode, side: PositionSide, quantity: string) {
  if (mode === "HEDGE") return;
  if (side === "FLAT" && quantity !== "0") {
    throw new Error("FLAT position quantity must be zero.");
  }
  if (side !== "FLAT" && quantity === "0") {
    throw new Error("LONG or SHORT position quantity must be greater than zero.");
  }
}

export function createHedgePositionSnapshot(input: Readonly<{
  venue: InstrumentVenue;
  accountId: string;
  instrumentId: string;
  longQuantity: string;
  shortQuantity: string;
  fetchedAt: number;
}>): PositionSnapshot {
  const longQuantity = unsignedDecimal(input.longQuantity, "longQuantity");
  const shortQuantity = unsignedDecimal(input.shortQuantity, "shortQuantity");
  const side = longQuantity !== "0" && shortQuantity !== "0"
    ? "FLAT" as const
    : longQuantity !== "0" ? "LONG" as const
      : shortQuantity !== "0" ? "SHORT" as const : "FLAT" as const;
  return createPositionSnapshot({
    ...input,
    positionMode: "HEDGE",
    side,
    quantity: addUnsigned(longQuantity, shortQuantity),
    longQuantity,
    shortQuantity,
    signedNetQuantity: null,
  });
}

function positionMode(value: unknown): PositionMode {
  if (value === undefined || value === "ONE_WAY") return "ONE_WAY";
  if (value === "HEDGE") return "HEDGE";
  throw new Error("positionMode must be ONE_WAY or HEDGE.");
}

function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  const allowedKeys = new Set(allowed);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`${name} contains unsupported field: ${unknownKey}.`);
}

function venue(value: unknown): InstrumentVenue {
  if (value !== "binance" && value !== "okx" && value !== "bybit" && value !== "bitget") {
    throw new Error("venue must be binance, okx, bybit, or bitget.");
  }
  return value;
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function instrumentId(value: unknown) {
  if (typeof value !== "string") throw new Error("instrumentId must be a canonical instrument id.");
  return canonicalInstrumentFromId(value).instrumentId;
}

function positionSide(value: unknown): PositionSide {
  if (!isPositionSide(value)) throw new Error("side must be LONG, SHORT, or FLAT.");
  return value;
}

function unsignedDecimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} must be an unsigned Decimal string.`);
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
}

function signedDecimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} must be a signed Decimal string.`);
  }
  if (value === "-0") return "0";
  const negative = value.startsWith("-");
  const unsigned = unsignedDecimal(negative ? value.slice(1) : value, name);
  return negative && unsigned !== "0" ? `-${unsigned}` : unsigned;
}

function addUnsigned(left: string, right: string) {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const scale = Math.max(leftParts[1]?.length ?? 0, rightParts[1]?.length ?? 0);
  const leftValue = BigInt(`${leftParts[0]}${(leftParts[1] ?? "").padEnd(scale, "0")}`);
  const rightValue = BigInt(`${rightParts[0]}${(rightParts[1] ?? "").padEnd(scale, "0")}`);
  const value = leftValue + rightValue;
  if (value === 0n) return "0";
  const digits = value.toString().padStart(scale + 1, "0");
  if (!scale) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${digits.slice(0, -scale)}.${fraction}` : digits.slice(0, -scale);
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}
