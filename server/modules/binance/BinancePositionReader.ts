import { canonicalInstrumentFromId } from "../cex/Instrument";
import type { PositionReadRequest, PositionReader } from "../cex/position/PositionReader";
import { createHedgePositionSnapshot, createPositionSnapshot } from "../cex/position/PositionSnapshot";
import type { PositionSide } from "../cex/position/PositionSide";
import type { BinancePerpetualPositionSnapshot } from "./BinanceTypes";

export type BinancePositionReaderClient = Readonly<{
  readPerpetualPosition(
    symbol: string,
    expectedSide?: "long" | "short",
  ): Promise<BinancePerpetualPositionSnapshot>;
}>;

export class BinancePositionReader implements PositionReader {
  readonly venue = "binance" as const;

  constructor(
    private readonly client: BinancePositionReaderClient,
    private readonly now: () => number = Date.now,
  ) {}

  async readPosition(request: PositionReadRequest) {
    const instrument = canonicalInstrumentFromId(request.instrumentId);
    if (instrument.contractType !== "perpetual") {
      throw new Error("Binance position reader requires a perpetual instrument.");
    }
    const symbol = `${instrument.baseAsset}${instrument.quoteAsset}`;
    if (request.positionMode === "HEDGE") {
      const [long, short] = await Promise.all([
        this.client.readPerpetualPosition(symbol, "long"),
        this.client.readPerpetualPosition(symbol, "short"),
      ]);
      if (long.symbol !== symbol || short.symbol !== symbol) {
        throw new Error("Binance position symbol does not match the canonical instrument.");
      }
      return createHedgePositionSnapshot({
        venue: this.venue,
        accountId: request.accountId,
        instrumentId: instrument.instrumentId,
        longQuantity: long.side === "long" ? long.baseQuantity : "0",
        shortQuantity: short.side === "short" ? short.baseQuantity : "0",
        fetchedAt: Math.max(long.updatedAt ?? this.now(), short.updatedAt ?? this.now()),
      });
    }
    const position = await this.client.readPerpetualPosition(symbol, toProviderSide(request.expectedSide));
    if (position.symbol !== symbol) throw new Error("Binance position symbol does not match the canonical instrument.");

    return createPositionSnapshot({
      venue: this.venue,
      accountId: request.accountId,
      instrumentId: instrument.instrumentId,
      side: toCanonicalSide(position.side),
      quantity: position.baseQuantity,
      fetchedAt: position.updatedAt ?? this.now(),
    });
  }
}

function toProviderSide(side: PositionSide | undefined) {
  return side === "LONG" ? "long" : side === "SHORT" ? "short" : undefined;
}

function toCanonicalSide(side: BinancePerpetualPositionSnapshot["side"]): PositionSide {
  return side === "long" ? "LONG" : side === "short" ? "SHORT" : "FLAT";
}
