import type { Asset } from "./Asset";
import type { InstrumentType } from "./Instrument";

export type Venue = "binance" | "okx" | "bybit" | "bitget";

export type VenueAsset = Readonly<{
  venue: Venue;
  symbol: string;
  reference?: Readonly<{
    namespace: string;
    identifier: string;
  }>;
}>;

export type AssetMapping = Readonly<{
  venueAsset: VenueAsset;
  canonicalAsset: Asset;
  confirmedBy: string;
}>;

export type TradingProductType = "SPOT" | "PERPETUAL_USDT";

export type CanonicalTradingProduct = Readonly<{
  productId: string;
  baseAsset: Asset;
  quoteAsset: Asset;
  productType: TradingProductType;
}>;

export function createVenueAsset(input: unknown): VenueAsset {
  const value = object(input, "VenueAsset");
  assertExactKeys(value, ["venue", "symbol", "reference"], "VenueAsset");
  if (!isVenue(value.venue)) throw new Error("venue is unsupported.");

  return Object.freeze({
    venue: value.venue,
    symbol: assetSymbol(value.symbol, "symbol"),
    ...(value.reference === undefined ? {} : { reference: reference(value.reference, "reference") }),
  });
}

export function createAssetMapping(input: unknown): AssetMapping {
  const value = object(input, "AssetMapping");
  assertExactKeys(value, ["venueAsset", "canonicalAsset", "confirmedBy"], "AssetMapping");

  const venueAsset = createVenueAsset(value.venueAsset);
  const canonicalAsset = asset(value.canonicalAsset, "canonicalAsset");

  if (venueAsset.reference && canonicalAsset.externalReference) {
    if (
      venueAsset.reference.namespace !== canonicalAsset.externalReference.namespace
      || venueAsset.reference.identifier !== canonicalAsset.externalReference.identifier
    ) {
      throw new Error("venue asset reference does not match canonical asset reference.");
    }
  }

  return Object.freeze({
    venueAsset,
    canonicalAsset,
    confirmedBy: nonEmptyString(value.confirmedBy, "confirmedBy"),
  });
}

export function createCanonicalTradingProduct(input: unknown): CanonicalTradingProduct {
  const value = object(input, "CanonicalTradingProduct");
  assertExactKeys(value, ["baseAsset", "quoteAsset", "productType"], "CanonicalTradingProduct");

  if (value.productType !== "SPOT" && value.productType !== "PERPETUAL_USDT") {
    throw new Error("productType must be SPOT or PERPETUAL_USDT.");
  }

  const baseAsset = asset(value.baseAsset, "baseAsset");
  const quoteAsset = asset(value.quoteAsset, "quoteAsset");
  if (baseAsset.symbol === quoteAsset.symbol) {
    throw new Error("baseAsset and quoteAsset must be different assets.");
  }
  if (value.productType === "PERPETUAL_USDT" && quoteAsset.symbol !== "USDT") {
    throw new Error("PERPETUAL_USDT product requires USDT quote asset.");
  }

  return Object.freeze({
    productId: `${baseAsset.symbol}-${quoteAsset.symbol}-${value.productType === "SPOT" ? "SPOT" : "PERP"}`,
    baseAsset,
    quoteAsset,
    productType: value.productType,
  });
}

export function tradingProductToInstrumentType(product: CanonicalTradingProduct): InstrumentType {
  return product.productType === "SPOT" ? "SPOT" : "PERPETUAL";
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

function isVenue(value: unknown): value is Venue {
  return value === "binance" || value === "okx" || value === "bybit" || value === "bitget";
}

function asset(value: unknown, name: string): Asset {
  const assetValue = object(value, name);
  assertExactKeys(assetValue, ["symbol", "type", "displayName", "externalReference"], name);
  const symbol = assetSymbol(assetValue.symbol, `${name}.symbol`);
  if (assetValue.type !== "DIGITAL_ASSET" && assetValue.type !== "RWA_ASSET") {
    throw new Error(`${name}.type must be DIGITAL_ASSET or RWA_ASSET.`);
  }
  return Object.freeze({
    symbol,
    type: assetValue.type,
    ...(assetValue.displayName === undefined ? {} : { displayName: nonEmptyString(assetValue.displayName, `${name}.displayName`) }),
    ...(assetValue.externalReference === undefined
      ? {}
      : { externalReference: reference(assetValue.externalReference, `${name}.externalReference`) }),
  });
}

function reference(input: unknown, name: string) {
  const value = object(input, name);
  assertExactKeys(value, ["namespace", "identifier"], name);
  return Object.freeze({
    namespace: nonEmptyString(value.namespace, `${name}.namespace`),
    identifier: nonEmptyString(value.identifier, `${name}.identifier`),
  });
}

function assetSymbol(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[A-Z0-9._:-]{2,40}$/u.test(value)) {
    throw new Error(`${name} must be an uppercase asset symbol.`);
  }
  return value;
}

function nonEmptyString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 120) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
