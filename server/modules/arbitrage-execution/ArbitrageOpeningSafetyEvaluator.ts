import type {
  ArbitrageInstance,
  ArbitrageInstanceLeg,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import type {
  ArbitrageLegVerificationResult,
  ArbitragePositionVerificationResult,
} from "../cex/arbitrage-instance/ArbitragePositionVerification";

type PositionVerifier = Pick<ArbitragePositionVerificationService, "verify">;

export type ArbitrageOpeningSafetyReason =
  | "ONE_WAY_FLAT"
  | "ONE_WAY_SAME_DIRECTION"
  | "ONE_WAY_OPPOSITE_DIRECTION"
  | "HEDGE_BUCKET_ISOLATED"
  | "PROVIDER_REALITY_UNKNOWN"
  | "POSITION_MODE_UNKNOWN";

export type ArbitrageOpeningSafetyResult = Readonly<{
  legId: string;
  targetDirection: "LONG" | "SHORT";
  positionMode: "ONE_WAY" | "HEDGE" | null;
  currentSignedNetQuantity: string | null;
  openingAttributionSafe: boolean;
  reason: ArbitrageOpeningSafetyReason;
  checkedAt: number;
}>;

/**
 * Determines whether a perpetual opening fill can be attributed to a
 * separately CLOSE_ONLY-manageable leg. This is not an Account Delta check.
 */
export class ArbitrageOpeningSafetyEvaluator {
  constructor(private readonly positions: PositionVerifier) {}

  async evaluate(
    userId: string,
    instance: ArbitrageInstance,
    verificationInput?: ArbitragePositionVerificationResult | null,
  ): Promise<readonly ArbitrageOpeningSafetyResult[]> {
    const perpetualLegs = instance.legs.filter((leg) => leg.instrumentId.endsWith("-PERP"));
    if (perpetualLegs.length === 0) return Object.freeze([]);
    let verification = verificationInput;
    if (verificationInput === undefined) {
      try {
        verification = await this.positions.verify(userId, instance.arbitrageId);
      } catch {
        verification = null;
      }
    }
    return Object.freeze(perpetualLegs.map((leg) => evaluateLeg(
      leg,
      verification?.legs.find((candidate) => candidate.legId === leg.legId) ?? null,
      verification?.checkedAt ?? instance.updatedAt,
    )));
  }
}

function evaluateLeg(
  leg: ArbitrageInstanceLeg,
  reality: ArbitrageLegVerificationResult | null,
  fallbackCheckedAt: number,
): ArbitrageOpeningSafetyResult {
  const base = {
    legId: leg.legId,
    targetDirection: leg.role,
    positionMode: reality?.positionMode ?? null,
    currentSignedNetQuantity: reality?.actualSignedNetQuantity ?? null,
    checkedAt: reality?.checkedAt ?? fallbackCheckedAt,
  } as const;
  if (!reality || reality.verificationStatus === "UNKNOWN") {
    return Object.freeze({
      ...base,
      openingAttributionSafe: false,
      reason: "PROVIDER_REALITY_UNKNOWN" as const,
    });
  }
  if (reality.positionMode === "HEDGE") {
    return Object.freeze({
      ...base,
      positionMode: "HEDGE" as const,
      currentSignedNetQuantity: null,
      openingAttributionSafe: true,
      reason: "HEDGE_BUCKET_ISOLATED" as const,
    });
  }
  if (reality.positionMode !== "ONE_WAY" || reality.actualSignedNetQuantity === null) {
    return Object.freeze({
      ...base,
      openingAttributionSafe: false,
      reason: "POSITION_MODE_UNKNOWN" as const,
    });
  }
  const current = reality.actualSignedNetQuantity;
  if (current === "0") {
    return Object.freeze({
      ...base,
      positionMode: "ONE_WAY" as const,
      currentSignedNetQuantity: current,
      openingAttributionSafe: true,
      reason: "ONE_WAY_FLAT" as const,
    });
  }
  const currentIsShort = current.startsWith("-");
  const sameDirection = (leg.role === "SHORT") === currentIsShort;
  return Object.freeze({
    ...base,
    positionMode: "ONE_WAY" as const,
    currentSignedNetQuantity: current,
    openingAttributionSafe: sameDirection,
    reason: sameDirection ? "ONE_WAY_SAME_DIRECTION" as const : "ONE_WAY_OPPOSITE_DIRECTION" as const,
  });
}
