import { canonicalInstrumentFromId, type CanonicalInstrument } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";
import type { BitgetCategory } from "./BitgetTypes";

export type BitgetInstrumentResolution = Readonly<{
  canonicalInstrument: CanonicalInstrument;
  venueInstrument: Readonly<{
    venue: "bitget";
    symbol: string;
    category: BitgetCategory;
    contractType: "spot" | "linear_perpetual";
  }>;
}>;

/** Dynamically maps canonical USDT instruments without a symbol allow-list. */
export class BitgetInstrumentMappingAdapter {
  constructor(private readonly instruments = new InstrumentCapability()) {}

  resolve(input: string | CanonicalInstrument): BitgetInstrumentResolution {
    const canonical = typeof input === "string" ? canonicalInstrumentFromId(input) : normalizeCanonical(input);
    if (canonical.quoteAsset !== "USDT") throw new Error("Bitget execution supports USDT-quoted instruments only.");
    const venue = this.instruments.resolveVenueInstrument(canonical, "bitget");
    if (venue.symbol !== `${canonical.baseAsset}${canonical.quoteAsset}`) {
      throw new Error("Bitget instrument symbol identity is invalid.");
    }
    const category = canonical.contractType === "spot" ? "SPOT" as const : "USDT-FUTURES" as const;
    return Object.freeze({
      canonicalInstrument: canonical,
      venueInstrument: Object.freeze({
        venue: "bitget" as const,
        symbol: venue.symbol,
        category,
        contractType: canonical.contractType === "spot" ? "spot" as const : "linear_perpetual" as const,
      }),
    });
  }
}

function normalizeCanonical(input: CanonicalInstrument) {
  const canonical = canonicalInstrumentFromId(input.instrumentId);
  if (canonical.baseAsset !== input.baseAsset || canonical.quoteAsset !== input.quoteAsset
    || canonical.contractType !== input.contractType) {
    throw new Error("Canonical instrument identity does not match its fields.");
  }
  return canonical;
}
