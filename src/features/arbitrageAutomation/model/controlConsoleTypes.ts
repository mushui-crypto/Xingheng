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
  executionReady: boolean;
  safetyEligible: boolean;
  safetyDisqualifiers: string[];
  automationEligible: boolean;
  automationDisqualifiers: string[];
};

export type AutomationPositionGroup = {
  id: string;
  reconciliationId: string | null;
  accountId: string;
  venue: AutomationVenue;
  strategyId: string;
  label: string;
  mode: AutomationPositionMode;
  status: "opening" | "hedged" | "closing" | "closed" | "attention";
  executionState: AutomationExecutionState;
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
  reconciliation: AutomationExecutionReconciliationPreview | null;
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
  accountSnapshot: AutomationPrivateAccountSnapshot | null;
};

export type AutomationInstrumentSnapshot = {
  status: string;
  bid: number;
  ask: number;
  mark: number | null;
  depthUsd: number | null;
  minOrderQty: number;
  qtyStep: number;
  minNotionalUsd: number;
  priceTick: number;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  nextFundingTime: number | null;
};

export type AutomationPrivateAccountSnapshot = {
  venue: AutomationVenue;
  accountId: string;
  fetchedAt: number;
  spotAvailableUsdt: number;
  futuresAvailableUsdt: number;
  spotXaut: number;
  perpetualXaut: number;
  openSpotOrders: number;
  openPerpetualOrders: number;
  spot: AutomationInstrumentSnapshot | null;
  perpetual: AutomationInstrumentSnapshot | null;
  spotTakerBps: number | null;
  perpetualTakerBps: number | null;
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
  venue: AutomationVenue;
};

export type AutomationVenueControl = {
  venue: AutomationVenue;
  accountId: string | null;
  globalExecutionEnabled: boolean;
  strategyEnabled: boolean;
  killSwitchActive: boolean;
  serverGlobalKillSwitchActive: boolean;
  enabled: boolean;
  parameters: AutomationParameter[];
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
    positionAuthorityIncompleteCount: number;
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
  venueControls: AutomationVenueControl[];
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
  venue: AutomationVenue;
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
  checks: Array<{
    id: string;
    passed: boolean;
    value: number | string | boolean | null;
    limit: number | string | boolean | null;
    message: string;
  }>;
  accountSnapshot: AutomationPrivateAccountSnapshot | null;
  entryBasisBps: number | null;
  fundingRate: number | null;
  estimatedNetAprPercent: number | null;
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

export type AutomationPreflightFailure = {
  kind: "preflight_rejected";
  venue: AutomationVenue;
  candidateId: string;
  accountId: string;
  mode: AutomationPreflightMode;
  checks: AutomationPreflight["checks"];
  warnings: string[];
  message: string;
  generatedAt: number | null;
};

export type AutomationPreflightResult = AutomationPreflight | AutomationShadowCheck | AutomationPreflightFailure;

export type AutomationActionReceipt = {
  ok: boolean;
  simulated: boolean;
  message: string;
  execution?: AutomationExecutionResult;
};

export type AutomationExecutionState =
  | "accepted"
  | "opening_spot"
  | "opening_perpetual"
  | "partial_closed"
  | "hedged"
  | "compensating"
  | "reconciled"
  | "closed"
  | "failed"
  | "manual_intervention"
  | "unknown";

export type AutomationResidualAssessment = {
  quantityXaut: number;
  notionalUsd: number;
  minOrderQty: number;
  minNotionalUsd: number;
  qtyStep: number;
  tradable: boolean;
  reason: "tradable" | "below_min_qty" | "below_min_notional" | "zero";
};

export type AutomationAuthoritativeLegState = {
  quantityXaut: number;
  freeQuantityXaut: number | null;
  markPrice: number | null;
  minOrderQty: number;
  minNotionalUsd: number;
  qtyStep: number;
};

export type AutomationExecutionReconciliationPreview = {
  reconciliationId: string;
  strategyId: string;
  recordedState: AutomationExecutionState;
  authoritativeState: {
    snapshotAt: number;
    status: "ok" | "stale";
    stale: boolean;
    openOrders: {
      spot: number;
      perpetual: number;
      total: number;
    };
    legs: {
      spot: AutomationAuthoritativeLegState;
      perpetual: AutomationAuthoritativeLegState;
    };
  };
  legDiffs: {
    spotQuantityXaut: number;
    perpetualQuantityXaut: number;
  };
  tradableResidual: {
    spot: AutomationResidualAssessment | null;
    perpetual: AutomationResidualAssessment | null;
  };
  dustResidual: {
    spot: AutomationResidualAssessment | null;
    perpetual: AutomationResidualAssessment | null;
  };
  recommendedAction:
    | "none"
    | "retry_close"
    | "manual_close_spot"
    | "manual_close_perpetual"
    | "manual_close_both"
    | "manual_finalize";
  canFinalize: boolean;
  blockingReasons: string[];
};

export type AutomationExecutionOrder = {
  orderId: string;
  orderLinkId: string;
  status: string;
  requestedQuantityXaut: number;
  filledQuantityXaut: number;
  averagePrice: number | null;
  feeUsd: number;
  updatedAt: number;
};

export type AutomationExecutionResult = {
  venue: AutomationVenue;
  accountId: string;
  executionId: string;
  state: AutomationExecutionState;
  message: string;
  errorCategory: string | null;
  hedgedQuantityXaut: number;
  unhedgedDurationMs: number | null;
  spotOrder: AutomationExecutionOrder | null;
  perpetualOrders: AutomationExecutionOrder[];
  compensationOrders: AutomationExecutionOrder[];
  reconciliation: AutomationExecutionReconciliationPreview | null;
  createdAt: number;
  updatedAt: number;
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
  | { type: "toggle_global_execution"; venue: AutomationVenue; enabled: boolean }
  | { type: "toggle_strategy"; venue: AutomationVenue; enabled: boolean }
  | { type: "set_kill_switch"; venue: AutomationVenue; active: boolean }
  | { type: "close_all"; venue: AutomationVenue; idempotencyKey: string };

export type AutomationConsoleClient = {
  load(signal?: AbortSignal): Promise<AutomationConsoleSnapshot>;
  requestPreflight(candidateId: string, mode: AutomationPreflightMode): Promise<AutomationPreflightResult>;
  confirmExecution(challengeId: string, stepUpToken: string): Promise<AutomationActionReceipt>;
  validateCredential(draft: CredentialDraft, stepUpToken: string): Promise<AutomationCredentialSummary>;
  deleteCredential(accountId: string, stepUpToken: string): Promise<AutomationActionReceipt>;
  validateParameters(venue: AutomationVenue, draft: ParameterDraft): Promise<AutomationActionReceipt>;
  performSafetyAction(action: SafetyAction, stepUpToken?: string): Promise<AutomationActionReceipt>;
  closePosition(positionId: string, stepUpToken: string, idempotencyKey: string): Promise<AutomationActionReceipt>;
  reconcilePosition(input: {
    venue: AutomationVenue;
    accountId: string;
    reconciliationId: string;
  }, signal?: AbortSignal): Promise<AutomationExecutionReconciliationPreview | null>;
  finalizeReconciliation(input: {
    venue: AutomationVenue;
    accountId: string;
    reconciliationId: string;
    idempotencyKey: string;
  }, stepUpToken: string): Promise<AutomationExecutionResult>;
};
