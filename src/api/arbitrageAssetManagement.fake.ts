import type {
  AssetAuthorizationPreviewView,
  AssetAuthorizationView,
  AssetExitPreviewView,
  AssetManagementClient,
  AssetTakeoverPreviewView,
  AssetTakeoverView,
  AssetVenue,
  OpaquePreview,
} from "../features/arbitrageAutomation/model/assetManagementTypes";

const now = Date.UTC(2026, 6, 26, 8, 0, 0);

export function createFakeAssetManagementClient(): AssetManagementClient {
  let authorization: AssetAuthorizationView | null = null;
  let takeover: AssetTakeoverView | null = null;
  return {
    async getAuthorization() { return authorization; },
    async previewAuthorization(venue) { return authPreview(venue); },
    async createAuthorization(venue) {
      authorization = {
        ...authPreview(venue).view,
        active: true,
        createdAt: now,
        revokedAt: null,
      };
      return authorization;
    },
    async revokeAuthorization() { authorization = null; },
    async previewTakeover(venue, input) { return takeoverPreview(venue, input.newCapitalUsd, input.leverage); },
    async startTakeover(venue, preview) {
      const view = takeoverPreview(venue, Number(preview.newCapitalUsd), Number(preview.selectedLeverage) as 1 | 2 | 3).view;
      takeover = takeoverRecord(venue, view);
      return { takeover, reconfirmation: null };
    },
    async getCurrentTakeover() {
      return takeover && takeover.state !== "failed" && takeover.state !== "exited"
        ? discovery(takeover)
        : null;
    },
    async reconfirmTakeover() {
      if (!takeover) throw new Error("fixture_takeover_missing");
      return { takeover, reconfirmation: null };
    },
    async abortTakeover() {
      if (!takeover || takeover.state !== "awaiting_reconfirm") throw new Error("fixture_takeover_invalid");
      takeover = {
        ...takeover,
        state: "failed",
        reservedCapitalUsd: 0,
        message: "最新账户状态为空，本次待确认接管已安全终止。",
      };
      return discovery(takeover);
    },
    async getTakeoverStatus() {
      if (!takeover) throw new Error("fixture_takeover_missing");
      return takeover;
    },
    async previewExit(venue, takeoverId) {
      return opaque<AssetExitPreviewView>({
        takeoverId, venue, assetId: "xaut", spotQuantity: 0.03, spotAvailableQuantity: 0.03,
        spotLockedQuantity: 0, perpetualQuantity: 0.03, perpetualSide: "short",
        normalSlippageBps: 15, emergencySlippageBps: [15, 30, 50], generatedAt: now,
        expiresAt: now + 30_000,
      });
    },
    async confirmExit() {
      if (!takeover) throw new Error("fixture_takeover_missing");
      takeover = {
        ...takeover,
        state: "exited",
        runtime: takeover.runtime ? {
          ...takeover.runtime,
          phase: "exited",
          exitStartedAt: now + 1_000,
          exitCompletedAt: now + 2_000,
          residualSpotQuantity: 0.00001,
          residualPerpetualQuantity: 0,
          message: "对冲组合已退出，剩余现货为不可交易小额余额。",
        } : null,
      };
      return takeover;
    },
    async getExitStatus() {
      if (!takeover) throw new Error("fixture_takeover_missing");
      return takeover;
    },
  };
}

function authPreview(venue: AssetVenue): OpaquePreview<AssetAuthorizationPreviewView> {
  return opaque({
    assetId: "xaut", venue, notice: "仅授权管理当前账户中的 XAUT。", spotQuantity: 0.02,
    spotAvailableQuantity: 0.02, spotLockedQuantity: 0, perpetualQuantity: 0.01,
    perpetualSide: "short", spotOrderCount: 1, perpetualOrderCount: 1,
    maxManagedSpotQuantity: 0.02, maxManagedPerpetualQuantity: 0.01,
    maxManagedNotionalUsd: 100, generatedAt: now, expiresAt: now + 120_000,
  });
}

