import type { ArbitrageInstanceLeg } from "./ArbitrageInstance";

export type ArbitrageLegVerificationStatus = "MATCHED" | "MISMATCH" | "UNKNOWN";

export type ArbitrageLegObservedState = Readonly<{
  actualQuantity: string;
  direction: "LONG" | "SHORT" | "FLAT";
  observedAt: number | null;
}>;

export type ArbitrageLegVerificationResult = Readonly<{
  arbitrageId: string;
  legId: string;
  expectedManagedQuantity: string;
  actualQuantity: string | null;
  verificationStatus: ArbitrageLegVerificationStatus;
  checkedAt: number;
}>;

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
