import type { ArbitrageOpportunity, ArbitrageVenue } from "../arbitrageTypes";
import type {
  RwaAccountAssetAuthorizationPreview,
  RwaPublicAccountAssetAuthorization,
} from "./RwaAccountAssetAuthorization";
import type { RwaVenueAccountIdentity } from "./RwaNeutralExecutionTypes";
import type {
  RwaAssetTakeoverLeverage,
  RwaAssetTakeoverPreview,
} from "./RwaAssetTakeover";
import type { RwaAssetTakeoverExitPreview } from "./RwaAssetTakeoverRuntime";

export type RwaAutomationVenue = Extract<ArbitrageVenue, "bybit" | "bitget" | "binance" | "okx">;
export type RwaAutomationMode = "arbitrage_entry" | "manual_entry";

export type RwaVenueCredentialInput = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
};

export type RwaAutomationVenueStatus = {
  venue: RwaAutomationVenue;
  implemented: boolean;
  enabled: boolean;
  phase?: "execution_capable" | "phase_1_read_only_shadow";
  providerWritesEnabled?: boolean;
  productAvailability?: unknown;
  config?: unknown;
  credential: {
    userId: string | null;
    stored: boolean;
    accountId: string | null;
    accountFingerprint: string | null;
    masterKeyConfigured: boolean;
    maskedApiKey: string | null;
    connectionStatus: "not_configured" | "verified" | "invalid" | "unavailable" | "not_implemented";
    lifecycleStatus: "unconfigured" | "validating" | "active" | "invalid" | "expired" | "revoked" | "rotation_required" | "not_implemented";
    accountMode: RwaVenueAccountIdentity["accountMode"] | null;
    permissions: Record<string, boolean> | null;
    lastVerifiedAt: number | null;
    updatedAt: number | null;
    message: string | null;
    ipWhitelistConfigured: boolean | null;
    warnings: string[];
  };
};

export type RwaAutomationCandidate = Pick<
  ArbitrageOpportunity,
  "id" | "longLeg" | "shortLeg" | "strategyType" | "netApr" | "persistenceRatio" | "entryBasisBps" | "automationEligible" | "automationDisqualifiers"
> & {
  venue: RwaAutomationVenue | null;
  adapterImplemented: boolean;
  safetyEligible: boolean;
  safetyDisqualifiers: string[];
};

export type RwaAutomationConnector = {
  venue: RwaAutomationVenue;
  implemented: true;
  providerWritesEnabled: boolean;
  initialize?(): Promise<void>;
  startActivityMonitoring?(): Promise<void>;
  hasActivityMonitor?(): boolean;
  dispose?(): void;
  captureCredentialMutationSnapshot?(): Promise<unknown>;
  restoreCredentialMutationSnapshot?(snapshot: unknown): Promise<void>;
  supports(opportunity: ArbitrageOpportunity): boolean;
  assertRiskCapacity?(): Promise<void>;
  getConfiguredAccountId(): Promise<string | null>;
  getStatus(): Promise<RwaAutomationVenueStatus>;
  putCredentials(input: RwaVenueCredentialInput): Promise<RwaAutomationVenueStatus>;
  deleteCredentials(input?: unknown): Promise<unknown>;
  getAccountAssetAuthorization(assetId: string): Promise<RwaPublicAccountAssetAuthorization | null>;
  previewAccountAssetAuthorization(assetId: string): Promise<RwaAccountAssetAuthorizationPreview>;
  createAccountAssetAuthorization(
    assetId: string,
    preview: RwaAccountAssetAuthorizationPreview,
  ): Promise<RwaPublicAccountAssetAuthorization>;
  revokeAccountAssetAuthorization(assetId: string): Promise<RwaPublicAccountAssetAuthorization>;
  previewAssetTakeover?(input: {
    assetId: string;
    newCapitalUsd: number;
    leverage: RwaAssetTakeoverLeverage;
  }): Promise<RwaAssetTakeoverPreview>;
  startAssetTakeover?(input: {
    assetId: string;
    preview: RwaAssetTakeoverPreview;
    idempotencyKey: string;
  }): Promise<unknown>;
  reconfirmAssetTakeover?(input: {
    takeoverId: string;
    preview: RwaAssetTakeoverPreview;
  }): Promise<unknown>;
  getCurrentAssetTakeover?(): Promise<unknown>;
  getAssetTakeoverAbortContext?(input: { takeoverId: string }): Promise<{ accountId: string }>;
  abortAssetTakeover?(input: { takeoverId: string }): Promise<unknown>;
  getAssetTakeoverStatus?(takeoverId: string): Promise<unknown>;
  previewAssetTakeoverExit?(input: {
    takeoverId: string;
  }): Promise<RwaAssetTakeoverExitPreview>;
  confirmAssetTakeoverExit?(input: {
    takeoverId: string;
    preview: RwaAssetTakeoverExitPreview;
    idempotencyKey: string;
  }): Promise<unknown>;
  getAssetTakeoverExitStatus?(takeoverId: string): Promise<unknown>;
  getConfig(): Promise<unknown>;
  updateConfig(input: unknown): Promise<unknown>;
  setKillSwitch(active: boolean, accountId?: string): Promise<unknown>;
  getPrivateAccount(): Promise<unknown>;
  getPnl(): Promise<unknown>;
  getAudit(): Promise<unknown>;
  getReconciliation(input?: unknown): Promise<unknown>;
  preflight(opportunity: ArbitrageOpportunity, accountId: string, mode: RwaAutomationMode): Promise<{ challengeId: string; challengeToken: string; expiresAt: number; report: unknown }>;
  execute(input: unknown): Promise<unknown>;
  preflightConnectivitySmoke?(accountId: string, policyAcceptance: unknown): Promise<unknown>;
  getConnectivitySmokePolicy?(accountId: string): Promise<unknown> | unknown;
  executeConnectivitySmoke?(input: unknown): Promise<unknown>;
  findConnectivitySmokeIdempotent?(input: {
    accountId: string;
    challengeId: string;
    idempotencyKey: string;
    requestDigest: string;
  }): Promise<unknown | null>;
  lookupConnectivitySmokeExecution?(input: {
    accountId: string;
    challengeId: string;
    idempotencyKey: string;
  }): Promise<unknown | null>;
  getConnectivitySmokeStatus?(smokeId?: string): Promise<unknown>;
  getConnectivitySmokeReceipt?(smokeId: string): Promise<unknown>;
  closeAll(input: unknown): Promise<unknown>;
  finalizeReconciliation(input: unknown): Promise<unknown>;
};
