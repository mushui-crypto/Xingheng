import type { InstrumentCatalogPort } from "../cex/CexCapabilityPorts";
import type { CanonicalInstrument } from "../cex/CexCanonicalModels";
import { canonicalInstrumentId } from "../cex/Instrument";
import type { BitgetUsdtPerpetualInstrument } from "./BitgetReadTypes";

type BitgetInstrumentSource = () => Promise<{
  instruments: BitgetUsdtPerpetualInstrument[];
  fetchedAt: number;
}>;
type CatalogDiagnostic = Readonly<{ venue: "bitget"; skipped: number; reasons: Readonly<Record<string, number>> }>;

export class BitgetInstrumentCatalog implements InstrumentCatalogPort {
  readonly venue = "bitget" as const;

  constructor(
    private readonly source: BitgetInstrumentSource,
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
        instruments.push(toCanonicalBitgetInstrument(instrument, snapshot.fetchedAt));
      } catch (error) {
        const reason = error instanceof Error && error.message.startsWith("Unsupported Bitget instrument type:")
          ? "unsupported_instrument_type"
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
  console.warn("[bitget-instrument-catalog] skipped unsupported or invalid instruments", diagnostic);
}

export function toCanonicalBitgetInstrument(
  raw: BitgetUsdtPerpetualInstrument,
  fetchedAt: number,
): CanonicalInstrument {
  if (raw.symbolType !== "perpetual") {
    throw new Error(`Unsupported Bitget instrument type: ${raw.symbolType}.`);
  }
  return {
    instrumentId: canonicalInstrumentId(raw.baseCoin, raw.quoteCoin, "perpetual"),
    venue: "bitget",
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset: raw.baseCoin,
    quoteAsset: raw.quoteCoin,
    settlementAsset: raw.quoteCoin,
    providerSymbol: raw.symbol,
    providerLocator: { category: "USDT-FUTURES" },
    quantityUnit: "base",
    contractSize: 1,
    priceTick: priceTick(raw.priceEndStep, raw.pricePlace),
    quantityStep: providerNumber(raw.sizeMultiplier, "Bitget sizeMultiplier"),
    minQuantity: providerNumber(raw.minTradeNum, "Bitget minTradeNum"),
    minNotional: providerNumber(raw.minTradeUSDT, "Bitget minTradeUSDT"),
    status: raw.symbolStatus === "normal" ? "trading" : "unknown",
    fetchedAt,
  };
}

function priceTick(step: string, place: string) {
  const normalizedStep = providerNumber(step, "Bitget priceEndStep");
  const precision = Number(place);
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 18) {
    throw new Error(`Invalid Bitget pricePlace: ${place}.`);
  }
  return normalizedStep * (10 ** -precision);
}

function providerNumber(value: string, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}
