import {
  activeManagedQuantity,
  compareUnsignedDecimals,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import type { ArbitragePositionVerificationResult } from "../cex/arbitrage-instance/ArbitragePositionVerification";

type PositionVerifier = Pick<ArbitragePositionVerificationService, "verify">;

export type OpeningContinuationSafetyResult = Readonly<{
  firstLegId: string;
  activeAttributedExposure: string;
  status: "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN";
  reason:
    | "FIRST_LEG_REALITY_SUPPORTED"
    | "FIRST_LEG_REALITY_INSUFFICIENT"
    | "FIRST_LEG_REALITY_OPPOSITE"
    | "FIRST_LEG_REALITY_UNKNOWN";
  checkedAt: number;
}>;

/**
 * Confirms only that current Account Reality can still support the already
 * attributed first-leg exposure. It neither proves lot ownership nor computes
 * Account Delta. Spot uses total canonical base quantity, never available.
 */
export class OpeningContinuationSafetyEvaluator {
  constructor(private readonly positions: PositionVerifier) {}

  async loadFreshVerification(
    userId: string,
    instance: ArbitrageInstance,
  ): Promise<ArbitragePositionVerificationResult | null> {
    try {
      return await this.positions.verify(userId, instance.arbitrageId);
    } catch {
      return null;
    }
  }

  async evaluate(
    userId: string,
    instance: ArbitrageInstance,
    firstExecutionIntentId: string,
    verificationInput?: ArbitragePositionVerificationResult | null,
  ): Promise<OpeningContinuationSafetyResult> {
    const reference = instance.executionReferences.find((candidate) =>
      candidate.executionIntentId === firstExecutionIntentId
      && candidate.phase === "OPENING"
      && (candidate.status === "CONFIRMED"
        || (candidate.status === "FAILED"
          && compareUnsignedDecimals(candidate.confirmedQuantity, "0") > 0)));
    const firstLeg = reference === undefined
      ? undefined
      : instance.legs.find((candidate) => candidate.legId === reference.legId);
    if (!reference || !firstLeg) return unknown(reference?.legId ?? "unknown", "0", instance.updatedAt);

    const active = activeManagedQuantity(instance, firstLeg);
    if (active === "0") return unsupported(firstLeg.legId, active, "FIRST_LEG_REALITY_INSUFFICIENT", instance.updatedAt);

    const verification = verificationInput === undefined
      ? await this.loadFreshVerification(userId, instance)
      : verificationInput;
    const reality = verification?.legs.find((candidate) => candidate.legId === firstLeg.legId);
    if (!reality || reality.verificationStatus === "UNKNOWN") {
      return unknown(firstLeg.legId, active, reality?.checkedAt ?? verification?.checkedAt ?? instance.updatedAt);
    }

    if (firstLeg.instrumentId.endsWith("-SPOT")) {
      if (reality.actualQuantity === null) return unknown(firstLeg.legId, active, reality.checkedAt);
      return compareUnsignedDecimals(reality.actualQuantity, active) >= 0
        ? supported(firstLeg.legId, active, reality.checkedAt)
        : unsupported(firstLeg.legId, active, "FIRST_LEG_REALITY_INSUFFICIENT", reality.checkedAt);
    }
    if (reality.positionMode === "HEDGE") {
      const bucket = firstLeg.role === "LONG" ? reality.actualLongQuantity : reality.actualShortQuantity;
      if (bucket === null) return unknown(firstLeg.legId, active, reality.checkedAt);
      return compareUnsignedDecimals(bucket, active) >= 0
        ? supported(firstLeg.legId, active, reality.checkedAt)
        : unsupported(firstLeg.legId, active, "FIRST_LEG_REALITY_INSUFFICIENT", reality.checkedAt);
    }
    if (reality.positionMode !== "ONE_WAY" || reality.actualSignedNetQuantity === null) {
      return unknown(firstLeg.legId, active, reality.checkedAt);
    }
    const net = reality.actualSignedNetQuantity;
    if (net === "0" || (firstLeg.role === "SHORT") !== net.startsWith("-")) {
      return unsupported(firstLeg.legId, active, "FIRST_LEG_REALITY_OPPOSITE", reality.checkedAt);
    }
    const absoluteNet = net.startsWith("-") ? net.slice(1) : net;
    return compareUnsignedDecimals(absoluteNet, active) >= 0
      ? supported(firstLeg.legId, active, reality.checkedAt)
      : unsupported(firstLeg.legId, active, "FIRST_LEG_REALITY_INSUFFICIENT", reality.checkedAt);
  }
}

function supported(firstLegId: string, activeAttributedExposure: string, checkedAt: number) {
  return Object.freeze({ firstLegId, activeAttributedExposure, status: "SUPPORTED" as const,
    reason: "FIRST_LEG_REALITY_SUPPORTED" as const, checkedAt });
}

function unsupported(
  firstLegId: string,
  activeAttributedExposure: string,
  reason: "FIRST_LEG_REALITY_INSUFFICIENT" | "FIRST_LEG_REALITY_OPPOSITE",
  checkedAt: number,
) {
  return Object.freeze({ firstLegId, activeAttributedExposure, status: "UNSUPPORTED" as const, reason, checkedAt });
}

function unknown(firstLegId: string, activeAttributedExposure: string, checkedAt: number) {
  return Object.freeze({ firstLegId, activeAttributedExposure, status: "UNKNOWN" as const,
    reason: "FIRST_LEG_REALITY_UNKNOWN" as const, checkedAt });
}
