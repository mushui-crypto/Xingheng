import type { InstrumentVenue } from "../Instrument";
import { canonicalInstrumentFromId } from "../Instrument";
import { isPositionSide, type PositionSide } from "./PositionSide";

export type PositionSnapshot = Readonly<{
  venue: InstrumentVenue;
  accountId: string;
  instrumentId: string;
  side: PositionSide;
  /** Canonical base-asset quantity represented as an unsigned Decimal string. */
  quantity: string;
  fetchedAt: number;
}>;

export function createPositionSnapshot(input: unknown): PositionSnapshot {
  const value = object(input, "PositionSnapshot");
  assertExactKeys(value, [
    "venue",
    "accountId",
    "instrumentId",
    "side",
    "quantity",
    "fetchedAt",
  ], "PositionSnapshot");

  const side = positionSide(value.side);
  const quantity = unsignedDecimal(value.quantity, "quantity");
  assertSideQuantity(side, quantity);

  return Object.freeze({
    venue: venue(value.venue),
    accountId: identifier(value.accountId, "accountId"),
    instrumentId: instrumentId(value.instrumentId),
    side,
    quantity,
    fetchedAt: timestamp(value.fetchedAt, "fetchedAt"),
  });
}

function assertSideQuantity(side: PositionSide, quantity: string) {
  if (side === "FLAT" && quantity !== "0") {
    throw new Error("FLAT position quantity must be zero.");
  }
  if (side !== "FLAT" && quantity === "0") {
    throw new Error("LONG or SHORT position quantity must be greater than zero.");
  }
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

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}
