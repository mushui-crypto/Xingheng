import type { InstrumentCatalogPort } from "../cex/CexCapabilityPorts";
import type { CanonicalInstrument } from "../cex/CexCanonicalModels";
import { canonicalInstrumentId } from "../cex/Instrument";
import type { BybitLinearPerpetualInstrument } from "./BybitReadTypes";

type BybitInstrumentSource = () => Promise<{
  instruments: BybitLinearPerpetualInstrument[];
  fetchedAt: number;
}>;
type CatalogDiagnostic = Readonly<{ venue: "bybit"; skipped: number; reasons: Readonly<Record<string, number>> }>;

export class BybitInstrumentCatalog implements InstrumentCatalogPort {
  readonly venue = "bybit" as const;

  constructor(
    private readonly source: BybitInstrumentSource,
    private readonly reportDiagnostic: (diagnostic: CatalogDiagnostic) => void = defaultDiagnostic,
  ) {}

  async getInstrument(instrumentId: string) {
    return (await this.listInstruments()).find((instrument) => instrument.instrumentId === instrumentId) ?? null;
  }

  async listInstruments() {
    const snapshot = await this.source();
    const instruments: CanonicalInstrument[] = [];
    const reasons: Record<string, number> = {};
    for (const instrument of snapshot.instruments) {
      try {
        instruments.push(toCanonicalBybitInstrument(instrument, snapshot.fetchedAt));
      } catch (error) {
        const reason = error instanceof Error && error.message.startsWith("Unsupported Bybit contract type:")
          ? "unsupported_contract_type"
          : "invalid_instrument";
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
    }
    const skipped = snapshot.instruments.length - instruments.length;
    if (skipped > 0) this.reportDiagnostic({ venue: this.venue, skipped, reasons: Object.freeze(reasons) });
    return instruments;
  }
}

function defaultDiagnostic(diagnostic: CatalogDiagnostic) {
  console.warn("[bybit-instrument-catalog] skipped unsupported or invalid instruments", diagnostic);
}

export function toCanonicalBybitInstrument(
  raw: BybitLinearPerpetualInstrument,
  fetchedAt: number,
): CanonicalInstrument {
  if (raw.contractType !== "LinearPerpetual") {
    throw new Error(`Unsupported Bybit contract type: ${raw.contractType}.`);
  }
  return {
    instrumentId: canonicalInstrumentId(raw.baseCoin, raw.quoteCoin, "perpetual"),
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
