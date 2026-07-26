import type {
  AssetAuthorizationPreviewView,
  AssetAuthorizationView,
  AssetExitPreviewView,
  AssetManagementClient,
  AssetTakeoverPreviewView,
  AssetTakeoverDiscoveryView,
  AssetTakeoverResult,
  AssetTakeoverView,
  AssetVenue,
  OpaquePreview,
  TakeoverLeveragePlanView,
  TakeoverRuntimeView,
} from "../features/arbitrageAutomation/model/assetManagementTypes";
import type { StepUpIntent } from "../features/arbitrageAutomation/model/stepUpTypes";
import { AutomationConsoleContractError } from "./arbitrageAutomationConsole";
import { HttpRequestError, requestJson } from "./httpClient";
import { createStepUpIntent } from "./stepUpSecurity";

const apiBase = "/api/arbitrage/automation";
const assetId = "xaut" as const;

export function createAssetManagementClient(): AssetManagementClient {
  return {
    async getAuthorization(venue, signal) {
      const value = await assetRequest<unknown>(path(venue, "authorization"), "XAUT 授权状态加载失败。", { signal });
      return value === null ? null : mapAuthorization(value);
    },
    async previewAuthorization(venue, signal) {
      return authorizationPreview(await assetRequest(path(venue, "authorization/preview"), "XAUT 授权预览失败。", {
        method: "POST", body: {}, signal,
      }));
    },
    async createAuthorization(venue, preview, stepUpToken) {
      return mapAuthorization(await assetRequest(path(venue, "authorization"), "XAUT 授权启用失败。", {
        method: "PUT", body: { preview, stepUpToken },
      }));
    },
    async revokeAuthorization(venue, stepUpToken) {
      await assetRequest(path(venue, "authorization"), "XAUT 授权撤销失败。", {
        method: "DELETE", body: { stepUpToken },
      });
    },
    async previewTakeover(venue, input, signal) {
      return takeoverPreview(await assetRequest(path(venue, "takeover/preview"), "XAUT 接管方案计算失败。", {
        method: "POST", body: input, signal,
      }));
    },
    async startTakeover(venue, preview, stepUpToken, idempotencyKey) {
      return mapTakeoverResult(await assetRequest(path(venue, "takeover/start"), "XAUT 接管启动失败。", {
        method: "POST", body: { preview, stepUpToken, idempotencyKey },
      }));
    },
    async getCurrentTakeover(venue, signal) {
      const value = await assetRequest<unknown>(path(venue, "takeover/current"), "当前 XAUT 接管状态加载失败。", { signal });
      return value === null ? null : mapTakeoverDiscovery(value);
    },
    async reconfirmTakeover(venue, takeoverId, preview) {
      return mapTakeoverResult(await assetRequest(path(venue, `takeover/${segment(takeoverId)}/reconfirm`), "XAUT 接管二次确认失败。", {
        method: "POST", body: { preview },
      }));
    },
    async abortTakeover(venue, takeoverId) {
      return mapTakeoverDiscovery(await assetRequest(path(venue, `takeover/${segment(takeoverId)}/abort`), "XAUT 待确认接管终止失败。", {
        method: "POST", body: {},
      }));
    },
    async getTakeoverStatus(venue, takeoverId, signal) {
      return mapTakeover(await assetRequest(path(venue, `takeover/${segment(takeoverId)}/status`), "XAUT 运行状态加载失败。", { signal }));
    },
    async previewExit(venue, takeoverId, signal) {
      return exitPreview(await assetRequest(path(venue, `takeover/${segment(takeoverId)}/exit/preview`), "XAUT 全部退出预览失败。", {
        method: "POST", body: {}, signal,
      }));
    },
    async confirmExit(venue, takeoverId, preview, idempotencyKey) {
      return mapTakeover(await assetRequest(path(venue, `takeover/${segment(takeoverId)}/exit/confirm`), "XAUT 全部退出请求失败。", {
        method: "POST", body: { preview, idempotencyKey },
      }));
    },
    async getExitStatus(venue, takeoverId, signal) {
      return mapTakeover(await assetRequest(path(venue, `takeover/${segment(takeoverId)}/exit/status`), "XAUT 退出状态加载失败。", { signal }));
    },
  };
}

