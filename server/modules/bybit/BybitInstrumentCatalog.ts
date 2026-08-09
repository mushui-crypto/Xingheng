import type { InstrumentCatalogPort } from "../cex/CexCapabilityPorts";
import type { CanonicalInstrument } from "../cex/CexCanonicalModels";
import type { BybitLinearPerpetualInstrument } from "./BybitReadTypes";

type BybitInstrumentSource = () => Promise<{
  instruments: BybitLinearPerpetualInstrument[];
  fetchedAt: number;
}>;

export class BybitInstrumentCatalog implements InstrumentCatalogPort {
  readonly venue = "bybit" as const;

  constructor(private readonly source: BybitInstrumentSource) {}

  async getInstrument(instrumentId: string) {
    if (!instrumentId.startsWith("bybit:perpetual:linear:")) return null;
    return (await this.listInstruments()).find((instrument) => instrument.instrumentId === instrumentId) ?? null;
  }

  async listInstruments() {
    const snapshot = await this.source();
    return snapshot.instruments.map((instrument) => toCanonicalBybitInstrument(instrument, snapshot.fetchedAt));
  }
}

export function toCanonicalBybitInstrument(
  raw: BybitLinearPerpetualInstrument,
  fetchedAt: number,
): CanonicalInstrument {
  if (raw.contractType !== "LinearPerpetual") {
    throw new Error(`Unsupported Bybit contract type: ${raw.contractType}.`);
  }
  return {
    instrumentId: `bybit:perpetual:linear:${raw.baseCoin}:${raw.quoteCoin}:${raw.settleCoin}`,
    venue: "bybit",
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset: raw.baseCoin,
    quoteAsset: raw.quoteCoin,
    settlementAsset: raw.settleCoin,
    providerSymbol: raw.symbol,
    providerLocator: { category: "linear" },
    quantityUnit: "base",
    contractSize: 1,
    priceTick: providerNumber(raw.priceFilter.tickSize, "Bybit tickSize"),
    quantityStep: providerNumber(raw.lotSizeFilter.qtyStep, "Bybit qtyStep"),
    minQuantity: providerNumber(raw.lotSizeFilter.minOrderQty, "Bybit minOrderQty"),
    minNotional: providerNumber(raw.lotSizeFilter.minNotionalValue, "Bybit minNotionalValue"),
    status: raw.status === "Trading" ? "trading" : raw.status === "PreLaunch" ? "paused" : raw.status === "Settling" || raw.status === "Delivering" ? "close_only" : raw.status === "Closed" ? "delisted" : "unknown",
    fetchedAt,
  };
}

function providerNumber(value: string, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}
