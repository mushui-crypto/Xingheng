import type { CexVenue } from "./CexCanonicalModels";

export type CexReadCapability = "instrument_catalog" | "funding_rate" | "market_data";

export type VenueReadCapabilityDescriptor = Readonly<{
  venue: CexVenue;
  capabilities: readonly CexReadCapability[];
}>;

export class CexReadCapabilityRegistry {
  private readonly descriptors = new Map<CexVenue, VenueReadCapabilityDescriptor>();

  register(descriptor: VenueReadCapabilityDescriptor) {
    if (this.descriptors.has(descriptor.venue)) {
      throw new Error(`Read capabilities already registered for venue: ${descriptor.venue}.`);
    }
    const capabilities = [...new Set(descriptor.capabilities)];
    if (capabilities.length !== descriptor.capabilities.length) {
      throw new Error(`Duplicate read capability for venue: ${descriptor.venue}.`);
    }
    this.descriptors.set(descriptor.venue, Object.freeze({
      venue: descriptor.venue,
      capabilities: Object.freeze(capabilities),
    }));
    return this;
  }

  lookup(venue: CexVenue) {
    return this.descriptors.get(venue);
  }

  hasCapability(venue: CexVenue, capability: CexReadCapability) {
    return this.lookup(venue)?.capabilities.includes(capability) ?? false;
  }

  list() {
    return [...this.descriptors.values()];
  }
}

export const cexReadCapabilityRegistry = new CexReadCapabilityRegistry()
  .register({ venue: "binance", capabilities: ["instrument_catalog", "funding_rate", "market_data"] })
  .register({ venue: "okx", capabilities: ["instrument_catalog", "funding_rate", "market_data"] })
  .register({ venue: "bitget", capabilities: ["instrument_catalog", "funding_rate", "market_data"] })
  .register({ venue: "bybit", capabilities: ["instrument_catalog", "funding_rate", "market_data"] });
