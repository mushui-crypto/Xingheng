import type { Asset } from "./Asset";
import type { TradingRules } from "./TradingRules";

export type InstrumentContractType = "spot" | "perpetual";

export type InstrumentType = "SPOT" | "PERPETUAL";

export type Instrument = Readonly<{
  instrumentId: string;
  baseAsset: Asset;
  quoteAsset: Asset;
  instrumentType: InstrumentType;
}>;

export type CanonicalInstrument = Readonly<{
  instrumentId: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: InstrumentContractType;
}>;

export type InstrumentTradingRules = Partial<TradingRules>;

export type InstrumentVenue = "binance" | "okx" | "bybit" | "bitget";

export type VenueInstrumentCategory = "spot" | "linear" | "swap";

export type VenueInstrument = Readonly<{
  venue: InstrumentVenue;
  symbol: string;
  instId: string;
  category: VenueInstrumentCategory;
  contractIdentifier: string;
  tradingRules: InstrumentTradingRules;
}>;

export function createInstrument(input: unknown): Instrument {
  const value = object(input, "Instrument");
  assertExactKeys(value, ["baseAsset", "quoteAsset", "instrumentType"], "Instrument");

  if (value.instrumentType !== "SPOT" && value.instrumentType !== "PERPETUAL") {
    throw new Error("instrumentType must be SPOT or PERPETUAL.");
  }

  const baseAsset = assetObject(value.baseAsset, "baseAsset");
  const quoteAsset = assetObject(value.quoteAsset, "quoteAsset");
  if (baseAsset.symbol === quoteAsset.symbol) {
    throw new Error("baseAsset and quoteAsset must be different assets.");
  }

  return Object.freeze({
    instrumentId: `${baseAsset.symbol}-${quoteAsset.symbol}-${value.instrumentType === "SPOT" ? "SPOT" : "PERP"}`,
    baseAsset,
    quoteAsset,
    instrumentType: value.instrumentType,
  });
}

export function toCanonicalInstrument(instrument: Instrument): CanonicalInstrument {
  return Object.freeze({
    instrumentId: instrument.instrumentId,
    baseAsset: instrument.baseAsset.symbol,
    quoteAsset: instrument.quoteAsset.symbol,
    contractType: instrument.instrumentType === "SPOT" ? "spot" : "perpetual",
  });
}

export function createCanonicalInstrument(input: unknown): CanonicalInstrument {
  const value = object(input);
  assertExactKeys(value, ["baseAsset", "quoteAsset", "contractType"], "CanonicalInstrument");

  if (value.contractType !== "spot" && value.contractType !== "perpetual") {
    throw new Error("contractType must be spot or perpetual.");
  }

  return Object.freeze({
    instrumentId: canonicalInstrumentId(
      asset(value.baseAsset, "baseAsset"),
      asset(value.quoteAsset, "quoteAsset"),
      value.contractType,
    ),
    baseAsset: asset(value.baseAsset, "baseAsset"),
    quoteAsset: asset(value.quoteAsset, "quoteAsset"),
    contractType: value.contractType,
  });
}

export function canonicalInstrumentId(
  baseAsset: string,
  quoteAsset: string,
  contractType: InstrumentContractType,
) {
  return `${asset(baseAsset, "baseAsset")}-${asset(quoteAsset, "quoteAsset")}-${contractType === "spot" ? "SPOT" : "PERP"}`;
}

export function canonicalInstrumentFromId(instrumentId: string): CanonicalInstrument {
  const match = /^([A-Z0-9]{2,12})-([A-Z0-9]{2,12})-(SPOT|PERP)$/u.exec(instrumentId);
  if (!match) throw new Error(`Invalid canonical instrument id: ${instrumentId}.`);
  return Object.freeze({
    instrumentId,
    baseAsset: match[1]!,
    quoteAsset: match[2]!,
    contractType: match[3] === "SPOT" ? "spot" : "perpetual",
  });
}

function object(value: unknown, name = "CanonicalInstrument") {
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

function asset(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[A-Z0-9]{2,12}$/u.test(value)) {
    throw new Error(`${name} must be an uppercase asset symbol.`);
  }
  return value;
}

function assetObject(value: unknown, name: string): Asset {
  const assetValue = object(value, name);
  assertExactKeys(assetValue, ["symbol", "type", "displayName", "externalReference"], name);
  const symbol = asset(assetValue.symbol, `${name}.symbol`);
  if (assetValue.type !== "DIGITAL_ASSET" && assetValue.type !== "RWA_ASSET") {
    throw new Error(`${name}.type must be DIGITAL_ASSET or RWA_ASSET.`);
  }
  if (assetValue.displayName !== undefined && (typeof assetValue.displayName !== "string" || !assetValue.displayName.trim())) {
    throw new Error(`${name}.displayName is invalid.`);
  }
  if (assetValue.externalReference !== undefined) {
    const reference = object(assetValue.externalReference, `${name}.externalReference`);
    assertExactKeys(reference, ["namespace", "identifier"], `${name}.externalReference`);
    if (typeof reference.namespace !== "string" || !reference.namespace.trim()) {
      throw new Error(`${name}.externalReference.namespace is invalid.`);
    }
    if (typeof reference.identifier !== "string" || !reference.identifier.trim()) {
      throw new Error(`${name}.externalReference.identifier is invalid.`);
    }
  }
  return Object.freeze({
    symbol,
    type: assetValue.type,
    ...(assetValue.displayName === undefined ? {} : { displayName: assetValue.displayName.trim() }),
    ...(assetValue.externalReference === undefined
      ? {}
      : {
          externalReference: Object.freeze({
            namespace: String((assetValue.externalReference as Record<string, unknown>).namespace).trim(),
            identifier: String((assetValue.externalReference as Record<string, unknown>).identifier).trim(),
          }),
        }),
  });
}
