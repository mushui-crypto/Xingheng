import type { FundingRatePort } from "../cex/CexCapabilityPorts";
import type { CanonicalFundingRate } from "../cex/CexCanonicalModels";
import type { BitgetFundingRateRecord, BitgetInstrumentBinding } from "./BitgetReadTypes";

type BitgetFundingSource = (symbol: string) => Promise<{
  fundingRate: BitgetFundingRateRecord;
  fetchedAt: number;
}>;

export class BitgetFundingRate implements FundingRatePort {
  readonly venue = "bitget" as const;
  private readonly providerSymbols: ReadonlyMap<string, string>;

  constructor(private readonly source: BitgetFundingSource, bindings: readonly BitgetInstrumentBinding[]) {
    this.providerSymbols = new Map(bindings.map((binding) => [binding.instrumentId, binding.providerSymbol]));
  }

  async getFundingRate(instrumentId: string) {
    const providerSymbol = this.providerSymbols.get(instrumentId);
    if (!providerSymbol) throw new Error(`Unsupported Bitget funding instrument: ${instrumentId}.`);
    const snapshot = await this.source(providerSymbol);
    if (snapshot.fundingRate.symbol !== providerSymbol) {
      throw new Error(`Unexpected Bitget funding symbol: ${snapshot.fundingRate.symbol}.`);
    }
    return toCanonicalBitgetFundingRate(instrumentId, snapshot.fundingRate, snapshot.fetchedAt);
  }
}

function providerNumber(value: string, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}

function providerTimestamp(value: string, field: string) {
  const parsed = providerNumber(value, field);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}

export function toCanonicalBitgetFundingRate(
  instrumentId: string,
  raw: BitgetFundingRateRecord,
  fetchedAt: number,
): CanonicalFundingRate {
  return {
    venue: "bitget",
    instrumentId,
    rate: providerNumber(raw.fundingRate, "Bitget fundingRate"),
    intervalHours: providerNumber(raw.fundingRateInterval, "Bitget fundingRateInterval"),
    nextFundingAt: providerTimestamp(raw.nextUpdate, "Bitget nextUpdate"),
    markPrice: null,
    fetchedAt,
  };
}
