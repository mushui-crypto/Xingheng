import type { InstrumentCatalogPort } from "../cex/CexCapabilityPorts";
import type { CanonicalInstrument } from "../cex/CexCanonicalModels";
import { canonicalInstrumentId } from "../cex/Instrument";
import type { OkxSwapInstrument } from "./OkxReadTypes";

type OkxInstrumentSource = () => Promise<{ instruments: OkxSwapInstrument[]; fetchedAt: number }>;

export class OkxInstrumentCatalog implements InstrumentCatalogPort {
  readonly venue = "okx" as const;

  constructor(private readonly source: OkxInstrumentSource) {}

  async getInstrument(instrumentId: string) {
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
    instrumentId: canonicalInstrumentId(raw.ctValCcy, raw.settleCcy, "perpetual"),
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
