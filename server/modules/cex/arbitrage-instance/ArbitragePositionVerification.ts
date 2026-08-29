import type { ArbitrageInstanceLeg } from "./ArbitrageInstance";
import type { PositionSnapshot } from "../position/PositionSnapshot";

/**
 * MATCHED means reliable Account Reality does not contradict the full managed
 * leg's direction/bucket relationship. It never means account quantity is
 * owned by, or equal to, this arbitrage instance.
 *
 * MISMATCH means Account Reality is reliable, but the full managed perpetual
 * leg is no longer present in the same direction/bucket at sufficient size.
 * UNKNOWN means Account Reality could not be established reliably.
 */
export type ArbitrageLegVerificationStatus = "MATCHED" | "MISMATCH" | "UNKNOWN";
export type ArbitrageLegVerificationUnknownReason =
  | "overlapping_managed_leg"
  | "credential_binding_unavailable"
  | "credential_binding_mismatch"
  | "credential_load_failed"
  | "provider_initialization_failed"
  | "provider_read_failed"
  | "account_identity_unavailable"
  | "position_mode_unavailable"
  | "position_reality_unavailable"
  | "account_identity_mismatch"
  | "instrument_mapping_unavailable";

export type ArbitrageLegObservedState = Readonly<{
  snapshot: PositionSnapshot;
  /** Exact Provider account binding observed by this read, when available. */
  verifiedAccountId?: string;
  /** Reliable provider-reported available balance for Spot; not used as total position identity. */
  availableQuantity?: string | null;
}>;

export type ArbitrageLegVerificationResult = Readonly<{
  arbitrageId: string;
  legId: string;
  expectedManagedQuantity: string;
  actualQuantity: string | null;
  /** Canonical signed account net quantity. This is not execution ownership. */
  actualSignedNetQuantity: string | null;
  positionMode: "ONE_WAY" | "HEDGE" | null;
  actualLongQuantity: string | null;
  actualShortQuantity: string | null;
  availableQuantity: string | null;
  verifiedAccountId?: string;
  verificationStatus: ArbitrageLegVerificationStatus;
  reason: ArbitrageLegVerificationUnknownReason | null;
  checkedAt: number;
}>;

export class ArbitrageLegReadError extends Error {
  constructor(readonly reason: ArbitrageLegVerificationUnknownReason, message: string) {
    super(message);
  }
}

export type ArbitragePositionVerificationResult = Readonly<{
  arbitrageId: string;
  checkedAt: number;
  legs: readonly [ArbitrageLegVerificationResult, ArbitrageLegVerificationResult];
}>;

export type ArbitrageLegReadProvider = Readonly<{
  venue: ArbitrageInstanceLeg["venue"];
  readLeg(leg: ArbitrageInstanceLeg): Promise<ArbitrageLegObservedState>;
  dispose(): void | Promise<void>;
}>;

export type ArbitrageLegReadProviderFactory = Readonly<{
  venue: ArbitrageInstanceLeg["venue"];
  create(secret: Readonly<{ apiKey: string; apiSecret: string; passphrase?: string }>): ArbitrageLegReadProvider;
}>;
