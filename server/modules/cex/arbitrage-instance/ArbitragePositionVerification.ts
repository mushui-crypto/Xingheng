import type { ArbitrageInstanceLeg } from "./ArbitrageInstance";
import type { PositionSnapshot } from "../position/PositionSnapshot";

export type ArbitrageLegVerificationStatus = "MATCHED" | "MISMATCH" | "UNKNOWN";
export type ArbitrageLegVerificationUnknownReason =
  | "overlapping_managed_leg"
  | "credential_binding_unavailable"
  | "credential_binding_mismatch"
  | "credential_load_failed"
  | "provider_initialization_failed"
  | "provider_read_failed"
  | "account_identity_mismatch"
  | "instrument_mapping_unavailable";

export type ArbitrageLegObservedState = Readonly<{
  snapshot: PositionSnapshot;
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
