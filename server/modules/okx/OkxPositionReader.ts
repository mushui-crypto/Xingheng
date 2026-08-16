import { canonicalInstrumentFromId } from "../cex/Instrument";
import type { PositionReadRequest, PositionReader } from "../cex/position/PositionReader";
import { createPositionSnapshot } from "../cex/position/PositionSnapshot";
import type { PositionSide } from "../cex/position/PositionSide";
import type { OkxPerpetualPositionSnapshot } from "./OkxAccountReadClient";

export type OkxPositionReaderClient = Readonly<{
  readPerpetualPosition(
    instId: string,
    expectedSide?: "long" | "short",
  ): Promise<OkxPerpetualPositionSnapshot>;
}>;

export type OkxPositionInstrumentBinding = Readonly<{
  instId: string;
  contractSize: string;
}>;

export type OkxPositionInstrumentResolver = Readonly<{
  resolve(
    instrumentId: string,
  ): Promise<OkxPositionInstrumentBinding | null> | OkxPositionInstrumentBinding | null;
}>;

export class OkxPositionReader implements PositionReader {
  readonly venue = "okx" as const;

  constructor(
    private readonly client: OkxPositionReaderClient,
    private readonly instruments: OkxPositionInstrumentResolver,
    private readonly now: () => number = Date.now,
  ) {}

  async readPosition(request: PositionReadRequest) {
    const instrument = canonicalInstrumentFromId(request.instrumentId);
    if (instrument.contractType !== "perpetual") {
      throw new Error("OKX position reader requires a perpetual instrument.");
    }
    const binding = await this.instruments.resolve(instrument.instrumentId);
    if (!binding) throw new Error("OKX position instrument mapping is unavailable.");
    const expectedInstId = `${instrument.baseAsset}-${instrument.quoteAsset}-SWAP`;
    if (binding.instId !== expectedInstId) {
      throw new Error("OKX position instrument mapping does not match the canonical instrument.");
    }

    const position = await this.client.readPerpetualPosition(
      binding.instId,
      toProviderSide(request.expectedSide),
    );
    if (position.instId !== binding.instId) {
      throw new Error("OKX position instrument does not match the mapped instrument.");
    }

    return createPositionSnapshot({
      venue: this.venue,
      accountId: request.accountId,
      instrumentId: instrument.instrumentId,
      side: toCanonicalSide(position.side),
      quantity: multiplyUnsignedDecimals(position.contractQuantity, binding.contractSize),
      fetchedAt: position.updatedAt ?? this.now(),
    });
  }
}

function toProviderSide(side: PositionSide | undefined) {
  return side === "LONG" ? "long" : side === "SHORT" ? "short" : undefined;
}

function toCanonicalSide(side: OkxPerpetualPositionSnapshot["side"]): PositionSide {
  if (side === "long") return "LONG";
  if (side === "short") return "SHORT";
  if (side === "flat") return "FLAT";
  throw new Error("OKX position side is unknown.");
}

function multiplyUnsignedDecimals(left: string, right: string) {
  const lhs = unsignedDecimal(left, "OKX position quantity");
  const rhs = positiveDecimal(right, "OKX contract size");
  return formatDecimal(lhs.value * rhs.value, lhs.scale + rhs.scale);
}

function positiveDecimal(value: string, name: string) {
  const parsed = unsignedDecimal(value, name);
  if (parsed.value === 0n) throw new Error(`${name} must be greater than zero.`);
  return parsed;
}

function unsignedDecimal(value: string, name: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} must be an unsigned Decimal string.`);
  }
  const [integer, fraction = ""] = value.split(".");
  return { value: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function formatDecimal(value: bigint, scale: number) {
  if (value === 0n) return "0";
  const digits = value.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${digits.slice(0, -scale)}.${fraction}` : digits.slice(0, -scale);
}
