import { canonicalInstrumentFromId, type CanonicalInstrument } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";
import type { BybitCategory } from "./BybitTypes";

export type BybitInstrumentResolution = Readonly<{
  canonicalInstrument: CanonicalInstrument;
  venueInstrument: Readonly<{
    venue: "bybit";
    symbol: string;
    category: BybitCategory;
    contractType: "spot" | "linear_perpetual";
  }>;
}>;

/** Dynamically maps canonical USDT instruments without a symbol allow-list. */
export class BybitInstrumentMappingAdapter {
  constructor(private readonly instruments = new InstrumentCapability()) {}

  resolve(input: string | CanonicalInstrument): BybitInstrumentResolution {
    const canonical = typeof input === "string" ? canonicalInstrumentFromId(input) : normalizeCanonical(input);
    if (canonical.quoteAsset !== "USDT") {
      throw new Error("Bybit execution supports USDT-quoted instruments only.");
    }
    const venue = this.instruments.resolveVenueInstrument(canonical, "bybit");
    if (venue.symbol !== `${canonical.baseAsset}${canonical.quoteAsset}`) {
      throw new Error("Bybit instrument symbol identity is invalid.");
    }
    const category = canonical.contractType === "spot" ? "spot" as const : "linear" as const;
    if (venue.category !== category) {
      throw new Error("Bybit instrument category identity is invalid.");
    }
    return Object.freeze({
      canonicalInstrument: canonical,
      venueInstrument: Object.freeze({
        venue: "bybit" as const,
        symbol: venue.symbol,
        category,
        contractType: canonical.contractType === "spot" ? "spot" as const : "linear_perpetual" as const,
      }),
    });
  }
}

function normalizeCanonical(input: CanonicalInstrument) {
  const canonical = canonicalInstrumentFromId(input.instrumentId);
  if (canonical.baseAsset !== input.baseAsset
    || canonical.quoteAsset !== input.quoteAsset
    || canonical.contractType !== input.contractType) {
    throw new Error("Canonical instrument identity does not match its fields.");
  }
  return canonical;
}
