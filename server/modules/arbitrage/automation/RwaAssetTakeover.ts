import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  assertRwaAutomationInstrumentRules,
  requireRwaAutomationExecutionProfile,
  rwaAutomationProfileId,
  type RwaAutomationAssetId,
  type RwaAutomationResolvedAssetProfile,
} from "./RwaAutomationAssetProfile";
import {
  validateAccountAssetAuthorization,
  type RwaAccountAssetAuthorization,
  type RwaAssetOrderReference,
} from "./RwaAccountAssetAuthorization";
import type {
  RwaProviderOrder,
  RwaProviderPreflightSnapshot,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";
import type { RwaAutomationVenue } from "./RwaAutomationTypes";

export const RWA_ASSET_TAKEOVER_PREVIEW_TTL_MS = 30_000;
export const RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS = 15 as const;
export const RWA_ASSET_TAKEOVER_RESERVE_RATIO = 0.25 as const;
export const RWA_ASSET_TAKEOVER_MIN_LIQUIDATION_DISTANCE_PERCENT = 25;
export const RWA_MAX_ASSET_TAKEOVERS_PER_STATE = 100;

export type RwaAssetTakeoverLeverage = 1 | 2 | 3;

export type RwaAssetTakeoverDepthLevel = {
  price: number;
  quantityBase: number;
};

export type RwaAssetTakeoverProviderSnapshot<
  TPermissions extends RwaVenuePermissions = RwaVenuePermissions,
> = {
  account: RwaProviderPreflightSnapshot<TPermissions>;
  orders: RwaAssetOrderReference[];
  spotAskDepth: RwaAssetTakeoverDepthLevel[];
  perpetualBidDepth: RwaAssetTakeoverDepthLevel[];
  fundingRates30d: number[];
  perpetualInitialMarginUsd: number;
  perpetualLeverage: number | null;
  spotAvailableUsdt: number;
  perpetualAvailableUsdt: number;
};

export type RwaAssetTakeoverLeveragePlan = {
  leverage: RwaAssetTakeoverLeverage;
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

export type RwaAssetTakeoverPreview = {
  previewId: string;
  venue: Extract<RwaAutomationVenue, "binance" | "bybit">;
  assetId: RwaAutomationAssetId;
  profileId: string;
  authorizationId: string;
  authorizationCreatedAt: number;
  policyVersion: string;
  policyDigest: string;
  accountFingerprint: string;
  newCapitalUsd: number;
  totalManagedCapitalUsd: number;
  existingManagedCapitalUsd: number;
  selectedLeverage: RwaAssetTakeoverLeverage;
  recommendedLeverage: RwaAssetTakeoverLeverage;
  spotQuantity: number;
  spotAvailableQuantity: number;
  spotLockedQuantity: number;
  spotValueUsd: number;
  referenceSpotAsk: number;
  perpetualQuantity: number;
  perpetualSide: "long" | "short" | "flat";
  perpetualNotionalUsd: number;
  referencePerpetualBid: number;
  perpetualInitialMarginUsd: number;
  perpetualLeverage: number | null;
  targetHedgedQuantity: number;
  missingSpotQuantity: number;
  missingPerpetualQuantity: number;
  residualQuantity: number;
  ordersDigest: string;
  spotOrderCount: number;
  perpetualOrderCount: number;
  currentFundingRate: number;
  median30dFundingRate: number;
  adverseFundingRate: number;
  maxSlippageBps: typeof RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS;
  reserveRatio: typeof RWA_ASSET_TAKEOVER_RESERVE_RATIO;
  leveragePlans: RwaAssetTakeoverLeveragePlan[];
  stateDigest: string;
  generatedAt: number;
  expiresAt: number;
  previewDigest: string;
};

export type RwaAssetTakeoverState =
  | "planned"
  | "cancelling_orders"
  | "awaiting_reconfirm"
  | "setting_leverage"
  | "opening_spot"
  | "opening_perpetual"
  | "managed"
  | "manual_intervention"
  | "failed";

export type RwaAssetTakeoverRecord = {
  takeoverId: string;
  userId: string;
  userDomain: string;
  venue: Extract<RwaAutomationVenue, "binance" | "bybit">;
  accountId: string;
  accountFingerprint: string;
  assetId: RwaAutomationAssetId;
  profileId: string;
  authorizationId: string;
  authorizationCreatedAt: number;
  policyVersion: string;
  policyDigest: string;
  idempotencyKey: string;
  previewDigest: string;
  newCapitalUsd: number;
  totalManagedCapitalUsd: number;
  reservedCapitalUsd: number;
  leverage: RwaAssetTakeoverLeverage;
  state: RwaAssetTakeoverState;
  orderLinkPrefix: string;
  plannedMutation:
    | { kind: "cancel"; category: "spot" | "linear"; orderId: string }
    | { kind: "leverage"; leverage: RwaAssetTakeoverLeverage }
    | {
      kind: "place";
      category: "spot" | "linear";
      orderLinkId: string;
      quantityBase: number;
      attempt: number;
    }
    | null;
  acceptedOrders: Array<{
    category: "spot" | "linear";
    orderId: string;
    orderLinkId: string;
  }>;
  cancelledOrders: Array<Pick<RwaAssetOrderReference, "category" | "orderId" | "symbol">>;
  spotOrders: RwaProviderOrder[];
  perpetualOrders: RwaProviderOrder[];
  targetHedgedQuantity: number;
  finalSpotQuantity: number;
  finalPerpetualQuantity: number;
  residualQuantity: number;
  errorCategory: string | null;
  message: string;
  createdAt: number;
  updatedAt: number;
};

export type RwaPublicAssetTakeoverRecord = Omit<
  RwaAssetTakeoverRecord,
  "accountId" | "userDomain" | "plannedMutation" | "acceptedOrders"
  | "cancelledOrders" | "spotOrders" | "perpetualOrders"
> & {
  providerAcceptedOrderCount: number;
  cancelledOrderCount: number;
  spotOrderCount: number;
  perpetualOrderCount: number;
};

export class RwaAssetTakeoverError extends Error {
  constructor(
    readonly statusCode: number,
    readonly category:
      | "asset_takeover_invalid"
      | "asset_takeover_preview_invalid"
      | "asset_takeover_preview_changed"
      | "asset_takeover_authorization_required"
      | "asset_takeover_risk_rejected"
      | "asset_takeover_reconfirm_required"
      | "asset_takeover_manual_intervention",
    message: string,
  ) {
    super(message);
  }
}

export function createRwaAssetTakeoverPreview<TPermissions extends RwaVenuePermissions>(input: {
  profile: RwaAutomationResolvedAssetProfile;
  authorization: RwaAccountAssetAuthorization;
  provider: RwaAssetTakeoverProviderSnapshot<TPermissions>;
  newCapitalUsd: number;
  selectedLeverage: RwaAssetTakeoverLeverage;
  now: number;
}) {
  const { profile, provider } = input;
  const authorization = validateAccountAssetAuthorization(input.authorization);
  assertTakeoverProviderSnapshot(profile, provider);
  assertTakeoverAuthorization(profile, authorization, provider.account);
  if (!positiveFinite(input.newCapitalUsd) || !isLeverage(input.selectedLeverage)) throw invalidPreview();
  if (provider.account.perpetualPositionSide === "long") {
    throw new RwaAssetTakeoverError(
      409,
      "asset_takeover_risk_rejected",
      "账户存在 XAUT 永续多头，系统不会自动反向平仓；请先人工处理。",
    );
  }
  if (
    provider.account.existingPerpetualQuantityXaut > 0
    && (
      provider.account.perpetual.liquidationDistancePercent === null
      || provider.account.perpetual.liquidationDistancePercent
        < RWA_ASSET_TAKEOVER_MIN_LIQUIDATION_DISTANCE_PERCENT
    )
  ) {
    throw new RwaAssetTakeoverError(
      409,
      "asset_takeover_risk_rejected",
      "现有 XAUT 永续仓位的强平距离不足 25%，已停止自动接管。",
    );
  }
  if (provider.account.spotLockedQuantityXaut > profile.asset.hedgeToleranceBase) {
    throw new RwaAssetTakeoverError(
      409,
      "asset_takeover_risk_rejected",
      "账户存在无法自动处理的锁定 XAUT，已停止接管。",
    );
  }
  assertOneWayMode(profile, provider.account.accountMode);

  const spotPrice = provider.account.spot.ask;
  const perpetualPrice = provider.account.perpetual.mark;
  const spotQuantity = provider.account.existingSpotQuantityXaut;
  const perpetualQuantity = provider.account.existingPerpetualQuantityXaut;
  const paired = Math.min(spotQuantity, perpetualQuantity);
  const excessSpot = Math.max(0, spotQuantity - paired);
  const excessPerpetual = Math.max(0, perpetualQuantity - paired);
  const pairedPrice = Math.max(spotPrice, perpetualPrice);
  const existingManagedCapitalUsd =
    paired * pairedPrice + excessSpot * spotPrice + excessPerpetual * perpetualPrice;
  const totalManagedCapitalUsd = existingManagedCapitalUsd + input.newCapitalUsd;
  const limits = profile.asset.currentStageRiskLimits;
  if (
    !limits
    || !nonNegativeFinite(existingManagedCapitalUsd)
    || !positiveFinite(totalManagedCapitalUsd)
    || totalManagedCapitalUsd > limits.maxAssetCapitalUsd + 1e-9
  ) {
    throw new RwaAssetTakeoverError(
      409,
      "asset_takeover_risk_rejected",
      "当前 XAUT 与本次新增资金合计超过服务端管理上限，系统不会卖出现货来迁就上限。",
    );
  }

  const missingSpotRaw = Math.max(0, perpetualQuantity - spotQuantity);
  const missingPerpetualRaw = Math.max(0, spotQuantity - perpetualQuantity);
  const missingSpotQuantity = floorStep(missingSpotRaw, provider.account.spot.qtyStep);
  const missingPerpetualQuantity = floorStep(missingPerpetualRaw, provider.account.perpetual.qtyStep);
  const residualQuantity = Math.max(
    Math.max(0, missingSpotRaw - missingSpotQuantity),
    Math.max(0, missingPerpetualRaw - missingPerpetualQuantity),
  );
  const spotTopUpNotional = missingSpotQuantity * provider.account.spot.ask;
  const perpetualTopUpNotional = missingPerpetualQuantity * provider.account.perpetual.bid;
  assertExecutableTopUp(provider, missingSpotQuantity, missingPerpetualQuantity);
  const rates = [...provider.fundingRates30d].sort((a, b) => a - b);
  const medianFundingRate = quantile(rates, 0.5);
  const adverseFundingRate = quantile(rates, 0.1);
  const plans = ([1, 2, 3] as const).map((leverage) => leveragePlan({
    leverage,
    provider,
    totalManagedCapitalUsd,
    newCapitalUsd: input.newCapitalUsd,
    targetQuantity: Math.max(spotQuantity, perpetualQuantity),
    spotTopUpNotional,
    perpetualTopUpNotional,
    medianFundingRate,
    adverseFundingRate,
  }));
  const recommendedLeverage = plans.find((plan) => plan.leverage === 2 && plan.feasible)?.leverage
    ?? plans.find((plan) => plan.feasible)?.leverage;
  const selected = plans.find((plan) => plan.leverage === input.selectedLeverage);
  if (!recommendedLeverage || !selected?.feasible) {
    throw new RwaAssetTakeoverError(
      409,
      "asset_takeover_risk_rejected",
      "当前余额、备用资金或强平距离不能满足所选方案，已停止接管。",
    );
  }
  const ordersDigest = digestOrders(provider.orders);
  const state = {
    venue: profile.venue.venue,
    assetId: profile.asset.assetId,
    profileId: rwaAutomationProfileId(profile),
    authorizationId: authorization.authorizationId,
    authorizationCreatedAt: authorization.createdAt,
    policyVersion: authorization.policyVersion,
    policyDigest: authorization.policyDigest,
    accountFingerprint: provider.account.accountFingerprint,
    newCapitalUsd: input.newCapitalUsd,
    totalManagedCapitalUsd,
    existingManagedCapitalUsd,
    selectedLeverage: input.selectedLeverage,
    recommendedLeverage,
    spotQuantity,
    spotAvailableQuantity: provider.account.spotAvailableQuantityXaut,
    spotLockedQuantity: provider.account.spotLockedQuantityXaut,
    spotValueUsd: spotQuantity * spotPrice,
    referenceSpotAsk: spotPrice,
    perpetualQuantity,
    perpetualSide: provider.account.perpetualPositionSide,
    perpetualNotionalUsd: perpetualQuantity * perpetualPrice,
    referencePerpetualBid: provider.account.perpetual.bid,
    perpetualInitialMarginUsd: provider.perpetualInitialMarginUsd,
    perpetualLeverage: provider.perpetualLeverage,
    targetHedgedQuantity: Math.max(spotQuantity, perpetualQuantity),
    missingSpotQuantity,
    missingPerpetualQuantity,
    residualQuantity,
    ordersDigest,
    spotOrderCount: provider.orders.filter((order) => order.category === "spot").length,
    perpetualOrderCount: provider.orders.filter((order) => order.category === "linear").length,
    currentFundingRate: provider.account.perpetual.fundingRate,
    median30dFundingRate: medianFundingRate,
    adverseFundingRate,
    maxSlippageBps: RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS,
    reserveRatio: RWA_ASSET_TAKEOVER_RESERVE_RATIO,
    leveragePlans: plans,
  };
  const generatedAt = input.now;
  const payload = {
    ...state,
    stateDigest: digest(state),
    generatedAt,
    expiresAt: generatedAt + RWA_ASSET_TAKEOVER_PREVIEW_TTL_MS,
  };
  const previewId = randomBytes(32).toString("hex");
  return {
    previewId,
    ...payload,
    previewDigest: digest({ previewId, ...payload }),
  } satisfies RwaAssetTakeoverPreview;
}

export function validateRwaAssetTakeoverPreview(value: unknown): RwaAssetTakeoverPreview {
  const preview = exactRecord(value, takeoverPreviewKeys);
  if (
    !hex(preview.previewId, 64)
    || !["binance", "bybit"].includes(String(preview.venue))
    || typeof preview.assetId !== "string"
    || typeof preview.profileId !== "string"
    || typeof preview.authorizationId !== "string" || !preview.authorizationId
    || !timestamp(preview.authorizationCreatedAt)
    || typeof preview.policyVersion !== "string"
    || !hex(preview.policyDigest, 64)
    || typeof preview.accountFingerprint !== "string" || !preview.accountFingerprint
    || !isLeverage(preview.selectedLeverage)
    || !isLeverage(preview.recommendedLeverage)
    || !hex(preview.ordersDigest, 64)
    || !hex(preview.stateDigest, 64)
    || !hex(preview.previewDigest, 64)
    || !Array.isArray(preview.leveragePlans)
    || preview.leveragePlans.length !== 3
    || !preview.leveragePlans.every(validLeveragePlan)
  ) throw invalidPreview();
  for (const key of takeoverPreviewNonNegativeNumberKeys) {
    if (!nonNegativeFinite(preview[key])) throw invalidPreview();
  }
  if (
    !takeoverPreviewFiniteNumberKeys.every((key) => Number.isFinite(preview[key]))
    || (preview.perpetualLeverage !== null && !positiveFinite(preview.perpetualLeverage))
    || !["long", "short", "flat"].includes(String(preview.perpetualSide))
    || !timestamp(preview.generatedAt)
    || !timestamp(preview.expiresAt)
    || preview.expiresAt !== preview.generatedAt + RWA_ASSET_TAKEOVER_PREVIEW_TTL_MS
    || preview.maxSlippageBps !== RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS
    || preview.reserveRatio !== RWA_ASSET_TAKEOVER_RESERVE_RATIO
  ) throw invalidPreview();
  const typed = preview as unknown as RwaAssetTakeoverPreview;
  const { previewDigest, previewId, generatedAt, expiresAt, stateDigest, ...state } = typed;
  if (
    stateDigest !== digest(state)
    || previewDigest !== digest({ previewId, ...state, stateDigest, generatedAt, expiresAt })
  ) throw invalidPreview();
  return typed;
}

export function assertRwaAssetTakeoverPreview(input: {
  provided: RwaAssetTakeoverPreview;
  current: RwaAssetTakeoverPreview;
  now: number;
  allowOrderChanges?: boolean;
}) {
  const provided = validateRwaAssetTakeoverPreview(input.provided);
  const current = validateRwaAssetTakeoverPreview(input.current);
  const sameState = provided.accountFingerprint === current.accountFingerprint
    && provided.authorizationId === current.authorizationId
    && provided.authorizationCreatedAt === current.authorizationCreatedAt
    && provided.assetId === current.assetId
    && provided.profileId === current.profileId
    && provided.policyVersion === current.policyVersion
    && provided.policyDigest === current.policyDigest
    && provided.newCapitalUsd === current.newCapitalUsd
    && provided.selectedLeverage === current.selectedLeverage
    && provided.spotQuantity === current.spotQuantity
    && provided.spotAvailableQuantity === current.spotAvailableQuantity
    && provided.spotLockedQuantity === current.spotLockedQuantity
    && provided.perpetualQuantity === current.perpetualQuantity
    && provided.perpetualSide === current.perpetualSide
    && provided.totalManagedCapitalUsd === current.totalManagedCapitalUsd
    && (input.allowOrderChanges || provided.ordersDigest === current.ordersDigest);
  if (provided.expiresAt <= input.now || !sameState) {
    throw new RwaAssetTakeoverError(
      409,
      "asset_takeover_preview_changed",
      "XAUT 余额、仓位、订单或风险条件已变化，请重新确认。",
    );
  }
}

export function createRwaAssetTakeoverRecord(input: {
  userId: string;
  userDomain: string;
  accountId: string;
  preview: RwaAssetTakeoverPreview;
  idempotencyKey: string;
  orderLinkPrefix: string;
  now: number;
}) {
  const preview = validateRwaAssetTakeoverPreview(input.preview);
  return {
    takeoverId: randomUUID(),
    userId: input.userId,
    userDomain: input.userDomain,
    venue: preview.venue,
    accountId: input.accountId,
    accountFingerprint: preview.accountFingerprint,
    assetId: preview.assetId,
    profileId: preview.profileId,
    authorizationId: preview.authorizationId,
    authorizationCreatedAt: preview.authorizationCreatedAt,
    policyVersion: preview.policyVersion,
    policyDigest: preview.policyDigest,
    idempotencyKey: input.idempotencyKey,
    previewDigest: preview.previewDigest,
    newCapitalUsd: preview.newCapitalUsd,
    totalManagedCapitalUsd: preview.totalManagedCapitalUsd,
    reservedCapitalUsd: preview.totalManagedCapitalUsd,
    leverage: preview.selectedLeverage,
    state: "planned",
    orderLinkPrefix: input.orderLinkPrefix,
    plannedMutation: null,
    acceptedOrders: [],
    cancelledOrders: [],
    spotOrders: [],
    perpetualOrders: [],
    targetHedgedQuantity: preview.targetHedgedQuantity,
    finalSpotQuantity: preview.spotQuantity,
    finalPerpetualQuantity: preview.perpetualQuantity,
    residualQuantity: preview.residualQuantity,
    errorCategory: null,
    message: "接管计划已保存，尚未发送交易所写请求。",
    createdAt: input.now,
    updatedAt: input.now,
  } satisfies RwaAssetTakeoverRecord;
}

export function validateRwaAssetTakeoverRecord(value: unknown): RwaAssetTakeoverRecord {
  const record = exactTakeoverRecord(value, takeoverRecordKeys);
  if (
    typeof record.takeoverId !== "string" || !record.takeoverId
    || typeof record.userId !== "string" || !record.userId
    || !hex(record.userDomain, 16)
    || !["binance", "bybit"].includes(String(record.venue))
    || typeof record.accountId !== "string" || !record.accountId
    || typeof record.accountFingerprint !== "string" || !record.accountFingerprint
    || typeof record.assetId !== "string"
    || typeof record.profileId !== "string"
    || typeof record.authorizationId !== "string" || !record.authorizationId
    || !timestamp(record.authorizationCreatedAt)
    || typeof record.policyVersion !== "string"
    || !hex(record.policyDigest, 64)
    || typeof record.idempotencyKey !== "string" || !record.idempotencyKey
    || !hex(record.previewDigest, 64)
    || !isLeverage(record.leverage)
    || !takeoverStates.includes(record.state as RwaAssetTakeoverState)
    || typeof record.orderLinkPrefix !== "string" || !record.orderLinkPrefix
    || !(record.plannedMutation === null || typeof record.plannedMutation === "object")
    || !Array.isArray(record.acceptedOrders)
    || !Array.isArray(record.cancelledOrders)
    || !Array.isArray(record.spotOrders)
    || !Array.isArray(record.perpetualOrders)
    || !(record.errorCategory === null || typeof record.errorCategory === "string")
    || typeof record.message !== "string"
    || !timestamp(record.createdAt)
    || !timestamp(record.updatedAt)
  ) throw invalidRecord();
  for (const key of takeoverRecordNumberKeys) {
    if (!nonNegativeFinite(record[key])) throw invalidRecord();
  }
  if (
    !positiveFinite(record.newCapitalUsd)
    || !positiveFinite(record.totalManagedCapitalUsd)
    || (
      record.state === "failed"
        ? record.reservedCapitalUsd !== 0
        : record.reservedCapitalUsd !== record.totalManagedCapitalUsd
          || !positiveFinite(record.reservedCapitalUsd)
    )
  ) throw invalidRecord();
  const profile = requireRwaAutomationExecutionProfile(String(record.assetId), String(record.venue));
  if (
    record.profileId !== rwaAutomationProfileId(profile)
    || record.policyVersion !== profile.asset.authorizationPolicy.version
    || record.policyDigest !== profile.asset.authorizationPolicy.digest
  ) throw invalidRecord();
  record.cancelledOrders.forEach((item) => {
    const order = exactTakeoverRecord(item, ["category", "orderId", "symbol"]);
    if (!["spot", "linear"].includes(String(order.category))
      || typeof order.orderId !== "string" || !order.orderId
      || order.symbol !== (
        order.category === "spot"
          ? profile.venue.spotSymbol
          : profile.venue.perpetualSymbol
      )) {
      throw invalidRecord();
    }
  });
  if (record.plannedMutation !== null) {
    const mutation = record.plannedMutation as Record<string, unknown>;
    if (mutation.kind === "cancel") {
      exactTakeoverRecord(mutation, ["category", "kind", "orderId"]);
      if (!["spot", "linear"].includes(String(mutation.category))
        || typeof mutation.orderId !== "string" || !mutation.orderId) throw invalidRecord();
    } else if (mutation.kind === "leverage") {
      exactTakeoverRecord(mutation, ["kind", "leverage"]);
      if (!isLeverage(mutation.leverage)) throw invalidRecord();
    } else if (mutation.kind === "place") {
      exactTakeoverRecord(mutation, ["attempt", "category", "kind", "orderLinkId", "quantityBase"]);
      const attempt = mutation.attempt;
      if (!["spot", "linear"].includes(String(mutation.category))
        || typeof mutation.orderLinkId !== "string" || !mutation.orderLinkId
        || !positiveFinite(mutation.quantityBase)
        || typeof attempt !== "number"
        || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 3) {
        throw invalidRecord();
      }
    } else throw invalidRecord();
  }
  record.acceptedOrders.forEach((item) => {
    const accepted = exactTakeoverRecord(item, ["category", "orderId", "orderLinkId"]);
    if (!["spot", "linear"].includes(String(accepted.category))
      || typeof accepted.orderId !== "string" || !accepted.orderId
      || typeof accepted.orderLinkId !== "string" || !accepted.orderLinkId) throw invalidRecord();
  });
  record.spotOrders.forEach(validateTakeoverProviderOrder);
  record.perpetualOrders.forEach(validateTakeoverProviderOrder);
  return record as unknown as RwaAssetTakeoverRecord;
}

export function publicRwaAssetTakeoverRecord(value: RwaAssetTakeoverRecord): RwaPublicAssetTakeoverRecord {
  const record = validateRwaAssetTakeoverRecord(value);
  const {
    accountId: _accountId,
    userDomain: _userDomain,
    plannedMutation: _plannedMutation,
    acceptedOrders,
    cancelledOrders,
    spotOrders,
    perpetualOrders,
    ...safe
  } = record;
  return {
    ...safe,
    providerAcceptedOrderCount: acceptedOrders.length,
    cancelledOrderCount: cancelledOrders.length,
    spotOrderCount: spotOrders.length,
    perpetualOrderCount: perpetualOrders.length,
  };
}

export function requireActiveTakeoverAuthorization(input: {
  authorizations: readonly RwaAccountAssetAuthorization[];
  profile: RwaAutomationResolvedAssetProfile;
  accountId: string;
  accountFingerprint: string;
  authorizationId?: string;
}) {
  const matches = input.authorizations.filter((item) =>
    item.revokedAt === null
    && item.accountId === input.accountId
    && item.accountFingerprint === input.accountFingerprint
    && item.assetId === input.profile.asset.assetId
    && item.profileId === rwaAutomationProfileId(input.profile)
    && item.policyVersion === input.profile.asset.authorizationPolicy.version
    && item.policyDigest === input.profile.asset.authorizationPolicy.digest
    && (input.authorizationId === undefined || item.authorizationId === input.authorizationId));
  if (matches.length !== 1) {
    throw new RwaAssetTakeoverError(
      409,
      "asset_takeover_authorization_required",
      "当前账户的 XAUT 管理授权缺失、已撤销或已失效，请重新完成授权。",
    );
  }
  return validateAccountAssetAuthorization(matches[0]);
}

export function takeoverStateChanged(previous: RwaAssetTakeoverPreview, current: RwaAssetTakeoverPreview) {
  return previous.spotQuantity !== current.spotQuantity
    || previous.spotAvailableQuantity !== current.spotAvailableQuantity
    || previous.spotLockedQuantity !== current.spotLockedQuantity
    || previous.perpetualQuantity !== current.perpetualQuantity
    || previous.perpetualSide !== current.perpetualSide;
}

export function validateRwaTakeoverFundingWindow<T>(
  items: readonly T[],
  startTime: number,
  endTime: number,
  intervalMs: number,
  timestampOf: (item: T) => number,
  rateOf: (item: T) => number,
) {
  if (
    !timestamp(startTime)
    || !timestamp(endTime)
    || !positiveFinite(intervalMs)
    || endTime - startTime !== 30 * 24 * 60 * 60_000
  ) throw invalidPreview();
  const points = items.map((item) => ({
    timestamp: timestampOf(item),
    rate: rateOf(item),
  })).sort((left, right) => left.timestamp - right.timestamp);
  if (
    points.length === 0
    || points.some((point) =>
      !timestamp(point.timestamp)
      || point.timestamp < startTime
      || point.timestamp > endTime
      || !Number.isFinite(point.rate))
    || new Set(points.map((point) => point.timestamp)).size !== points.length
    || points[0]!.timestamp > startTime + intervalMs
    || points.at(-1)!.timestamp < endTime - intervalMs
    || points.some((point, index) =>
      index > 0 && point.timestamp - points[index - 1]!.timestamp > intervalMs * 1.5)
  ) throw invalidPreview();
  return points.map((point) => point.rate);
}

function leveragePlan(input: {
  leverage: RwaAssetTakeoverLeverage;
  provider: RwaAssetTakeoverProviderSnapshot;
  totalManagedCapitalUsd: number;
  newCapitalUsd: number;
  targetQuantity: number;
  spotTopUpNotional: number;
  perpetualTopUpNotional: number;
  medianFundingRate: number;
  adverseFundingRate: number;
}): RwaAssetTakeoverLeveragePlan {
  const fees = (
    input.spotTopUpNotional * input.provider.account.fees.spotTakerBps
    + input.perpetualTopUpNotional * input.provider.account.fees.perpetualTakerBps
  ) / 10_000;
  const slippage = (input.spotTopUpNotional + input.perpetualTopUpNotional)
    * RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS / 10_000;
  const reserve = input.totalManagedCapitalUsd * RWA_ASSET_TAKEOVER_RESERVE_RATIO;
  const perpetualMargin = input.perpetualTopUpNotional / input.leverage;
  const required = input.spotTopUpNotional + perpetualMargin + fees + slippage + reserve;
  const distance = 100 / input.leverage;
  const liquidationPrice = input.provider.account.perpetual.bid * (1 + 1 / input.leverage);
  const spotRequired = input.spotTopUpNotional
    + input.spotTopUpNotional * input.provider.account.fees.spotTakerBps / 10_000
    + input.spotTopUpNotional * RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS / 10_000;
  const perpetualRequired = perpetualMargin
    + input.perpetualTopUpNotional * input.provider.account.fees.perpetualTakerBps / 10_000
    + input.perpetualTopUpNotional * RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS / 10_000;
  const currentAnnual = annualFunding(
    input.provider.account.perpetual.fundingRate,
    input.provider.account.perpetual.fundingIntervalHours,
    input.targetQuantity * input.provider.account.perpetual.mark,
  );
  const medianAnnual = annualFunding(
    input.medianFundingRate,
    input.provider.account.perpetual.fundingIntervalHours,
    input.targetQuantity * input.provider.account.perpetual.mark,
  );
  const adverseAnnual = annualFunding(
    input.adverseFundingRate,
    input.provider.account.perpetual.fundingIntervalHours,
    input.targetQuantity * input.provider.account.perpetual.mark,
  );
  return {
    leverage: input.leverage,
    feasible: distance >= RWA_ASSET_TAKEOVER_MIN_LIQUIDATION_DISTANCE_PERCENT
      && input.newCapitalUsd + 1e-9 >= required
      && input.provider.account.availableUsdt + 1e-9 >= required
      && input.provider.spotAvailableUsdt + 1e-9 >= spotRequired
      && input.provider.perpetualAvailableUsdt + 1e-9 >= perpetualRequired,
    estimatedLiquidationPrice: liquidationPrice,
    liquidationDistancePercent: distance,
    reserveUsd: reserve,
    estimatedFeesUsd: fees,
    estimatedSlippageUsd: slippage,
    requiredAvailableCapitalUsd: required,
    currentFundingAprPercent: annualRatePercent(
      input.provider.account.perpetual.fundingRate,
      input.provider.account.perpetual.fundingIntervalHours,
    ),
    median30dFundingAprPercent: annualRatePercent(
      input.medianFundingRate,
      input.provider.account.perpetual.fundingIntervalHours,
    ),
    adverseFundingAprPercent: annualRatePercent(
      input.adverseFundingRate,
      input.provider.account.perpetual.fundingIntervalHours,
    ),
    currentEstimatedAnnualFundingUsd: currentAnnual,
    median30dEstimatedAnnualFundingUsd: medianAnnual,
    adverseEstimatedAnnualFundingUsd: adverseAnnual,
    currentReturnOnNewCapitalPercent: input.newCapitalUsd > 0 ? currentAnnual / input.newCapitalUsd * 100 : 0,
    currentReturnOnTotalManagedPercent: currentAnnual / input.totalManagedCapitalUsd * 100,
  };
}

function assertTakeoverProviderSnapshot(
  profile: RwaAutomationResolvedAssetProfile,
  provider: RwaAssetTakeoverProviderSnapshot,
) {
  const snapshot = provider.account;
  assertRwaAutomationInstrumentRules(profile, "spot", snapshot.spot);
  assertRwaAutomationInstrumentRules(profile, "perpetual", snapshot.perpetual);
  const quantities = [
    snapshot.availableUsdt,
    snapshot.existingSpotQuantityXaut,
    snapshot.spotAvailableQuantityXaut,
    snapshot.spotLockedQuantityXaut,
    snapshot.existingPerpetualQuantityXaut,
    provider.perpetualInitialMarginUsd,
    provider.spotAvailableUsdt,
    provider.perpetualAvailableUsdt,
  ];
  if (
    !snapshot.accountId || !snapshot.accountFingerprint
    || !timestamp(snapshot.fetchedAt)
    || !snapshot.permissions.read || !snapshot.permissions.spotTrade || !snapshot.permissions.contractTrade
    || snapshot.permissions.withdraw
    || quantities.some((value) => !nonNegativeFinite(value))
    || !positiveFinite(snapshot.spot.bid) || !positiveFinite(snapshot.spot.ask)
    || !positiveFinite(snapshot.perpetual.bid) || !positiveFinite(snapshot.perpetual.ask)
    || !positiveFinite(snapshot.perpetual.mark)
    || !Number.isFinite(snapshot.perpetual.fundingRate)
    || !positiveFinite(snapshot.perpetual.fundingIntervalHours)
    || snapshot.fees.spotTakerBps < 0 || snapshot.fees.perpetualTakerBps < 0
    || snapshot.fees.spotTakerBps > profile.venue.spotRules.maxTakerFeeBps
    || snapshot.fees.perpetualTakerBps > profile.venue.perpetualRules.maxTakerFeeBps
    || provider.fundingRates30d.length === 0
    || provider.fundingRates30d.length > 1_000
    || provider.fundingRates30d.some((rate) => !Number.isFinite(rate))
    || !validDepth(provider.spotAskDepth, "ask")
    || !validDepth(provider.perpetualBidDepth, "bid")
    || provider.orders.some((order) =>
      !["spot", "linear"].includes(order.category)
      || !order.orderId || !order.clientOrderId
      || order.symbol !== (
        order.category === "spot"
          ? profile.venue.spotSymbol
          : profile.venue.perpetualSymbol
      ))
  ) throw invalidPreview();
}

function assertTakeoverAuthorization(
  profile: RwaAutomationResolvedAssetProfile,
  authorization: RwaAccountAssetAuthorization,
  snapshot: RwaProviderPreflightSnapshot<RwaVenuePermissions>,
) {
  if (
    authorization.revokedAt !== null
    || authorization.venue !== profile.venue.venue
    || authorization.accountId !== snapshot.accountId
    || authorization.accountFingerprint !== snapshot.accountFingerprint
    || authorization.assetId !== profile.asset.assetId
    || authorization.profileId !== rwaAutomationProfileId(profile)
    || authorization.policyVersion !== profile.asset.authorizationPolicy.version
    || authorization.policyDigest !== profile.asset.authorizationPolicy.digest
  ) {
    throw new RwaAssetTakeoverError(
      409,
      "asset_takeover_authorization_required",
      "当前账户的 XAUT 管理授权与实时账户不匹配，请重新授权。",
    );
  }
}

function assertOneWayMode(profile: RwaAutomationResolvedAssetProfile, mode: string) {
  const allowed = profile.venue.venue === "bybit"
    ? ["uta"]
    : ["single_asset_one_way", "multi_assets_one_way"];
  if (!allowed.includes(mode)) {
    throw new RwaAssetTakeoverError(
      409,
      "asset_takeover_risk_rejected",
      "当前账户不是服务端允许的 one-way 模式，已停止接管。",
    );
  }
}

function assertExecutableTopUp(
  provider: RwaAssetTakeoverProviderSnapshot,
  missingSpot: number,
  missingPerpetual: number,
) {
  if (missingSpot > 0) {
    const notional = missingSpot * provider.account.spot.ask;
    if (missingSpot < provider.account.spot.minOrderQty || notional < provider.account.spot.minNotionalUsd) return;
    const available = executableDepthQuantity(
      provider.spotAskDepth,
      provider.account.spot.ask * (1 + RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS / 10_000),
      "ask",
    );
    if (available + 1e-9 < missingSpot) throw depthRejected();
  }
  if (missingPerpetual > 0) {
    const notional = missingPerpetual * provider.account.perpetual.bid;
    if (missingPerpetual < provider.account.perpetual.minOrderQty
      || notional < provider.account.perpetual.minNotionalUsd) return;
    const available = executableDepthQuantity(
      provider.perpetualBidDepth,
      provider.account.perpetual.bid * (1 - RWA_ASSET_TAKEOVER_MAX_SLIPPAGE_BPS / 10_000),
      "bid",
    );
    if (available + 1e-9 < missingPerpetual) throw depthRejected();
  }
}

function digestOrders(orders: readonly RwaAssetOrderReference[]) {
  return digest([...orders]
    .map((order) => ({
      category: order.category,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
    }))
    .sort((a, b) => `${a.category}:${a.orderId}`.localeCompare(`${b.category}:${b.orderId}`)));
}

function validDepth(levels: RwaAssetTakeoverDepthLevel[], side: "ask" | "bid") {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > 500) return false;
  let previous = side === "ask" ? 0 : Number.POSITIVE_INFINITY;
  for (const level of levels) {
    if (!positiveFinite(level.price) || !positiveFinite(level.quantityBase)) return false;
    if (side === "ask" ? level.price < previous : level.price > previous) return false;
    previous = level.price;
  }
  return true;
}

function executableDepthQuantity(
  levels: readonly RwaAssetTakeoverDepthLevel[],
  limitPrice: number,
  side: "ask" | "bid",
) {
  return levels.reduce((sum, level) => {
    const executable = side === "ask" ? level.price <= limitPrice : level.price >= limitPrice;
    return sum + (executable ? level.quantityBase : 0);
  }, 0);
}

function quantile(sorted: readonly number[], q: number) {
  if (!sorted.length) throw invalidPreview();
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function annualRatePercent(rate: number, intervalHours: number) {
  return rate * (24 / intervalHours) * 365 * 100;
}

function annualFunding(rate: number, intervalHours: number, notionalUsd: number) {
  return rate * (24 / intervalHours) * 365 * notionalUsd;
}

function floorStep(value: number, step: number) {
  return Math.floor((value + 1e-12) / step) * step;
}

function validLeveragePlan(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (!exactKeys(plan, leveragePlanKeys)
    || !isLeverage(plan.leverage) || typeof plan.feasible !== "boolean") return false;
  return leveragePlanNumberKeys.every((key) => Number.isFinite(plan[key]));
}

function exactRecord(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidPreview();
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, keys)) throw invalidPreview();
  return record;
}

