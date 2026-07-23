export type AutomationVenue = "binance" | "bybit" | "bitget" | "okx";
export type AutomationVenuePhase = "execution_capable" | "phase_1_read_only_shadow" | "unknown";
export type AutomationConsoleTab = "overview" | "candidates" | "positions" | "credentials" | "parameters" | "safety";
export type AutomationRunMode = "shadow" | "controlled_live";
export type AutomationPreflightMode = "manual_entry" | "arbitrage_entry";
export type AutomationStatus = "healthy" | "degraded" | "blocked" | "disabled";
export type AutomationPositionMode = "shadow" | "live";
export type AutomationCredentialStatus =
  | "unconfigured"
  | "validating"
  | "connected"
  | "permission_incomplete"
  | "ip_unbound"
  | "expired"
  | "revoked"
  | "rotation_required"
  | "not_implemented";

export type AutomationLeg = {
  venue: AutomationVenue;
  symbol: string;
  marketType: "spot" | "perpetual";
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  notionalUsd: number;
  unrealizedPnl: number;
  realizedPnl: number;
  fundingPnl: number;
  fees: number;
  slippage: number;
  liquidationDistancePercent: number | null;
};

export type AutomationCandidate = {
  id: string;
  asset: string;
  venue: AutomationVenue;
  longLeg: Pick<AutomationLeg, "marketType" | "side" | "symbol" | "venue">;
  shortLeg: Pick<AutomationLeg, "marketType" | "side" | "symbol" | "venue">;
  netApr: number;
  favorableDayRatio: number;
  basisBps: number | null;
  capacityUsd: number | null;
  adapterImplemented: boolean;
  canRunReadOnlyPreflight: boolean;
  canExecute: boolean;
  safetyEligible: boolean;
  safetyDisqualifiers: string[];
  automationEligible: boolean;
  automationDisqualifiers: string[];
};

export type AutomationPositionGroup = {
  id: string;
  accountId: string;
  venue: AutomationVenue;
  strategyId: string;
  label: string;
  mode: AutomationPositionMode;
  status: "opening" | "hedged" | "closing" | "closed" | "attention";
  openedAt: number;
  capitalUsedUsd: number;
  netDeltaUsd: number;
  basisBps: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  fundingPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  legs: AutomationLeg[];
  history: Array<{
    id: string;
    type: "order" | "fill" | "funding" | "close";
    venue: AutomationVenue;
    symbol: string;
    status: string;
    quantity: number | null;
    price: number | null;
    occurredAt: number;
  }>;
};

export type AutomationCredentialSummary = {
  accountId: string | null;
  venue: AutomationVenue;
  implemented: boolean;
  note: string;
  enabled: boolean;
  phase: AutomationVenuePhase;
  providerWritesEnabled: boolean;
  canAuthorize: boolean;
  canRunReadOnlyPreflight: boolean;
  canExecute: boolean;
  phaseLabel: string;
  status: AutomationCredentialStatus;
  maskedKey: string | null;
  uidFingerprint: string | null;
  permissions: {
    read: boolean;
    spotTrade: boolean;
    contractTrade: boolean;
    withdraw: boolean;
    spotAccount: boolean | null;
    futuresAccount: boolean | null;
    positionModeSupported: boolean | null;
  };
  productAvailability: AutomationProductAvailability | null;
  ipWhitelist: string[];
  ipWhitelistConfigured: boolean | null;
  warnings: string[];
  accountMode: string | null;
  lastVerifiedAt: number | null;
  defaultExecutionAccount: boolean;
  assetStatisticsEnabled: boolean;
  verificationChecks: Array<{
    id: "ip_bound" | "read" | "spot_trade" | "contract_trade" | "withdraw_disabled" | "account_mode";
    label: string;
    status: "pending" | "passed" | "warning" | "failed";
    message: string;
  }>;
  activeOrderCount: number;
  openPositionCount: number;
};

export type AutomationProductAvailability = {
  available: boolean;
  status: "available" | "spot_unavailable" | "perpetual_unavailable" | "both_unavailable" | "unknown";
  spotSymbol: string;
  perpetualSymbol: string;
  checkedAt: number | null;
  message: string | null;
};

