import type { FundingRatePort } from "../cex/CexCapabilityPorts";
import type { CanonicalFundingRate } from "../cex/CexCanonicalModels";
import type { OkxFundingRateRecord, OkxInstrumentBinding } from "./OkxReadTypes";

type OkxFundingSource = (symbol: string) => Promise<{ fundingRate: OkxFundingRateRecord; fetchedAt: number }>;

export class OkxFundingRate implements FundingRatePort {
  readonly venue = "okx" as const;
  private readonly providerSymbols: ReadonlyMap<string, string>;

  constructor(source: OkxFundingSource, bindings: readonly OkxInstrumentBinding[]) {
    this.source = source;
    this.providerSymbols = new Map(bindings.map((binding) => [binding.instrumentId, binding.providerSymbol]));
  }

  private readonly source: OkxFundingSource;

  async getFundingRate(instrumentId: string) {
    const providerSymbol = this.providerSymbols.get(instrumentId);
    if (!providerSymbol) throw new Error(`Unsupported OKX funding instrument: ${instrumentId}.`);
    const snapshot = await this.source(providerSymbol);
    if (snapshot.fundingRate.instId !== providerSymbol) {
      throw new Error(`Unexpected OKX funding symbol: ${snapshot.fundingRate.instId}.`);
    }
    return toCanonicalOkxFundingRate(instrumentId, snapshot.fundingRate, snapshot.fetchedAt);
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

export function toCanonicalOkxFundingRate(
  instrumentId: string,
  raw: OkxFundingRateRecord,
  fetchedAt: number,
): CanonicalFundingRate {
  const fundingTime = providerTimestamp(raw.fundingTime, "OKX fundingTime");
  const nextFundingAt = providerTimestamp(raw.nextFundingTime, "OKX nextFundingTime");
  const intervalHours = (nextFundingAt - fundingTime) / 3_600_000;
  if (!Number.isInteger(intervalHours) || intervalHours <= 0) {
    throw new Error(`Invalid OKX funding interval: ${intervalHours}.`);
  }
  return {
    venue: "okx",
    instrumentId,
    rate: providerNumber(raw.fundingRate, "OKX fundingRate"),
    intervalHours,
    nextFundingAt: fundingTime,
    markPrice: null,
    fetchedAt,
  };
}
