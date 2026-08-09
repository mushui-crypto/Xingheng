import type { FundingRatePort } from "../cex/CexCapabilityPorts";
import type { CanonicalFundingRate } from "../cex/CexCanonicalModels";
import type { BinanceClientAdapter, BinancePreflightSnapshot } from "./BinanceTypes";
import { BINANCE_PERPETUAL_INSTRUMENT_ID } from "./BinanceInstrumentCatalog";

type BinanceFundingRateClient = Pick<BinanceClientAdapter, "readPreflightSnapshot">;

export class BinanceFundingRate implements FundingRatePort {
  readonly venue = "binance" as const;

  constructor(private readonly client: BinanceFundingRateClient) {}

  async getFundingRate(instrumentId: string) {
    if (instrumentId !== BINANCE_PERPETUAL_INSTRUMENT_ID) {
      throw new Error(`Unsupported Binance funding instrument: ${instrumentId}.`);
    }
    return toCanonicalBinanceFundingRate(instrumentId, await this.client.readPreflightSnapshot());
  }
}

export function toCanonicalBinanceFundingRate(
  instrumentId: typeof BINANCE_PERPETUAL_INSTRUMENT_ID,
  snapshot: BinancePreflightSnapshot,
): CanonicalFundingRate {
  return {
    venue: "binance",
    instrumentId,
    rate: snapshot.perpetual.fundingRate,
    intervalHours: snapshot.perpetual.fundingIntervalHours,
    nextFundingAt: snapshot.perpetual.nextFundingTime,
    markPrice: snapshot.perpetual.mark,
    fetchedAt: snapshot.fetchedAt,
  };
}
