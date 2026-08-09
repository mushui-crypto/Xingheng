import type { InstrumentCatalogPort } from "../cex/CexCapabilityPorts";
import type { CanonicalInstrument } from "../cex/CexCanonicalModels";
import type { BitgetUsdtPerpetualInstrument } from "./BitgetReadTypes";

type BitgetInstrumentSource = () => Promise<{
  instruments: BitgetUsdtPerpetualInstrument[];
  fetchedAt: number;
}>;

export class BitgetInstrumentCatalog implements InstrumentCatalogPort {
  readonly venue = "bitget" as const;

  constructor(private readonly source: BitgetInstrumentSource) {}

  async getInstrument(instrumentId: string) {
    if (!instrumentId.startsWith("bitget:perpetual:linear:")) return null;
    return (await this.listInstruments()).find((instrument) => instrument.instrumentId === instrumentId) ?? null;
  }

  async listInstruments() {
    const snapshot = await this.source();
    return snapshot.instruments.map((instrument) => toCanonicalBitgetInstrument(instrument, snapshot.fetchedAt));
  }
}

export function toCanonicalBitgetInstrument(
  raw: BitgetUsdtPerpetualInstrument,
  fetchedAt: number,
): CanonicalInstrument {
  if (raw.type !== "perpetual") throw new Error(`Unsupported Bitget instrument type: ${raw.type}.`);
  return {
    instrumentId: `bitget:perpetual:linear:${raw.baseCoin}:${raw.quoteCoin}:${raw.quoteCoin}`,
    venue: "bitget",
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset: raw.baseCoin,
    quoteAsset: raw.quoteCoin,
    settlementAsset: raw.quoteCoin,
    providerSymbol: raw.symbol,
    providerLocator: { category: raw.category },
    quantityUnit: "base",
    contractSize: 1,
    priceTick: providerNumber(raw.priceMultiplier, "Bitget priceMultiplier"),
    quantityStep: providerNumber(raw.quantityMultiplier, "Bitget quantityMultiplier"),
    minQuantity: providerNumber(raw.minOrderQty, "Bitget minOrderQty"),
    minNotional: providerNumber(raw.minOrderAmount, "Bitget minOrderAmount"),
    status: raw.status === "online" ? "trading" : raw.status === "limit_open" ? "close_only" : raw.status === "listed" ? "paused" : raw.status === "offline" ? "delisted" : "unknown",
    fetchedAt,
  };
}

function providerNumber(value: string, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}
