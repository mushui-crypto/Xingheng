import type { InstrumentCatalogPort } from "../cex/CexCapabilityPorts";
import type { CanonicalInstrument } from "../cex/CexCanonicalModels";
import { canonicalInstrumentId } from "../cex/Instrument";
import type { OkxSwapInstrument } from "./OkxReadTypes";
import type { OkxQuantityRulesSnapshot } from "./OkxQuantitySemantics";

type OkxInstrumentSource = () => Promise<{ instruments: OkxSwapInstrument[]; fetchedAt: number }>;
type CatalogDiagnostic = Readonly<{ venue: "okx"; skipped: number; reasons: Readonly<Record<string, number>> }>;

export class OkxInstrumentCatalog implements InstrumentCatalogPort {
  readonly venue = "okx" as const;

  constructor(
    private readonly source: OkxInstrumentSource,
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
        instruments.push(toCanonicalOkxInstrument(instrument, snapshot.fetchedAt));
      } catch (error) {
        const reason = error instanceof Error && error.message.startsWith("Unsupported OKX contract type:")
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
  console.warn("[okx-instrument-catalog] skipped unsupported or invalid instruments", diagnostic);
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

export function toOkxQuantityRules(raw: OkxSwapInstrument, fetchedAt: number): OkxQuantityRulesSnapshot {
  return Object.freeze({
    instType: raw.instType,
    instId: raw.instId,
    uly: raw.uly,
    ctType: raw.ctType,
    ctValCcy: raw.ctValCcy,
    settleCcy: raw.settleCcy,
    lotSz: raw.lotSz,
    minSz: raw.minSz,
    ctVal: raw.ctVal,
    state: raw.state,
    fetchedAt,
  });
}

function providerNumber(value: string, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}