function exactTakeoverRecord(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRecord();
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, keys)) throw invalidRecord();
  return record;
}

function validateTakeoverProviderOrder(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRecord();
  const raw = value as Record<string, unknown>;
  const legacyKeys = [
    "averagePrice", "feeUsd", "filledQuantityXaut", "orderId", "orderLinkId",
    "requestedQuantityXaut", "status", "updatedAt",
  ];
  const currentKeys = [...legacyKeys, "positionQuantityXaut"];
  if (!exactKeys(raw, legacyKeys) && !exactKeys(raw, currentKeys)) throw invalidRecord();
  if (
    typeof raw.orderId !== "string" || !raw.orderId
    || typeof raw.orderLinkId !== "string" || !raw.orderLinkId
    || !["New", "PartiallyFilled", "Filled", "Cancelled", "Rejected", "Unknown"]
      .includes(String(raw.status))
    || !nonNegativeFinite(raw.requestedQuantityXaut)
    || !nonNegativeFinite(raw.filledQuantityXaut)
    || !(
      raw.positionQuantityXaut === undefined
      || nonNegativeFinite(raw.positionQuantityXaut)
    )
    || !(raw.averagePrice === null || positiveFinite(raw.averagePrice))
    || !nonNegativeFinite(raw.feeUsd)
    || !timestamp(raw.updatedAt)
  ) throw invalidRecord();
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hex(value: unknown, length: number) {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isLeverage(value: unknown): value is RwaAssetTakeoverLeverage {
  return value === 1 || value === 2 || value === 3;
}

function invalidPreview(): never {
  throw new RwaAssetTakeoverError(
    409,
    "asset_takeover_preview_invalid",
    "接管预览无效、已过期或不属于当前账户，请重新获取。",
  );
}

function invalidRecord(): never {
  throw new RwaAssetTakeoverError(
    503,
    "asset_takeover_invalid",
    "接管持久状态无效，已保持急停并拒绝继续。",
  );
}

function depthRejected() {
  return new RwaAssetTakeoverError(
    409,
    "asset_takeover_risk_rejected",
    "15 bps 滑点范围内的盘口深度不足，已停止接管。",
  );
}

const takeoverStates: RwaAssetTakeoverState[] = [
  "planned", "cancelling_orders", "awaiting_reconfirm", "setting_leverage",
  "opening_spot", "opening_perpetual", "managed", "manual_intervention", "failed",
];

const leveragePlanKeys = [
  "adverseEstimatedAnnualFundingUsd", "adverseFundingAprPercent", "currentEstimatedAnnualFundingUsd",
  "currentFundingAprPercent", "currentReturnOnNewCapitalPercent", "currentReturnOnTotalManagedPercent",
  "estimatedFeesUsd", "estimatedLiquidationPrice", "estimatedSlippageUsd", "feasible", "leverage",
  "liquidationDistancePercent", "median30dEstimatedAnnualFundingUsd", "median30dFundingAprPercent",
  "requiredAvailableCapitalUsd", "reserveUsd",
] as const;
const leveragePlanNumberKeys = leveragePlanKeys.filter((key) => key !== "feasible") as Exclude<
  typeof leveragePlanKeys[number],
  "feasible"
>[];

const takeoverPreviewKeys = [
  "accountFingerprint", "adverseFundingRate", "assetId", "authorizationCreatedAt", "authorizationId",
  "currentFundingRate", "existingManagedCapitalUsd", "expiresAt", "generatedAt", "leveragePlans",
  "maxSlippageBps", "median30dFundingRate", "missingPerpetualQuantity", "missingSpotQuantity",
  "newCapitalUsd", "ordersDigest", "perpetualInitialMarginUsd", "perpetualLeverage",
  "perpetualNotionalUsd", "perpetualOrderCount", "perpetualQuantity", "perpetualSide", "policyDigest",
  "policyVersion", "previewDigest", "previewId", "profileId", "recommendedLeverage", "reserveRatio",
  "referencePerpetualBid", "referenceSpotAsk", "residualQuantity", "selectedLeverage",
  "spotAvailableQuantity", "spotLockedQuantity",
  "spotOrderCount", "spotQuantity", "spotValueUsd", "stateDigest", "targetHedgedQuantity",
  "totalManagedCapitalUsd", "venue",
] as const;

const takeoverPreviewNonNegativeNumberKeys = [
  "authorizationCreatedAt", "existingManagedCapitalUsd",
  "expiresAt", "generatedAt", "maxSlippageBps", "missingPerpetualQuantity",
  "missingSpotQuantity", "newCapitalUsd", "perpetualInitialMarginUsd", "perpetualNotionalUsd",
  "perpetualOrderCount", "perpetualQuantity", "reserveRatio", "residualQuantity", "spotAvailableQuantity",
  "spotLockedQuantity", "spotOrderCount", "spotQuantity", "spotValueUsd", "referencePerpetualBid",
  "referenceSpotAsk", "targetHedgedQuantity",
  "totalManagedCapitalUsd",
] as const;
const takeoverPreviewFiniteNumberKeys = [
  "adverseFundingRate", "currentFundingRate", "median30dFundingRate",
] as const;

const takeoverRecordKeys = [
  "acceptedOrders", "accountFingerprint", "accountId", "assetId", "authorizationCreatedAt", "authorizationId",
  "cancelledOrders", "createdAt", "errorCategory", "finalPerpetualQuantity", "finalSpotQuantity",
  "idempotencyKey", "leverage", "message", "newCapitalUsd", "orderLinkPrefix", "perpetualOrders",
  "plannedMutation", "policyDigest", "policyVersion", "previewDigest", "profileId", "reservedCapitalUsd",
  "residualQuantity", "spotOrders", "state", "takeoverId", "targetHedgedQuantity",
  "totalManagedCapitalUsd", "updatedAt", "userDomain", "userId", "venue",
] as const;

const takeoverRecordNumberKeys = [
  "authorizationCreatedAt", "createdAt", "finalPerpetualQuantity", "finalSpotQuantity", "newCapitalUsd",
  "reservedCapitalUsd", "residualQuantity", "targetHedgedQuantity", "totalManagedCapitalUsd", "updatedAt",
] as const;
