import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import { OkxInstrumentMappingAdapter } from "./OkxInstrumentMapping";
import type { OkxAccountIdentity, OkxPerpetualPosition } from "./OkxTypes";

export type OkxLegacyPositionReadResult = Readonly<{
  account: OkxAccountIdentity;
  positions: readonly OkxPerpetualPosition[];
  instId: string;
}>;

export type OkxLegacyPositionReader = Readonly<{
  read(request: Readonly<{ record: ExecutionRecord; instId: string }>): Promise<OkxLegacyPositionReadResult>;
}>;

export type OkxPositionVerificationStatus = "MATCHED" | "MISMATCH" | "UNKNOWN";

export type OkxPositionVerificationResult = Readonly<{
  status: OkxPositionVerificationStatus;
  reason: string;
  accountId: string;
  canonicalInstrumentId: string;
  instId: string | null;
  expectedSide: "long" | "short" | "flat";
  expectedQuantity: string;
  observedPosition: OkxPerpetualPosition | null;
  providerMutations: 0;
}>;

export class OkxPositionVerification {
  private readonly instrumentMapping: OkxInstrumentMappingAdapter;

  constructor(
    private readonly reader: OkxLegacyPositionReader,
    options: Readonly<{ instrumentMapping?: OkxInstrumentMappingAdapter }> = {},
  ) {
    this.instrumentMapping = options.instrumentMapping ?? new OkxInstrumentMappingAdapter();
  }

  async verifyOpen(
    record: ExecutionRecord,
    intent: Pick<ExecutionIntent, "intentId" | "userId" | "venue" | "accountId" | "instrumentId" | "side" | "quantity">,
  ): Promise<OkxPositionVerificationResult> {
    return this.verify(record, intent, intent.side === "buy" ? "long" : "short", intent.quantity.quantity);
  }

  async verifyClose(
    record: ExecutionRecord,
    intent: Pick<ExecutionIntent, "intentId" | "userId" | "venue" | "accountId" | "instrumentId" | "side" | "quantity">,
  ): Promise<OkxPositionVerificationResult> {
    return this.verify(record, intent, "flat", "0");
  }

  private async verify(
    record: ExecutionRecord,
    intent: Pick<ExecutionIntent, "intentId" | "userId" | "venue" | "accountId" | "instrumentId" | "side" | "quantity">,
    expectedSide: "long" | "short" | "flat",
    expectedQuantity: string,
  ): Promise<OkxPositionVerificationResult> {
    const base = {
      accountId: record.accountId,
      canonicalInstrumentId: record.instrumentId,
      instId: null,
      expectedSide,
      expectedQuantity,
      observedPosition: null,
      providerMutations: 0 as const,
    };
    if (record.status !== "CONFIRMED") {
      return result(base, "UNKNOWN", "ExecutionRecord is not CONFIRMED.");
    }
    if (
      record.venue !== "okx"
      || intent.venue !== "okx"
      || record.intentId !== intent.intentId
      || record.userId !== intent.userId
      || record.accountId !== intent.accountId
      || record.instrumentId !== intent.instrumentId
    ) {
      return result(base, "UNKNOWN", "ExecutionRecord and intent identity do not match.");
    }

    let instId: string;
    try {
      const resolved = this.instrumentMapping.resolve(record.instrumentId);
      if (resolved.canonicalInstrument.contractType !== "perpetual") {
        return result(base, "UNKNOWN", "OKX position verification supports perpetual instruments only.");
      }
      instId = resolved.venueInstrument.instId;
    } catch (error) {
      return result(base, "UNKNOWN", message(error, "OKX instrument mapping failed."), null);
    }

    let read: OkxLegacyPositionReadResult;
    try {
      read = await this.reader.read({ record, instId });
    } catch (error) {
      return result({ ...base, instId }, "UNKNOWN", message(error, "OKX provider position read failed."));
    }
    if (read.account.accountId !== record.accountId) {
      return result({ ...base, instId }, "UNKNOWN", "OKX provider account identity does not match the execution account.");
    }
    if (read.positions.some((position) => position.instId !== instId)) {
      return result({ ...base, instId }, "UNKNOWN", "OKX provider position instrument identity does not match the mapped instrument.");
    }
    const positions = read.positions.filter((position) => position.instId === instId);
    if (positions.length > 1) {
      return result({ ...base, instId }, "UNKNOWN", "OKX provider returned multiple positions for the mapped instrument.");
    }
    const observedPosition = positions[0] ?? null;
    if (expectedSide === "flat" && observedPosition === null) {
      return result({ ...base, instId }, "MATCHED", "OKX provider returned no open position.", null);
    }
    if (observedPosition === null) {
      return result({ ...base, instId }, "MISMATCH", "OKX provider returned no position for the expected open leg.");
    }
    if (
      observedPosition.instId !== instId
      || observedPosition.side !== expectedSide
      || decimalCompare(observedPosition.quantity, expectedQuantity) !== 0
    ) {
      return result({ ...base, instId, observedPosition }, "MISMATCH", "OKX provider position does not match the expected direction or quantity.");
    }
    return result({ ...base, instId, observedPosition }, "MATCHED", "OKX provider position matches the confirmed execution.");
  }
}

function result(
  base: Omit<OkxPositionVerificationResult, "status" | "reason">,
  status: OkxPositionVerificationStatus,
  reason: string,
  observedPosition: OkxPerpetualPosition | null = base.observedPosition,
): OkxPositionVerificationResult {
  return Object.freeze({ ...base, status, reason, observedPosition });
}

function decimalCompare(left: string, right: string) {
  return normalizeDecimal(left) === normalizeDecimal(right) ? 0 : 1;
}

function normalizeDecimal(value: string) {
  const [integer, fraction = ""] = value.split(".");
  const normalizedInteger = integer.replace(/^0+(?=\d)/u, "");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
