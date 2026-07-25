export const RWA_STRATEGY_ID = "bybit-xaut-spot-perp-v1" as const;
export const RWA_SPOT_SYMBOL = "XAUTUSDT" as const;
export const RWA_PERP_SYMBOL = "XAUTUSDT" as const;
export const RWA_SMOKE_QUANTITY_XAUT = 0.002;
export const RWA_SMOKE_TOTAL_BUDGET_USD = 25;
export const RWA_MAX_STRATEGY_CAPITAL_USD = 300;

export type RwaExecutionConfig = {
  globalExecutionEnabled: boolean;
  strategyEnabled: boolean;
  killSwitchActive: boolean;
  maxStrategyCapitalUsd: number;
  maxEntryBasisBps: number;
  maxCombinedSlippageBps: number;
  minNetAprPercent: number;
  minLiquidationDistancePercent: number;
  maxUnhedgedMs: number;
};

export const defaultRwaExecutionConfig: RwaExecutionConfig = {
  globalExecutionEnabled: false,
  strategyEnabled: false,
  killSwitchActive: true,
  maxStrategyCapitalUsd: RWA_MAX_STRATEGY_CAPITAL_USD,
  maxEntryBasisBps: 30,
  maxCombinedSlippageBps: 20,
  minNetAprPercent: 8,
  minLiquidationDistancePercent: 30,
  maxUnhedgedMs: 10_000,
};

export type RwaVenueCredentials = {
  apiKey: string;
  apiSecret: string;
};

export type RwaVenuePermissions = {
  read: boolean;
  spotTrade: boolean;
  contractTrade: boolean;
  withdraw: boolean;
  ipRestricted: boolean;
};

export type RwaBybitCredentials = RwaVenueCredentials;

export type RwaBybitPermissions = RwaVenuePermissions & {
  uta: boolean;
  ownerSubaccount: boolean;
};

export type RwaCredentialLifecycle =
  | "unconfigured"
  | "validating"
  | "active"
  | "invalid"
  | "expired"
  | "revoked"
  | "rotation_required";

export type RwaVenueAccountIdentity = {
  accountId: string;
  accountFingerprint: string;
  accountMode:
    | "uta"
    | "classic"
    | "single_asset_one_way"
    | "single_asset_hedge"
    | "multi_assets_one_way"
    | "multi_assets_hedge"
    | "portfolio_margin"
    | "unknown";
  ipWhitelistVerificationMode?: "provider_list_exact" | "provider_restriction_only";
};

export type RwaCredentialStatus = {
  userId: string;
  accountId: string | null;
  accountFingerprint: string | null;
  stored: boolean;
  masterKeyConfigured: boolean;
  maskedApiKey: string | null;
  connectionStatus: "not_configured" | "verified" | "invalid" | "unavailable";
  lifecycleStatus: RwaCredentialLifecycle;
  accountMode: RwaVenueAccountIdentity["accountMode"] | null;
  permissions: RwaBybitPermissions | null;
  lastVerifiedAt: number | null;
  updatedAt: number | null;
  message: string | null;
  ipWhitelistConfigured: boolean | null;
  warnings: string[];
};

export type RwaInstrumentSpec = {
  status: "Trading" | "Paused" | "Unknown";
  minOrderQty: number;
  qtyStep: number;
  minNotionalUsd: number;
  priceTick: number;
};

export type RwaProviderPreflightSnapshot<
  TPermissions extends RwaVenuePermissions = RwaBybitPermissions,
> = {
  accountId: string;
  accountFingerprint: string;
  fetchedAt: number;
  accountMode: RwaVenueAccountIdentity["accountMode"];
  permissions: TPermissions;
  availableUsdt: number;
  existingSpotQuantityXaut: number;
  existingPerpetualQuantityXaut: number;
  spot: RwaInstrumentSpec & { bid: number; ask: number };
  perpetual: RwaInstrumentSpec & {
    bid: number;
    ask: number;
    mark: number;
    fundingRate: number;
    fundingIntervalHours: number;
    liquidationDistancePercent: number | null;
  };
  fees: { spotTakerBps: number; perpetualTakerBps: number };
};

export type RwaPreflightCheck = {
  name: string;
  passed: boolean;
  value: number | string | boolean | null;
  limit: number | string | boolean | null;
  message: string;
};

export type RwaPreflightReport = {
  userId: string;
  accountId: string;
  accountFingerprint: string;
  strategyId: string;
  network: "bybit_mainnet" | "binance_mainnet";
  action: RwaAutomationMode;
  mode: RwaAutomationMode;
  opportunityId: string;
  venue: "bybit" | "binance";
  quantityXaut: number;
  totalBudgetUsd: number;
  estimatedSpotNotionalUsd: number;
  estimatedPerpetualNotionalUsd: number;
  estimatedCapitalRequiredUsd: number;
  referenceSpotAsk: number;
  referencePerpetualBid: number;
  entryBasisBps: number;
  fundingRate: number;
  estimatedNetAprPercent: number;
  checks: RwaPreflightCheck[];
  warnings: string[];
  passed: boolean;
  generatedAt: number;
  expiresAt: number;
};

