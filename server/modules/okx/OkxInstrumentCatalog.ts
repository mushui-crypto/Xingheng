import type { InstrumentCatalogPort } from "../cex/CexCapabilityPorts";
import type { CanonicalInstrument } from "../cex/CexCanonicalModels";
import type { OkxSwapInstrument } from "./OkxReadTypes";

type OkxInstrumentSource = () => Promise<{ instruments: OkxSwapInstrument[]; fetchedAt: number }>;

export class OkxInstrumentCatalog implements InstrumentCatalogPort {
  readonly venue = "okx" as const;

  constructor(private readonly source: OkxInstrumentSource) {}

  async getInstrument(instrumentId: string) {
    if (!instrumentId.startsWith("okx:perpetual:linear:")) return null;
    return (await this.listInstruments()).find((instrument) => instrument.instrumentId === instrumentId) ?? null;
  }

  async listInstruments() {
    const snapshot = await this.source();
    return snapshot.instruments.map((instrument) => toCanonicalOkxInstrument(instrument, snapshot.fetchedAt));
  }
}

export function toCanonicalOkxInstrument(raw: OkxSwapInstrument, fetchedAt: number): CanonicalInstrument {
  if (raw.ctType !== "linear") throw new Error(`Unsupported OKX contract type: ${raw.ctType}.`);
  const expectedUnderlying = `${raw.ctValCcy}-${raw.settleCcy}`;
  if (raw.uly !== expectedUnderlying) {
    throw new Error(`Unsupported OKX underlying: ${raw.uly}.`);
  }
  return {
    instrumentId: `okx:perpetual:linear:${raw.ctValCcy}:${raw.settleCcy}:${raw.settleCcy}`,
    venue: "okx",
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset: raw.ctValCcy,
    quoteAsset: raw.settleCcy,
    settlementAsset: raw.settleCcy,
    providerSymbol: raw.instId,
    providerLocator: { instType: raw.instType },
    quantityUnit: "contract",
    contractSize: providerNumber(raw.ctVal, "OKX ctVal"),
    priceTick: providerNumber(raw.tickSz, "OKX tickSz"),
    quantityStep: providerNumber(raw.lotSz, "OKX lotSz"),
    minQuantity: providerNumber(raw.minSz, "OKX minSz"),
    minNotional: null,
    status: raw.state === "live" ? "trading" : raw.state === "suspend" ? "paused" : raw.state === "preopen" ? "paused" : raw.state === "expired" ? "delisted" : "unknown",
    fetchedAt,
  };
}

function providerNumber(value: string, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}
