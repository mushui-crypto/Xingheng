import type { FundingRatePort } from "../cex/CexCapabilityPorts";
import type { CanonicalFundingRate } from "../cex/CexCanonicalModels";
import type { BybitFundingTicker, BybitInstrumentBinding } from "./BybitReadTypes";

type BybitFundingSource = (symbol: string) => Promise<{
  fundingRate: BybitFundingTicker;
  fetchedAt: number;
}>;

export class BybitFundingRate implements FundingRatePort {
  readonly venue = "bybit" as const;
  private readonly providerSymbols: ReadonlyMap<string, string>;

  constructor(private readonly source: BybitFundingSource, bindings: readonly BybitInstrumentBinding[]) {
    this.providerSymbols = new Map(bindings.map((binding) => [binding.instrumentId, binding.providerSymbol]));
  }

  async getFundingRate(instrumentId: string) {
    const providerSymbol = this.providerSymbols.get(instrumentId);
    if (!providerSymbol) throw new Error(`Unsupported Bybit funding instrument: ${instrumentId}.`);
    const snapshot = await this.source(providerSymbol);
    if (snapshot.fundingRate.symbol !== providerSymbol) {
      throw new Error(`Unexpected Bybit funding symbol: ${snapshot.fundingRate.symbol}.`);
    }
    return toCanonicalBybitFundingRate(instrumentId, snapshot.fundingRate, snapshot.fetchedAt);
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

export function toCanonicalBybitFundingRate(
  instrumentId: string,
  raw: BybitFundingTicker,
  fetchedAt: number,
): CanonicalFundingRate {
  return {
    venue: "bybit",
    instrumentId,
    rate: providerNumber(raw.fundingRate, "Bybit fundingRate"),
    intervalHours: providerNumber(raw.fundingIntervalHour, "Bybit fundingIntervalHour"),
    nextFundingAt: providerTimestamp(raw.nextFundingTime, "Bybit nextFundingTime"),
    markPrice: providerNumber(raw.markPrice, "Bybit markPrice"),
    fetchedAt,
  };
}
