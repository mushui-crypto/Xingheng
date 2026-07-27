import type { StepUpIntent } from "./stepUpTypes";

export type ConnectivitySmokeStage =
  | "reserved"
  | "spot_opening"
  | "spot_open"
  | "futures_opening"
  | "hedged"
  | "futures_closing"
  | "spot_closing"
  | "flat"
  | "failed"
  | "manual_intervention";

export type ConnectivitySmokePolicyItem = {
  code: string;
  message: string;
};

export type ConnectivitySmokePolicy = {
  mode: "connectivity_smoke";
  venue: "binance";
  accountId: string;
  executionAuthorized: false;
  message: string;
  policy: {
    version: string;
    digest: string;
    maxPlannedCapitalUsd: number;
    dedicatedBlankSubaccount: boolean;
    singleExecution: boolean;
    immediateExit: boolean;
    challengeTtlMs: number;
    continuity: "non_atomic_incomplete";
    requiredConfirmations: string[];
    exclusiveWindowRules: ConnectivitySmokePolicyItem[];
    manualRecoveryRequirements: ConnectivitySmokePolicyItem[];
    residualRisks: ConnectivitySmokePolicyItem[];
  };
};

export type ConnectivitySmokeAcceptance = {
  exclusiveWindowConfirmed: true;
  manualRecoveryConfirmed: true;
  nonAtomicRiskAccepted: true;
};

export type ConnectivitySmokeBudget = {
  limitUsd: number;
  quantityXaut: number;
  commonQtyStep: number;
  slippageBpsPerAction: number;
  prices: {
    spotOpenLimit: number;
    futuresOpenLimit: number;
    futuresCloseLimit: number;
    spotCloseLimit: number;
  };
  spotNotionalUsd: number;
  futuresMarginUsd: number;
  spotFeesUsd: number;
  futuresFeesUsd: number;
  spotSlippageReserveUsd: number;
  futuresSlippageReserveUsd: number;
  roundingReserveUsd: number;
  totalCapitalUsd: number;
};

export type ConnectivitySmokePreflight = {
  challengeId: string;
  challengeToken: string;
  expiresAt: number;
  idempotencyKey: string;
  report: {
    purpose: "connectivity_smoke";
    mode: "connectivity_smoke";
    venue: "binance";
    network: "binance_mainnet";
    accountId: string;
    accountFingerprint: string;
    symbol: "XAUTUSDT";
    policy: {
      version: string;
      digest: string;
      accepted: true;
      continuity: "nonAtomic/incomplete";
    };
    budget: ConnectivitySmokeBudget;
    checks: Array<{ name: string; passed: boolean; message: string }>;
    passed: boolean;
    generatedAt: number;
    expiresAt: number;
  };
};

export type ConnectivitySmokeOrder = {
  orderId: string;
  orderLinkId: string;
  category: "spot" | "linear";
  side: "Buy" | "Sell";
  status: string;
  requestedQuantityXaut: number;
  filledQuantityXaut: number;
  averagePriceUsd: number | null;
  feeUsd: number | null;
  reduceOnly: boolean;
  updatedAt: number;
};

export type ConnectivitySmokeOrders = {
  spotOpen: ConnectivitySmokeOrder | null;
  futuresOpen: ConnectivitySmokeOrder | null;
  futuresClose: ConnectivitySmokeOrder | null;
  spotClose: ConnectivitySmokeOrder | null;
};

export type ConnectivitySmokeProviderState = {
  verificationStatus: "verified" | "stale" | "unavailable" | "ambiguous";
  observedAt: number | null;
  residualSpotQuantityXaut: number | null;
  residualFuturesQuantityXaut: number | null;
  activeSpotOrderCount: number | null;
  activeFuturesOrderCount: number | null;
  activeTotalOrderCount: number | null;
  providerFlatConfirmed: boolean | null;
  reason: string;
};

export type ConnectivitySmokeTimelineEvent = {
  stage: ConnectivitySmokeStage;
  at: number;
  code: string;
};

export type ConnectivitySmokeStatus = {
  smokeId: string;
  purpose: "connectivity_smoke";
  mode: "connectivity_smoke";
  venue: "binance";
  accountFingerprint: string;
  stage: ConnectivitySmokeStage;
  policyVersion: string;
  policyDigest: string;
  budget: ConnectivitySmokeBudget;
  openedSpotQuantityXaut: number;
  openedFuturesQuantityXaut: number;
  orders: ConnectivitySmokeOrders;
  providerState: ConnectivitySmokeProviderState;
  timeline: ConnectivitySmokeTimelineEvent[];
  receipt: ConnectivitySmokeReceipt | null;
  noReopen: true;
  providerMutationCount: number;
  errorCategory: string | null;
  message: string;
  createdAt: number;
  updatedAt: number;
};

export type ConnectivitySmokeMetric = {
  availability: "available" | "unavailable";
  value: number | null;
  reason: string | null;
};

export type ConnectivitySmokeReceipt = {
  receiptId: string;
  smokeId: string;
  purpose: "connectivity_smoke";
  venue: "binance";
  symbol: "XAUTUSDT";
  accountFingerprint: string;
  policyVersion: string;
  policyDigest: string;
  budget: ConnectivitySmokeBudget;
  openedSpotQuantityXaut: number;
  openedFuturesQuantityXaut: number;
  finalSpotQuantityXaut: number;
  finalFuturesQuantityXaut: number;
  providerFlatConfirmed: boolean;
  completedAt: number;
  acceptedConfirmations: ConnectivitySmokeAcceptance;
  disclosureAvailability: "available" | "unavailable_for_historical_digest";
  disclosure: {
    continuity: "non_atomic_incomplete";
    exclusiveWindowRules: ConnectivitySmokePolicyItem[];
    manualRecoveryRequirements: ConnectivitySmokePolicyItem[];
    residualRisks: ConnectivitySmokePolicyItem[];
  } | null;
  disclosureReason: string | null;
  orders: ConnectivitySmokeOrders;
  finalProviderState: ConnectivitySmokeProviderState;
  timeline: ConnectivitySmokeTimelineEvent[];
  metrics: {
    actualFeesUsd: ConnectivitySmokeMetric;
    actualSlippageUsd: ConnectivitySmokeMetric;
    actualRealizedPnlUsd: ConnectivitySmokeMetric;
  };
};

export type ConnectivitySmokeExecutionRequest = {
  accountId: string;
  challengeId: string;
  challengeToken: string;
  idempotencyKey: string;
  policyVersion: string;
  policyDigest: string;
};

export type ConnectivitySmokeClient = {
  policy(accountId: string, signal?: AbortSignal): Promise<ConnectivitySmokePolicy>;
  preflight(accountId: string, policy: ConnectivitySmokePolicy, acceptance: ConnectivitySmokeAcceptance): Promise<ConnectivitySmokePreflight>;
  execute(request: ConnectivitySmokeExecutionRequest, stepUpToken: string): Promise<ConnectivitySmokeStatus | null>;
  status(accountId: string, smokeId?: string, signal?: AbortSignal): Promise<ConnectivitySmokeStatus | null>;
  receipt(accountId: string, smokeId: string, signal?: AbortSignal): Promise<ConnectivitySmokeReceipt>;
};

export type ConnectivitySmokeStepUpRequest = {
  intent: StepUpIntent;
  request: ConnectivitySmokeExecutionRequest;
};
