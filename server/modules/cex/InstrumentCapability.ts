import type {
  CanonicalInstrument,
  InstrumentContractType,
  InstrumentVenue,
  VenueInstrument,
  VenueInstrumentCategory,
  InstrumentTradingRules,
} from "./Instrument";

export class InstrumentCapability {
  resolveVenueInstrument(instrument: CanonicalInstrument, venue: string): VenueInstrument {
    if (venue !== "binance" && venue !== "okx" && venue !== "bybit" && venue !== "bitget") {
      throw new Error(`Unsupported venue: ${venue}.`);
    }
    return Object.freeze({
      venue,
      symbol: resolveVenueSymbol(instrument, venue),
      instId: resolveVenueInstId(instrument, venue),
      category: resolveVenueCategory(instrument.contractType, venue),
      contractIdentifier: resolveContractIdentifier(instrument, venue),
      tradingRules: resolveTradingRules(instrument.contractType, venue),
    });
  }
}

function resolveVenueSymbol(instrument: CanonicalInstrument, venue: InstrumentVenue) {
  const { baseAsset, quoteAsset, contractType } = instrument;
  if (venue === "okx") {
    return contractType === "spot"
      ? `${baseAsset}-${quoteAsset}`
      : `${baseAsset}-${quoteAsset}-SWAP`;
  }
  return `${baseAsset}${quoteAsset}`;
}

function resolveVenueInstId(instrument: CanonicalInstrument, venue: InstrumentVenue) {
  return resolveVenueSymbol(instrument, venue);
}

function resolveVenueCategory(contractType: InstrumentContractType, venue: InstrumentVenue): VenueInstrumentCategory {
  if (contractType === "spot") return "spot";
  if (venue === "okx") return "swap";
  return "linear";
}

function resolveContractIdentifier(instrument: CanonicalInstrument, venue: InstrumentVenue) {
  return `${venue}:${instrument.contractType}:${instrument.baseAsset}${instrument.quoteAsset}`;
}

function resolveTradingRules(contractType: InstrumentContractType, venue: InstrumentVenue): InstrumentTradingRules {
  void contractType;
  void venue;
  return Object.freeze({});
}