function takeoverPreview(venue: AssetVenue, newCapitalUsd: number, leverage: 1 | 2 | 3): OpaquePreview<AssetTakeoverPreviewView> {
  const plan = {
    leverage, feasible: true, estimatedLiquidationPrice: 5_000, liquidationDistancePercent: 42,
    reserveUsd: 50, estimatedFeesUsd: 0.2, estimatedSlippageUsd: 0.1,
    requiredAvailableCapitalUsd: 150, currentFundingAprPercent: 8.2,
    median30dFundingAprPercent: 7.4, adverseFundingAprPercent: -2.1,
    currentEstimatedAnnualFundingUsd: 16.4, median30dEstimatedAnnualFundingUsd: 14.8,
    adverseEstimatedAnnualFundingUsd: -4.2, currentReturnOnNewCapitalPercent: 16.4,
    currentReturnOnTotalManagedPercent: 8.2,
  };
  return opaque({
    assetId: "xaut", venue, newCapitalUsd, existingManagedCapitalUsd: 100,
    totalManagedCapitalUsd: 100 + newCapitalUsd, selectedLeverage: leverage,
    recommendedLeverage: 2, spotQuantity: 0.02, spotAvailableQuantity: 0.02,
    spotLockedQuantity: 0, spotValueUsd: 68, perpetualQuantity: 0.01,
    perpetualSide: "short", perpetualNotionalUsd: 34, targetHedgedQuantity: 0.02,
    missingSpotQuantity: 0, missingPerpetualQuantity: 0.01, residualQuantity: 0,
    spotOrderCount: 1, perpetualOrderCount: 1, currentFundingRate: 0.0001,
    median30dFundingRate: 0.00009, adverseFundingRate: -0.00002, maxSlippageBps: 15,
    reserveRatio: 0.25, leveragePlans: [
      { ...plan, leverage: 1 }, { ...plan, leverage: 2 }, { ...plan, leverage: 3 },
    ], generatedAt: now, expiresAt: now + 30_000,
  });
}

function takeoverRecord(venue: AssetVenue, preview: AssetTakeoverPreviewView): AssetTakeoverView {
  return {
    takeoverId: "fixture-takeover", assetId: "xaut", venue,
    newCapitalUsd: preview.newCapitalUsd, totalManagedCapitalUsd: preview.totalManagedCapitalUsd,
    reservedCapitalUsd: preview.totalManagedCapitalUsd, leverage: preview.selectedLeverage,
    state: "managed", targetHedgedQuantity: 0.03, finalSpotQuantity: 0.03,
    finalPerpetualQuantity: 0.03, residualQuantity: 0, providerAcceptedOrderCount: 2,
    cancelledOrderCount: 2, spotOrderCount: 1, perpetualOrderCount: 1, errorCategory: null,
    message: "XAUT 严格对冲，后台监控已就绪。", createdAt: now, updatedAt: now,
    runtime: {
      phase: "monitoring", reason: null, message: "XAUT 严格对冲，后台监控已就绪。",
      lastSuccessfulCheckAt: now, exitStartedAt: null, exitCompletedAt: null,
      residualSpotQuantity: 0, residualPerpetualQuantity: 0, acceptedOrderCount: 2,
      providerResultCount: 2, cancelledOrderCount: 2, fundingSettlementCount: 1,
      lastFundingSettlementAt: now, snapshot: {
        capturedAt: now, spotQuantity: 0.03, spotAvailableQuantity: 0.03,
        spotLockedQuantity: 0, spotBid: 3_400, perpetualQuantity: 0.03,
        perpetualSide: "short", perpetualAsk: 3_401, perpetualMark: 3_400.5,
        currentFundingRate: 0.0001, liquidationDistancePercent: 42,
        reserveUsd: 50, managedCapitalUsd: preview.totalManagedCapitalUsd,
      },
    },
  };
}

function discovery(takeover: AssetTakeoverView) {
  const {
    providerAcceptedOrderCount: _providerAcceptedOrderCount,
    cancelledOrderCount: _cancelledOrderCount,
    spotOrderCount: _spotOrderCount,
    perpetualOrderCount: _perpetualOrderCount,
    ...safe
  } = takeover;
  return {
    ...safe,
    requiresReconfirmation: takeover.state === "awaiting_reconfirm",
  };
}

function opaque<TView extends Record<string, unknown>>(view: TView): OpaquePreview<TView> {
  return { view, opaque: Object.freeze({ ...view, previewId: "fixture-preview" }) };
}
