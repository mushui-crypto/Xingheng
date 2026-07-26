import type { AutomationVenue } from "./controlConsoleTypes";
import type { StepUpIntent } from "./stepUpTypes";

export type ManagedAssetId = "xaut";
export type AssetVenue = Extract<AutomationVenue, "binance" | "bybit">;
export type AssetLeverage = 1 | 2 | 3;
export type PerpetualSide = "long" | "short" | "flat";

export type OpaquePreview<TView> = {
  view: TView;
  opaque: Readonly<Record<string, unknown>>;
};

export type AssetAuthorizationView = {
  active: boolean;
  assetId: ManagedAssetId;
  venue: AssetVenue;
  spotQuantity: number;
  spotAvailableQuantity: number;
  spotLockedQuantity: number;
  perpetualQuantity: number;
  perpetualSide: PerpetualSide;
  spotOrderCount: number;
  perpetualOrderCount: number;
  maxManagedSpotQuantity: number;
  maxManagedPerpetualQuantity: number;
  maxManagedNotionalUsd: number;
  createdAt: number;
  revokedAt: number | null;
};

export type AssetAuthorizationPreviewView = Omit<
  AssetAuthorizationView,
  "active" | "createdAt" | "revokedAt"
> & {
  notice: string;
  generatedAt: number;
  expiresAt: number;
};

export type TakeoverLeveragePlanView = {
  leverage: AssetLeverage;
  feasible: boolean;
  estimatedLiquidationPrice: number;
  liquidationDistancePercent: number;
  reserveUsd: number;
  estimatedFeesUsd: number;
  estimatedSlippageUsd: number;
  requiredAvailableCapitalUsd: number;
  currentFundingAprPercent: number;
  median30dFundingAprPercent: number;
  adverseFundingAprPercent: number;
  currentEstimatedAnnualFundingUsd: number;
  median30dEstimatedAnnualFundingUsd: number;
  adverseEstimatedAnnualFundingUsd: number;
  currentReturnOnNewCapitalPercent: number;
  currentReturnOnTotalManagedPercent: number;
};

export type AssetTakeoverPreviewView = {
  assetId: ManagedAssetId;
  venue: AssetVenue;
  newCapitalUsd: number;
  existingManagedCapitalUsd: number;
  totalManagedCapitalUsd: number;
  selectedLeverage: AssetLeverage;
  recommendedLeverage: AssetLeverage;
  spotQuantity: number;
  spotAvailableQuantity: number;
  spotLockedQuantity: number;
  spotValueUsd: number;
  perpetualQuantity: number;
  perpetualSide: PerpetualSide;
  perpetualNotionalUsd: number;
  targetHedgedQuantity: number;
  missingSpotQuantity: number;
  missingPerpetualQuantity: number;
  residualQuantity: number;
  spotOrderCount: number;
  perpetualOrderCount: number;
  currentFundingRate: number;
  median30dFundingRate: number;
  adverseFundingRate: number;
  maxSlippageBps: number;
  reserveRatio: number;
  leveragePlans: TakeoverLeveragePlanView[];
  generatedAt: number;
  expiresAt: number;
};

export type TakeoverState =
  | "planned" | "cancelling_orders" | "awaiting_reconfirm" | "setting_leverage"
  | "opening_spot" | "opening_perpetual" | "managed" | "manual_intervention"
  | "exited" | "failed";

export type TakeoverRuntimePhase =
  | "recovery_required" | "monitoring" | "paused" | "reducing" | "exiting"
  | "manual_intervention" | "exited";

export type TakeoverRuntimeView = {
  phase: TakeoverRuntimePhase;
  reason: string | null;
  message: string;
  lastSuccessfulCheckAt: number | null;
  exitStartedAt: number | null;
  exitCompletedAt: number | null;
  residualSpotQuantity: number;
  residualPerpetualQuantity: number;
  acceptedOrderCount: number;
  providerResultCount: number;
  cancelledOrderCount: number;
  fundingSettlementCount: number;
  lastFundingSettlementAt: number | null;
  snapshot: null | {
    capturedAt: number;
    spotQuantity: number;
    spotAvailableQuantity: number;
    spotLockedQuantity: number;
    spotBid: number;
    perpetualQuantity: number;
    perpetualSide: "short" | "flat";
    perpetualAsk: number;
    perpetualMark: number;
    currentFundingRate: number;
    liquidationDistancePercent: number | null;
    reserveUsd: number;
    managedCapitalUsd: number;
  };
};

