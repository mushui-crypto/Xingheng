import type { HyperliquidRealTradingNetwork } from "./hyperliquidConfig";

export type RealTradingAuditOutcome = "accepted" | "rejected" | "partial" | "pending_reconciliation";

/**
 * Deliberately contains no action payload, nonce, signature, private key, or mnemonic.
 * This is the complete persistence contract for real-trading exchange audit records.
 */
export type RealTradingAuditRecord = {
  requestId: string;
  userId: string;
  network: HyperliquidRealTradingNetwork;
  masterAddress: string | null;
  actionType: string;
  clientOrderIds: string[];
  outcome: RealTradingAuditOutcome;
  errorCategory: string | null;
  providerStatus: string | null;
  httpStatus: number;
  message: string | null;
  submittedAt: number;
  completedAt: number;
};

export type RealTradingIdempotencyState = "processing" | RealTradingAuditOutcome;

export type RealTradingIdempotencyReservation = {
  requestId: string;
  userId: string;
  network: HyperliquidRealTradingNetwork;
  masterAddress: string;
  clientOrderIds: string[];
  requestFingerprint: string;
  actionType: "order";
  submittedAt: number;
};

export type RealTradingIdempotencyResult =
  | { kind: "reserved" }
  | {
      kind: "existing";
      requestId: string;
      state: RealTradingIdempotencyState;
      submittedAt: number;
      receiptJson: string | null;
      requestFingerprint?: string;
    };
