import { createHash } from "node:crypto";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import type { PositionReadRequest, PositionReader } from "../cex/position/PositionReader";
import { createHedgePositionSnapshot, createPositionSnapshot } from "../cex/position/PositionSnapshot";
import type { PositionSide } from "../cex/position/PositionSide";
import type {
  BitgetAccountReadSnapshot,
  BitgetPerpetualPositionSnapshot,
} from "./BitgetAccountReadClient";

export type BitgetPositionReaderClient = Readonly<{
  readAccountSnapshot(): Promise<BitgetAccountReadSnapshot>;
  readPerpetualPosition(symbol: string, expectedSide?: "long" | "short"): Promise<BitgetPerpetualPositionSnapshot>;
}>;

export type BitgetPositionInstrumentBinding = Readonly<{
  symbol: string;
  contractSize: string;
}>;

export type BitgetPositionInstrumentResolver = Readonly<{
  resolve(instrumentId: string): Promise<BitgetPositionInstrumentBinding | null> | BitgetPositionInstrumentBinding | null;
}>;

/** Reads one one-way USDT Perp position as an exact canonical base quantity. */
export class BitgetPositionReader implements PositionReader {
  readonly venue = "bitget" as const;

  constructor(
    private readonly client: BitgetPositionReaderClient,
    private readonly instruments: BitgetPositionInstrumentResolver,
    private readonly now: () => number = Date.now,
  ) {}

  async readPosition(request: PositionReadRequest) {
    const instrument = canonicalInstrumentFromId(request.instrumentId);
    if (instrument.contractType !== "perpetual") {
      throw new Error("Bitget position reader requires a perpetual instrument.");
    }
    const binding = await this.instruments.resolve(instrument.instrumentId);
    if (!binding || binding.symbol !== `${instrument.baseAsset}${instrument.quoteAsset}`) {
      throw new Error("Bitget position instrument mapping does not match the canonical instrument.");
    }
    if (normalizeDecimal(binding.contractSize) !== "1") {
      throw new Error("Bitget position contract size is not canonical base quantity.");
    }
    const account = await this.client.readAccountSnapshot();
    const holdMode = account.holdMode?.trim().toLowerCase();
    if (holdMode !== "one_way_mode" && holdMode !== "hedge_mode") {
      throw new Error("Bitget position mode is unavailable.");
    }
    const uidHash = createHash("sha256").update(`bitget:${account.uid}`).digest("hex");
    if (request.accountId !== `bitget:${uidHash.slice(0, 16)}`) {
      throw new Error("Bitget position account identity does not match the authenticated Provider account.");
    }
    if (request.positionMode === "HEDGE") {
      if (holdMode !== "hedge_mode") throw new Error("Bitget HEDGE position mode is unavailable.");
      const [long, short] = await Promise.all([
        this.client.readPerpetualPosition(binding.symbol, "long"),
        this.client.readPerpetualPosition(binding.symbol, "short"),
      ]);
      if (long.symbol !== binding.symbol || short.symbol !== binding.symbol) throw new Error("Bitget position symbol does not match the mapped instrument.");
      return createHedgePositionSnapshot({
        venue: this.venue,
        accountId: request.accountId,
        instrumentId: instrument.instrumentId,
        longQuantity: long.side === "long" ? normalizeDecimal(long.baseQuantity) : "0",
        shortQuantity: short.side === "short" ? normalizeDecimal(short.baseQuantity) : "0",
        fetchedAt: Math.max(long.updatedAt ?? this.now(), short.updatedAt ?? this.now()),
      });
    }
    if (holdMode !== "one_way_mode") throw new Error("Bitget one-way position mode is unavailable.");
    const position = await this.client.readPerpetualPosition(binding.symbol, providerSide(request.expectedSide));
    if (position.symbol !== binding.symbol) throw new Error("Bitget position symbol does not match the mapped instrument.");
    return createPositionSnapshot({
      venue: this.venue,
      accountId: request.accountId,
      instrumentId: instrument.instrumentId,
      side: canonicalSide(position.side),
      quantity: normalizeDecimal(position.baseQuantity),
      fetchedAt: position.updatedAt ?? validNow(this.now()),
    });
  }
}

function providerSide(side: PositionSide | undefined) {
  return side === "LONG" ? "long" as const : side === "SHORT" ? "short" as const : undefined;
}

function canonicalSide(side: BitgetPerpetualPositionSnapshot["side"]): PositionSide {
  if (side === "long") return "LONG";
  if (side === "short") return "SHORT";
  if (side === "flat") return "FLAT";
  throw new Error("Bitget position side is unknown.");
}

function normalizeDecimal(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw new Error("Bitget position quantity is invalid.");
  const [integer, fraction = ""] = value.split(".");
  const normalized = fraction.replace(/0+$/u, "");
  return normalized ? `${integer}.${normalized}` : integer!;
}

function validNow(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Bitget position clock is invalid.");
  return value;
}