export const assetManagementClient = createAssetManagementClient();

export function assetAuthorizationCreateIntent(
  venue: AssetVenue,
  preview: Readonly<Record<string, unknown>>,
): Promise<StepUpIntent> {
  return createStepUpIntent({
    operation: "asset_authorization_create",
    venue,
    resourceId: assetId,
    authorizationPreview: preview,
    requestBody: { assetId, preview },
  });
}

export function assetAuthorizationRevokeIntent(venue: AssetVenue): Promise<StepUpIntent> {
  return createStepUpIntent({
    operation: "asset_authorization_revoke",
    venue,
    resourceId: assetId,
    requestBody: { assetId },
  });
}

export function assetTakeoverStartIntent(
  venue: AssetVenue,
  preview: Readonly<Record<string, unknown>>,
): Promise<StepUpIntent> {
  return createStepUpIntent({
    operation: "asset_takeover_start",
    venue,
    resourceId: assetId,
    takeoverPreview: preview,
    requestBody: { assetId, preview },
  });
}

function path(venue: AssetVenue, suffix: string) {
  return `${apiBase}/venues/${venue}/assets/${assetId}/${suffix}`;
}

function segment(value: string) {
  if (!value || value.length > 100) throw invalidResponse("XAUT 接管标识无效。");
  return encodeURIComponent(value);
}

