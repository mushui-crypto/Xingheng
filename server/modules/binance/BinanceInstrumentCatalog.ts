import type { InstrumentCatalogPort } from "../cex/CexCapabilityPorts";
import type { CanonicalInstrument } from "../cex/CexCanonicalModels";
import {
  BINANCE_PERPETUAL_SYMBOL,
  BINANCE_SPOT_SYMBOL,
  type BinanceClientAdapter,
  type BinanceInstrumentSnapshot,
  type BinancePreflightSnapshot,
} from "./BinanceTypes";

export const BINANCE_SPOT_INSTRUMENT_ID = "binance:spot:XAUT:USDT";
export const BINANCE_PERPETUAL_INSTRUMENT_ID = "binance:perpetual:linear:XAUT:USDT:USDT";

type BinanceInstrumentCatalogClient = Pick<BinanceClientAdapter, "readPreflightSnapshot">;

export class BinanceInstrumentCatalog implements InstrumentCatalogPort {
  readonly venue = "binance" as const;

  constructor(private readonly client: BinanceInstrumentCatalogClient) {}

  async getInstrument(instrumentId: string) {
    if (!isBinanceInstrumentId(instrumentId)) return null;
    const snapshot = await this.client.readPreflightSnapshot();
    return toCanonicalBinanceInstruments(snapshot)
      .find((instrument) => instrument.instrumentId === instrumentId) ?? null;
  }

  async listInstruments() {
    return toCanonicalBinanceInstruments(await this.client.readPreflightSnapshot());
  }
}

export function toCanonicalBinanceInstruments(snapshot: BinancePreflightSnapshot): CanonicalInstrument[] {
  return [
    toCanonicalInstrument(BINANCE_SPOT_INSTRUMENT_ID, "spot", snapshot.spot, snapshot.fetchedAt),
    toCanonicalInstrument(BINANCE_PERPETUAL_INSTRUMENT_ID, "linear", snapshot.perpetual, snapshot.fetchedAt),
  ];
}

function toCanonicalInstrument(
  instrumentId: string,
  category: "spot" | "linear",
  snapshot: BinanceInstrumentSnapshot,
  fetchedAt: number,
): CanonicalInstrument {
  const perpetual = category === "linear";
  return {
    instrumentId,
    venue: "binance",
    marketType: perpetual ? "perpetual" : "spot",
    contractType: perpetual ? "linear_perpetual" : "spot",
    baseAsset: "XAUT",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    providerSymbol: perpetual ? BINANCE_PERPETUAL_SYMBOL : BINANCE_SPOT_SYMBOL,
    providerLocator: { scope: perpetual ? "futures" : "spot" },
    quantityUnit: "base",
    contractSize: 1,
    priceTick: snapshot.priceTick,
    quantityStep: snapshot.qtyStep,
    minQuantity: snapshot.minOrderQty,
    minNotional: snapshot.minNotionalUsd,
    status: snapshot.status === "Trading" ? "trading" : snapshot.status === "Paused" ? "paused" : "unknown",
    fetchedAt,
  };
}

function isBinanceInstrumentId(instrumentId: string) {
  return instrumentId === BINANCE_SPOT_INSTRUMENT_ID || instrumentId === BINANCE_PERPETUAL_INSTRUMENT_ID;
}
