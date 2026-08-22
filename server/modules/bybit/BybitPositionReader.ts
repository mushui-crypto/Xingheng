import { canonicalInstrumentFromId } from "../cex/Instrument";
import type { PositionReadRequest, PositionReader } from "../cex/position/PositionReader";
import { createHedgePositionSnapshot, createPositionSnapshot } from "../cex/position/PositionSnapshot";
import type { BybitLinearPositionFact, BybitLinearPositionModeRead } from "./BybitAccountReadClient";

export type BybitPositionReaderClient = Readonly<{
  readLinearPositionMode?(symbol: string): Promise<BybitLinearPositionModeRead>;
}>;

export class BybitPositionReader implements PositionReader {
  readonly venue = "bybit" as const;

  constructor(
    private readonly client: BybitPositionReaderClient,
    private readonly now: () => number = Date.now,
  ) {}

  async readPosition(request: PositionReadRequest) {
    const instrument = canonicalInstrumentFromId(request.instrumentId);
    if (instrument.contractType !== "perpetual") throw new Error("Bybit position reader requires a perpetual instrument.");
    const symbol = `${instrument.baseAsset}${instrument.quoteAsset}`;
    if (!this.client.readLinearPositionMode) throw new Error("Bybit position mode read is unavailable.");
    const result = await this.client.readLinearPositionMode(symbol);
    if (result.symbol !== symbol || result.positionMode === "NOT_CONFIRMED") throw new Error("Bybit position mode is unavailable.");
    if (request.positionMode === "HEDGE") {
      if (result.positionMode !== "HEDGE") throw new Error("Bybit HEDGE position mode is unavailable.");
      return createHedgePositionSnapshot({
        venue: this.venue,
        accountId: request.accountId,
        instrumentId: instrument.instrumentId,
        longQuantity: quantityFor(result.positions, 1, "long"),
        shortQuantity: quantityFor(result.positions, 2, "short"),
        fetchedAt: this.now(),
      });
    }
    if (result.positionMode !== "ONE_WAY") throw new Error("Bybit ONE_WAY position mode is unavailable.");
    const fact = result.positions.find((position) => position.positionIdx === 0);
    const side = fact?.side === "long" ? "LONG" : fact?.side === "short" ? "SHORT" : "FLAT";
    return createPositionSnapshot({
      venue: this.venue,
      accountId: request.accountId,
      instrumentId: instrument.instrumentId,
      side,
      quantity: fact?.size ?? "0",
      fetchedAt: this.now(),
    });
  }
}

function quantityFor(positions: readonly BybitLinearPositionFact[], index: 1 | 2, side: "long" | "short") {
  return positions.find((position) => position.positionIdx === index && position.side === side)?.size ?? "0";
}