export type AssetTakeoverView = {
  takeoverId: string;
  assetId: ManagedAssetId;
  venue: AssetVenue;
  newCapitalUsd: number;
  totalManagedCapitalUsd: number;
  reservedCapitalUsd: number;
  leverage: AssetLeverage;
  state: TakeoverState;
  targetHedgedQuantity: number;
  finalSpotQuantity: number;
  finalPerpetualQuantity: number;
  residualQuantity: number;
  providerAcceptedOrderCount: number;
  cancelledOrderCount: number;
  spotOrderCount: number;
  perpetualOrderCount: number;
  errorCategory: string | null;
  message: string;
  createdAt: number;
  updatedAt: number;
  runtime: TakeoverRuntimeView | null;
};

export type AssetTakeoverDiscoveryView = Omit<
  AssetTakeoverView,
  "providerAcceptedOrderCount" | "cancelledOrderCount" | "spotOrderCount" | "perpetualOrderCount"
> & {
  requiresReconfirmation: boolean;
};

export type AssetTakeoverDisplayView = AssetTakeoverView | AssetTakeoverDiscoveryView;

export type AssetTakeoverResult = {
  takeover: AssetTakeoverView;
  reconfirmation: OpaquePreview<AssetTakeoverPreviewView> | null;
};

export type AssetExitPreviewView = {
  takeoverId: string;
  venue: AssetVenue;
  assetId: ManagedAssetId;
  spotQuantity: number;
  spotAvailableQuantity: number;
  spotLockedQuantity: number;
  perpetualQuantity: number;
  perpetualSide: "short" | "flat";
  normalSlippageBps: 15;
  emergencySlippageBps: readonly number[];
  generatedAt: number;
  expiresAt: number;
};

export type AssetManagementClient = {
  getAuthorization(venue: AssetVenue, signal?: AbortSignal): Promise<AssetAuthorizationView | null>;
  previewAuthorization(venue: AssetVenue, signal?: AbortSignal): Promise<OpaquePreview<AssetAuthorizationPreviewView>>;
  createAuthorization(venue: AssetVenue, preview: Readonly<Record<string, unknown>>, stepUpToken: string): Promise<AssetAuthorizationView>;
  revokeAuthorization(venue: AssetVenue, stepUpToken: string): Promise<void>;
  previewTakeover(venue: AssetVenue, input: { newCapitalUsd: number; leverage: AssetLeverage }, signal?: AbortSignal): Promise<OpaquePreview<AssetTakeoverPreviewView>>;
  startTakeover(venue: AssetVenue, preview: Readonly<Record<string, unknown>>, stepUpToken: string, idempotencyKey: string): Promise<AssetTakeoverResult>;
  getCurrentTakeover(venue: AssetVenue, signal?: AbortSignal): Promise<AssetTakeoverDiscoveryView | null>;
  reconfirmTakeover(venue: AssetVenue, takeoverId: string, preview: Readonly<Record<string, unknown>>): Promise<AssetTakeoverResult>;
  abortTakeover(venue: AssetVenue, takeoverId: string): Promise<AssetTakeoverDiscoveryView>;
  getTakeoverStatus(venue: AssetVenue, takeoverId: string, signal?: AbortSignal): Promise<AssetTakeoverView>;
  previewExit(venue: AssetVenue, takeoverId: string, signal?: AbortSignal): Promise<OpaquePreview<AssetExitPreviewView>>;
  confirmExit(venue: AssetVenue, takeoverId: string, preview: Readonly<Record<string, unknown>>, idempotencyKey: string): Promise<AssetTakeoverView>;
  getExitStatus(venue: AssetVenue, takeoverId: string, signal?: AbortSignal): Promise<AssetTakeoverView>;
};

export type RequestAssetStepUp = (
  intent: StepUpIntent,
  title: string,
  description: string,
) => Promise<string>;