export type RwaPreflightChallenge = {
  challengeId: string;
  challengeToken: string;
  expiresAt: number;
  report: RwaPreflightReport;
};

export type RwaProviderOrderRequest = {
  category: "spot" | "linear";
  symbol: typeof RWA_SPOT_SYMBOL;
  side: "Buy" | "Sell";
  quantityXaut: number;
  limitPrice: number;
  reduceOnly: boolean;
  orderLinkId: string;
};

export type RwaProviderOrder = {
  orderId: string;
  orderLinkId: string;
  status: "New" | "PartiallyFilled" | "Filled" | "Cancelled" | "Rejected" | "Unknown";
  requestedQuantityXaut: number;
  filledQuantityXaut: number;
  averagePrice: number | null;
  feeUsd: number;
  updatedAt: number;
};

export type RwaStrategyLeg = {
  kind: "spot_long" | "perpetual_short";
  quantityXaut: number;
  averageEntryPrice: number | null;
  markPrice: number | null;
  notionalUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
};

export type RwaStrategyPnlSnapshot = {
  accountId: string;
  accountFingerprint: string;
  strategyId: string;
  capturedAt: number;
  legs: { spot: RwaStrategyLeg; perpetual: RwaStrategyLeg };
  netDeltaXaut: number;
  netDeltaUsd: number;
  entryBasisBps: number | null;
  currentBasisBps: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  fundingPnlUsd: number;
  feesUsd: number;
  slippageUsd: number;
  netPnlUsd: number;
  openOrders: RwaProviderOrder[];
};

export type RwaExecutionState =
  | "accepted"
  | "opening_spot"
  | "opening_perpetual"
  | "partial_closed"
  | "hedged"
  | "compensating"
  | "reconciled"
  | "closed"
  | "failed"
  | "manual_intervention";

export type RwaResidualAssessment = {
  quantityXaut: number;
  notionalUsd: number;
  minOrderQty: number;
  minNotionalUsd: number;
  qtyStep: number;
  tradable: boolean;
  reason: "tradable" | "below_min_qty" | "below_min_notional" | "zero";
};

export type RwaAuthoritativeLegState = {
  quantityXaut: number;
  freeQuantityXaut: number | null;
  markPrice: number | null;
  minOrderQty: number;
  minNotionalUsd: number;
  qtyStep: number;
};

export type RwaExecutionReconciliationPreview = {
  reconciliationId: string;
  strategyId: string;
  recordedState: RwaExecutionState;
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
      spot: RwaAuthoritativeLegState;
      perpetual: RwaAuthoritativeLegState;
    };
  };
  legDiffs: {
    spotQuantityXaut: number;
    perpetualQuantityXaut: number;
  };
  tradableResidual: {
    spot: RwaResidualAssessment | null;
    perpetual: RwaResidualAssessment | null;
  };
  dustResidual: {
    spot: RwaResidualAssessment | null;
    perpetual: RwaResidualAssessment | null;
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

export type RwaExecutionFinalizeIdempotency = {
  scopedKey: string;
  requestFingerprint: string;
  resultState: "reconciled" | "closed";
  completedAt: number;
};

export type RwaExecutionRecord = {
  userId: string;
  accountId: string;
  executionId: string;
  idempotencyKey: string;
  challengeId: string;
  state: RwaExecutionState;
  orderLinkPrefix: string;
  spotOrder: RwaProviderOrder | null;
  perpetualOrders: RwaProviderOrder[];
  compensationOrders: RwaProviderOrder[];
  hedgedQuantityXaut: number;
  unhedgedDurationMs: number | null;
  errorCategory: string | null;
  message: string;
  reconciliation: RwaExecutionReconciliationPreview | null;
  finalizeIdempotency: RwaExecutionFinalizeIdempotency | null;
  createdAt: number;
  updatedAt: number;
};

export type RwaNeutralTradingClient<
  TPermissions extends RwaVenuePermissions = RwaVenuePermissions,
  TSnapshot extends RwaProviderPreflightSnapshot<TPermissions> = RwaProviderPreflightSnapshot<TPermissions>,
> = {
  validateAccess(): Promise<{ permissions: TPermissions } & RwaVenueAccountIdentity>;
  readPreflightSnapshot(): Promise<TSnapshot>;
  setPerpetualLeverage(leverage: 1): Promise<void>;
  placeOrder(request: RwaProviderOrderRequest): Promise<{ orderId: string; orderLinkId: string }>;
  awaitOrder(category: "spot" | "linear", orderId: string, deadlineAt: number): Promise<RwaProviderOrder>;
  cancelOrder(category: "spot" | "linear", orderId: string): Promise<void>;
  cancelStrategyOrders(orderLinkPrefix: string): Promise<void>;
  readStrategyPnl(orderLinkPrefix: string | null, since: number | null): Promise<RwaStrategyPnlSnapshot>;
};

export type RwaBybitTradingClient = RwaNeutralTradingClient<
  RwaBybitPermissions,
  RwaProviderPreflightSnapshot<RwaBybitPermissions>
>;

export type RwaBybitTradingClientFactory = (credentials: RwaBybitCredentials) => RwaBybitTradingClient;
import type { RwaAutomationMode } from "./RwaAutomationTypes";