async function assetRequest<T>(url: string, fallback: string, options: {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const requestId = crypto.randomUUID();
  try {
    return await requestJson<T>(url, fallback, {
      clientRequestId: requestId,
      userAuthFailure: ({ status }) => status === 401 || status === 403,
      init: {
        method: options.method ?? "GET",
        signal: options.signal,
        cache: "no-store",
        headers: {
          "X-Client-Request-Id": requestId,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      },
    });
  } catch (error) {
    if (error instanceof HttpRequestError) {
      throw new AutomationConsoleContractError(
        error.status,
        safeAssetErrorMessage(error.category, error.message, fallback),
        retrySeconds(error.retryAfter),
        error.category,
        null,
        error.requestId ?? requestId,
      );
    }
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new AutomationConsoleContractError(0, "资产管理服务暂时无法连接。", null, "network_request_failed", null, requestId);
  }
}

function safeAssetErrorMessage(category: string | null, serverMessage: string, fallback: string) {
  const safeCategories = new Set([
    "asset_authorization_required", "asset_authorization_invalid", "asset_authorization_preview_invalid",
    "asset_authorization_preview_changed", "asset_takeover_invalid", "asset_takeover_preview_invalid",
    "asset_takeover_preview_changed", "asset_takeover_authorization_required", "asset_takeover_risk_rejected",
    "asset_takeover_reconfirm_required", "asset_takeover_manual_intervention", "asset_takeover_runtime_paused",
    "asset_takeover_runtime_manual_intervention", "asset_takeover_exit_preview_invalid",
    "asset_takeover_exit_incomplete", "asset_takeover_unavailable", "credential_not_configured",
    "account_mismatch", "request_digest_mismatch",
    "step_up_required", "step_up_invalid", "step_up_expired", "step_up_replayed", "step_up_scope_mismatch",
    "rate_limited", "automation_rate_limited", "service_unavailable", "invalid_request",
  ]);
  return category && safeCategories.has(category) ? serverMessage : fallback;
}

function authorizationPreview(value: unknown): OpaquePreview<AssetAuthorizationPreviewView> {
  const body = record(value);
  return {
    opaque: Object.freeze({ ...body }),
    view: {
      assetId: exactAsset(body.assetId), venue: exactVenue(body.venue), notice: text(body.notice),
      spotQuantity: number(body.spotQuantity), spotAvailableQuantity: number(body.spotAvailableQuantity),
      spotLockedQuantity: number(body.spotLockedQuantity), perpetualQuantity: number(body.perpetualQuantity),
      perpetualSide: side(body.perpetualSide), spotOrderCount: integer(body.spotOrderCount),
      perpetualOrderCount: integer(body.perpetualOrderCount),
      maxManagedSpotQuantity: number(body.maxManagedSpotQuantity),
      maxManagedPerpetualQuantity: number(body.maxManagedPerpetualQuantity),
      maxManagedNotionalUsd: number(body.maxManagedNotionalUsd), generatedAt: timestamp(body.generatedAt),
      expiresAt: timestamp(body.expiresAt),
    },
  };
}

function mapAuthorization(value: unknown): AssetAuthorizationView {
  const body = record(value);
  const revokedAt = nullableTimestamp(body.revokedAt);
  return {
    active: revokedAt === null, assetId: exactAsset(body.assetId), venue: exactVenue(body.venue),
    spotQuantity: number(body.spotQuantity), spotAvailableQuantity: number(body.spotAvailableQuantity),
    spotLockedQuantity: number(body.spotLockedQuantity), perpetualQuantity: number(body.perpetualQuantity),
    perpetualSide: side(body.perpetualSide), spotOrderCount: integer(body.spotOrderCount),
    perpetualOrderCount: integer(body.perpetualOrderCount),
    maxManagedSpotQuantity: number(body.maxManagedSpotQuantity),
    maxManagedPerpetualQuantity: number(body.maxManagedPerpetualQuantity),
    maxManagedNotionalUsd: number(body.maxManagedNotionalUsd), createdAt: timestamp(body.createdAt), revokedAt,
  };
}

function takeoverPreview(value: unknown): OpaquePreview<AssetTakeoverPreviewView> {
  const body = record(value);
  return {
    opaque: Object.freeze({ ...body }),
    view: mapTakeoverPreviewView(body),
  };
}

function mapTakeoverPreviewView(body: Record<string, unknown>): AssetTakeoverPreviewView {
  return {
    assetId: exactAsset(body.assetId), venue: exactVenue(body.venue),
    newCapitalUsd: number(body.newCapitalUsd), existingManagedCapitalUsd: number(body.existingManagedCapitalUsd),
    totalManagedCapitalUsd: number(body.totalManagedCapitalUsd), selectedLeverage: leverage(body.selectedLeverage),
    recommendedLeverage: leverage(body.recommendedLeverage), spotQuantity: number(body.spotQuantity),
    spotAvailableQuantity: number(body.spotAvailableQuantity), spotLockedQuantity: number(body.spotLockedQuantity),
    spotValueUsd: number(body.spotValueUsd), perpetualQuantity: number(body.perpetualQuantity),
    perpetualSide: side(body.perpetualSide), perpetualNotionalUsd: number(body.perpetualNotionalUsd),
    targetHedgedQuantity: number(body.targetHedgedQuantity), missingSpotQuantity: number(body.missingSpotQuantity),
    missingPerpetualQuantity: number(body.missingPerpetualQuantity), residualQuantity: number(body.residualQuantity),
    spotOrderCount: integer(body.spotOrderCount), perpetualOrderCount: integer(body.perpetualOrderCount),
    currentFundingRate: finite(body.currentFundingRate), median30dFundingRate: finite(body.median30dFundingRate),
    adverseFundingRate: finite(body.adverseFundingRate), maxSlippageBps: number(body.maxSlippageBps),
    reserveRatio: number(body.reserveRatio), leveragePlans: array(body.leveragePlans).map(mapLeveragePlan),
    generatedAt: timestamp(body.generatedAt), expiresAt: timestamp(body.expiresAt),
  };
}

function mapLeveragePlan(value: unknown): TakeoverLeveragePlanView {
  const body = record(value);
  return {
    leverage: leverage(body.leverage), feasible: boolean(body.feasible),
    estimatedLiquidationPrice: number(body.estimatedLiquidationPrice),
    liquidationDistancePercent: number(body.liquidationDistancePercent), reserveUsd: number(body.reserveUsd),
    estimatedFeesUsd: number(body.estimatedFeesUsd), estimatedSlippageUsd: number(body.estimatedSlippageUsd),
    requiredAvailableCapitalUsd: number(body.requiredAvailableCapitalUsd),
    currentFundingAprPercent: finite(body.currentFundingAprPercent),
    median30dFundingAprPercent: finite(body.median30dFundingAprPercent),
    adverseFundingAprPercent: finite(body.adverseFundingAprPercent),
    currentEstimatedAnnualFundingUsd: finite(body.currentEstimatedAnnualFundingUsd),
    median30dEstimatedAnnualFundingUsd: finite(body.median30dEstimatedAnnualFundingUsd),
    adverseEstimatedAnnualFundingUsd: finite(body.adverseEstimatedAnnualFundingUsd),
    currentReturnOnNewCapitalPercent: finite(body.currentReturnOnNewCapitalPercent),
    currentReturnOnTotalManagedPercent: finite(body.currentReturnOnTotalManagedPercent),
  };
}

function mapTakeoverResult(value: unknown): AssetTakeoverResult {
  const body = record(value);
  return {
    takeover: mapTakeover(body),
    reconfirmation: body.reconfirmationPreview === undefined
      ? null
      : takeoverPreview(body.reconfirmationPreview),
  };
}

function mapTakeover(value: unknown): AssetTakeoverView {
  const body = record(value);
  return {
    takeoverId: text(body.takeoverId), assetId: exactAsset(body.assetId), venue: exactVenue(body.venue),
    newCapitalUsd: number(body.newCapitalUsd), totalManagedCapitalUsd: number(body.totalManagedCapitalUsd),
    reservedCapitalUsd: number(body.reservedCapitalUsd), leverage: leverage(body.leverage),
    state: takeoverState(body.state), targetHedgedQuantity: number(body.targetHedgedQuantity),
    finalSpotQuantity: number(body.finalSpotQuantity), finalPerpetualQuantity: number(body.finalPerpetualQuantity),
    residualQuantity: number(body.residualQuantity), providerAcceptedOrderCount: integer(body.providerAcceptedOrderCount),
    cancelledOrderCount: integer(body.cancelledOrderCount), spotOrderCount: integer(body.spotOrderCount),
    perpetualOrderCount: integer(body.perpetualOrderCount), errorCategory: nullableText(body.errorCategory),
    message: text(body.message), createdAt: timestamp(body.createdAt), updatedAt: timestamp(body.updatedAt),
    runtime: body.runtime === null ? null : mapRuntime(body.runtime),
  };
}

function mapTakeoverDiscovery(value: unknown): AssetTakeoverDiscoveryView {
  const body = record(value);
  return {
    takeoverId: text(body.takeoverId), assetId: exactAsset(body.assetId), venue: exactVenue(body.venue),
    newCapitalUsd: number(body.newCapitalUsd), totalManagedCapitalUsd: number(body.totalManagedCapitalUsd),
    reservedCapitalUsd: number(body.reservedCapitalUsd), leverage: leverage(body.leverage),
    state: takeoverState(body.state), targetHedgedQuantity: number(body.targetHedgedQuantity),
    finalSpotQuantity: number(body.finalSpotQuantity), finalPerpetualQuantity: number(body.finalPerpetualQuantity),
    residualQuantity: number(body.residualQuantity), errorCategory: nullableText(body.errorCategory),
    message: text(body.message), createdAt: timestamp(body.createdAt), updatedAt: timestamp(body.updatedAt),
    runtime: body.runtime === null ? null : mapRuntime(body.runtime),
    requiresReconfirmation: boolean(body.requiresReconfirmation),
  };
}

function mapRuntime(value: unknown): TakeoverRuntimeView {
  const body = record(value);
  return {
    phase: runtimePhase(body.phase), reason: nullableText(body.reason), message: text(body.message),
    lastSuccessfulCheckAt: nullableTimestamp(body.lastSuccessfulCheckAt), exitStartedAt: nullableTimestamp(body.exitStartedAt),
    exitCompletedAt: nullableTimestamp(body.exitCompletedAt), residualSpotQuantity: number(body.residualSpotQuantity),
    residualPerpetualQuantity: number(body.residualPerpetualQuantity), acceptedOrderCount: integer(body.acceptedOrderCount),
    providerResultCount: integer(body.providerResultCount), cancelledOrderCount: integer(body.cancelledOrderCount),
    fundingSettlementCount: integer(body.fundingSettlementCount), lastFundingSettlementAt: nullableTimestamp(body.lastFundingSettlementAt),
    snapshot: body.authoritativeSnapshot === null ? null : mapRuntimeSnapshot(body.authoritativeSnapshot),
  };
}

function mapRuntimeSnapshot(value: unknown): NonNullable<TakeoverRuntimeView["snapshot"]> {
  const body = record(value);
  return {
    capturedAt: timestamp(body.capturedAt), spotQuantity: number(body.spotQuantity),
    spotAvailableQuantity: number(body.spotAvailableQuantity), spotLockedQuantity: number(body.spotLockedQuantity),
    spotBid: number(body.spotBid), perpetualQuantity: number(body.perpetualQuantity),
    perpetualSide: shortSide(body.perpetualSide), perpetualAsk: number(body.perpetualAsk),
    perpetualMark: number(body.perpetualMark), currentFundingRate: finite(body.currentFundingRate),
    liquidationDistancePercent: body.liquidationDistancePercent === null ? null : number(body.liquidationDistancePercent),
    reserveUsd: number(body.reserveUsd), managedCapitalUsd: number(body.managedCapitalUsd),
  };
}

function exitPreview(value: unknown): OpaquePreview<AssetExitPreviewView> {
  const body = record(value);
  if (body.normalSlippageBps !== 15) throw invalidResponse();
  return {
    opaque: Object.freeze({ ...body }),
    view: {
      takeoverId: text(body.takeoverId), venue: exactVenue(body.venue), assetId: exactAsset(body.assetId),
      spotQuantity: number(body.spotQuantity), spotAvailableQuantity: number(body.spotAvailableQuantity),
      spotLockedQuantity: number(body.spotLockedQuantity), perpetualQuantity: number(body.perpetualQuantity),
      perpetualSide: shortSide(body.perpetualSide), normalSlippageBps: 15,
      emergencySlippageBps: array(body.emergencySlippageBps).map(number),
      generatedAt: timestamp(body.generatedAt), expiresAt: timestamp(body.expiresAt),
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw invalidResponse(); return value; }
function text(value: unknown): string { if (typeof value !== "string" || !value) throw invalidResponse(); return value; }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function finite(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) throw invalidResponse(); return value; }
function number(value: unknown): number { const result = finite(value); if (result < 0) throw invalidResponse(); return result; }
function integer(value: unknown): number { const result = number(value); if (!Number.isInteger(result)) throw invalidResponse(); return result; }
function timestamp(value: unknown): number { const result = integer(value); if (result <= 0) throw invalidResponse(); return result; }
function nullableTimestamp(value: unknown): number | null { return value === null ? null : timestamp(value); }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw invalidResponse(); return value; }
function exactVenue(value: unknown): AssetVenue { if (value !== "binance" && value !== "bybit") throw invalidResponse(); return value; }
function exactAsset(value: unknown): "xaut" { if (value !== assetId) throw invalidResponse(); return value; }
function side(value: unknown): "long" | "short" | "flat" { if (value !== "long" && value !== "short" && value !== "flat") throw invalidResponse(); return value; }
function shortSide(value: unknown): "short" | "flat" { if (value !== "short" && value !== "flat") throw invalidResponse(); return value; }
function leverage(value: unknown): 1 | 2 | 3 { if (value !== 1 && value !== 2 && value !== 3) throw invalidResponse(); return value; }
function takeoverState(value: unknown): AssetTakeoverView["state"] {
  const states: AssetTakeoverView["state"][] = ["planned", "cancelling_orders", "awaiting_reconfirm", "setting_leverage", "opening_spot", "opening_perpetual", "managed", "manual_intervention", "exited", "failed"];
  if (!states.includes(value as AssetTakeoverView["state"])) throw invalidResponse();
  return value as AssetTakeoverView["state"];
}
function runtimePhase(value: unknown): TakeoverRuntimeView["phase"] {
  const phases: TakeoverRuntimeView["phase"][] = ["recovery_required", "monitoring", "paused", "reducing", "exiting", "manual_intervention", "exited"];
  if (!phases.includes(value as TakeoverRuntimeView["phase"])) throw invalidResponse();
  return value as TakeoverRuntimeView["phase"];
}
function retrySeconds(value: string | null) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : null; }
function invalidResponse(message = "资产管理服务返回了无法识别的数据。") { return new AutomationConsoleContractError(503, message, null, "invalid_response"); }