export type AutomationParameter = {
  id: string;
  label: string;
  description: string;
  scope: "global" | "venue" | "strategy";
  scopeId: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: "USDT" | "%" | "bps" | "seconds";
};

export type AutomationAlert = {
  id: string;
  severity: "info" | "warning" | "critical";
  message: string;
  occurredAt: number;
};

export type AutomationConsoleSnapshot = {
  source: "user_api";
  contractVersion: "user-api-v1";
  generatedAt: number;
  mode: AutomationRunMode;
  status: AutomationStatus;
  globalExecutionEnabled: boolean;
  killSwitchActive: boolean;
  strategyEnabled: boolean;
  summary: {
    connectedVenueCount: number;
    totalVenueCount: number;
    eligibleCandidateCount: number;
    totalCapitalUsedUsd: number;
    netDeltaUsd: number;
    cumulativeNetPnl: number;
    todayNetPnl: number;
    fundingPnl: number;
    fees: number;
  };
  credentials: AutomationCredentialSummary[];
  candidates: AutomationCandidate[];
  positionGroups: AutomationPositionGroup[];
  pnlSeries: Array<{ timestamp: number; netPnl: number }>;
  parameters: AutomationParameter[];
  alerts: AutomationAlert[];
  productionEgressIps: string[];
};

export type AutomationPreflight = {
  challengeId: string;
  expiresAt: number;
  candidateId: string;
  accountId: string;
  challengeToken: string;
  idempotencyKey: string;
  mode: AutomationPreflightMode;
  exactLegs: Array<{
    venue: AutomationVenue;
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    referencePrice: number;
    estimatedFeeUsd: number | null;
  }>;
  estimatedCapitalRequiredUsd: number;
  totalBudgetUsd: number;
  estimatedTotalFeesUsd: number | null;
  estimatedSlippageUsd: number | null;
  maximumLossUsd: number | null;
  warnings: string[];
  confirmations: string[];
};

export type AutomationShadowCheck = {
  kind: "shadow_check";
  venue: "binance";
  candidateId: string;
  accountId: string;
  mode: AutomationPreflightMode;
  phase: "phase_1_read_only_shadow";
  providerWritesEnabled: false;
  productAvailability: AutomationProductAvailability | null;
  quantityXaut: number | null;
  totalBudgetUsd: number | null;
  estimatedCapitalRequiredUsd: number | null;
  estimatedSpotNotionalUsd: number | null;
  estimatedPerpetualNotionalUsd: number | null;
  referenceSpotAsk: number | null;
  referencePerpetualBid: number | null;
  entryBasisBps: number | null;
  fundingRate: number | null;
  estimatedNetAprPercent: number | null;
  marketChecksPassed: boolean;
  checks: Array<{
    id: string;
    passed: boolean;
    message: string;
  }>;
  warnings: string[];
  generatedAt: number | null;
  message: string;
};

export type AutomationPreflightResult = AutomationPreflight | AutomationShadowCheck;

export type AutomationActionReceipt = {
  ok: boolean;
  simulated: boolean;
  message: string;
};

export type CredentialDraft = {
  accountId: string | null;
  venue: AutomationVenue;
  note: string;
  apiKey: string;
  secret: string;
  passphrase?: string;
  ipWhitelist: string[];
  defaultExecutionAccount: boolean;
  assetStatisticsEnabled: boolean;
};

export type ParameterDraft = Record<string, number>;

export type SafetyAction =
  | { type: "toggle_global_execution"; enabled: boolean }
  | { type: "toggle_strategy"; enabled: boolean }
  | { type: "kill_switch" }
  | { type: "close_all" };

export type AutomationConsoleClient = {
  load(signal?: AbortSignal): Promise<AutomationConsoleSnapshot>;
  requestPreflight(candidateId: string, mode: AutomationPreflightMode): Promise<AutomationPreflightResult>;
  confirmExecution(challengeId: string): Promise<AutomationActionReceipt>;
  validateCredential(draft: CredentialDraft): Promise<AutomationCredentialSummary>;
  deleteCredential(accountId: string): Promise<AutomationActionReceipt>;
  validateParameters(draft: ParameterDraft): Promise<AutomationActionReceipt>;
  performSafetyAction(action: SafetyAction): Promise<AutomationActionReceipt>;
  closePosition(positionId: string): Promise<AutomationActionReceipt>;
};
