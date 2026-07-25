import type { ArbitrageOpportunity, ArbitrageVenue } from "../arbitrageTypes";
import type { RwaVenueAccountIdentity } from "./RwaNeutralExecutionTypes";

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
  captureCredentialMutationSnapshot?(): Promise<unknown>;
  restoreCredentialMutationSnapshot?(snapshot: unknown): Promise<void>;
  supports(opportunity: ArbitrageOpportunity): boolean;
  assertRiskCapacity?(): Promise<void>;
  getConfiguredAccountId(): Promise<string | null>;
  getStatus(): Promise<RwaAutomationVenueStatus>;
  putCredentials(input: RwaVenueCredentialInput): Promise<RwaAutomationVenueStatus>;
  deleteCredentials(input?: unknown): Promise<unknown>;
  getConfig(): Promise<unknown>;
  updateConfig(input: unknown): Promise<unknown>;
  setKillSwitch(active: boolean, accountId?: string): Promise<unknown>;
  getPrivateAccount(): Promise<unknown>;
  getPnl(): Promise<unknown>;
  getAudit(): Promise<unknown>;
  preflight(opportunity: ArbitrageOpportunity, accountId: string, mode: RwaAutomationMode): Promise<{ challengeId: string; challengeToken: string; expiresAt: number; report: unknown }>;
  execute(input: unknown): Promise<unknown>;
  closeAll(input: unknown): Promise<unknown>;
};
