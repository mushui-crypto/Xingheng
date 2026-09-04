import { requestJson } from "./httpClient";
import type { ExchangeVenue } from "./exchangeCredentials";

export type ArbitrageInstanceStatus =
  | "OPENING"
  | "HOLDING"
  | "RESIDUAL"
  | "CLOSING"
  | "CLOSED"
  | "FAILED";

export type ArbitrageInstanceLeg = {
  legId: string;
  role: "LONG" | "SHORT";
  venue: ExchangeVenue;
  accountId: string;
  instrumentId: string;
  plannedQuantity: string;
  confirmedOpenedQuantity: string;
  confirmedClosedQuantity: string;
};

export type ArbitrageExecutionReference = {
  arbitrageId: string;
  legId: string;
  phase: "OPENING" | "ADJUSTMENT" | "CLOSING";
  quantityEffect: "INCREASE" | "DECREASE";
  executionIntentId: string;
  executionRecordId: string | null;
  requestedQuantity: string;
  confirmedQuantity: string;
  status: "CLAIMED" | "LINKED" | "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN";
  createdAt: number;
  updatedAt: number;
};

export type ArbitrageManagementRelease = {
  releaseId: string;
  arbitrageId: string;
  legId: string;
  releasedQuantity: string;
  reason: "USER_CONFIRMED_STOP_MANAGEMENT";
  source: "AUTHENTICATED_API";
  requestedByUserId: string;
  requestedAt: number;
  confirmedAt: number;
  venue: ExchangeVenue;
  accountId: string;
  instrumentId: string;
  positionMode: "ONE_WAY" | "HEDGE";
  actualQuantity: string;
  actualSignedNetQuantity: string | null;
  actualLongQuantity: string;
  actualShortQuantity: string;
  availableQuantity: string | null;
  realityCheckedAt: number;
};

export type ArbitrageLegacyUnresolvedExecutionSeal = {
  commandId: string;
  operationType: "SEAL_LEGACY_UNRESOLVED_EXECUTION";
  requestedByUserId: string;
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  executionRecordId: string;
  venue: ExchangeVenue;
  accountId: string;
  instrumentId: string;
  originalStatus: "UNKNOWN";
  sealStatus: "LEGACY_UNRESOLVED_MANUALLY_SEALED";
  reason: "LEGACY_RECOVERY_IDENTITY_GAP";
  businessPayloadFingerprint: string;
  sealedAt: number;
};

export type ArbitrageInstance = {
  arbitrageId: string;
  userId: string;
  strategyType: "PERPETUAL_PERPETUAL" | "SPOT_PERPETUAL";
  sourcePlanId: string | null;
  maxResidualBaseQuantity: string;
  status: ArbitrageInstanceStatus;
  createdAt: number;
  openedAt: number | null;
  updatedAt: number;
  closedAt: number | null;
  legs: [ArbitrageInstanceLeg, ArbitrageInstanceLeg];
  executionReferences: ArbitrageExecutionReference[];
  managementReleases: ArbitrageManagementRelease[];
  legacyUnresolvedExecutionSeals: ArbitrageLegacyUnresolvedExecutionSeal[];
  pnl: {
    asset: string | null;
    cumulativeFundingPnl: string | null;
    realizedTradingPnl: string | null;
    feesCosts: string | null;
    cumulativeNetPnl: string | null;
    updatedAt: number | null;
  };
};

export type ArbitragePositionPresentation = Readonly<{
  arbitrageId: string;
  market: Readonly<{
    legs?: readonly [ArbitragePositionFundingLeg, ArbitragePositionFundingLeg];
    netFundingRate8h?: number | null;
    nextFundingEvent?: ArbitrageNextFundingEvent;
    managedScaleUsdt?: string | null;
    managedScaleAsOf?: number | null;
    managedScaleCompleteness?: "COMPLETE" | "INCOMPLETE";
    fundingRate: number | null;
    fundingIntervalHours: number | null;
    nextFundingTime: number | null;
    nextEstimatedFundingFee: string | null;
    nextEstimatedFundingFeeAsset: string | null;
    spreadQuotePerBase: number | null;
    spreadBps: number | null;
    quotedAt: number | null;
    marketDataAsOf: number | null;
    completeness: "COMPLETE" | "INCOMPLETE";
  }>;
  revenue: Readonly<{
    expectedArbitrageNetProfit?: string | null;
    cumulativeFundingIncome: string | null;
    incurredFees: string | null;
    estimatedExitFees: string | null;
    exitSpreadProfit?: string | null;
    currentArbitrageNetProfit?: string | null;
    completeness: "COMPLETE" | "INCOMPLETE";
  }>;
}>;

export type ArbitragePositionFundingLeg = Readonly<{
  legId: string;
  venue: ExchangeVenue;
  legRole: "LONG" | "SHORT";
  marketType: "SPOT" | "PERPETUAL";
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  cashflowDirection: "INCOME" | "EXPENSE" | "NEUTRAL" | "NOT_APPLICABLE";
  completeness: "COMPLETE" | "INCOMPLETE";
}>;

export type ArbitrageNextFundingEvent = Readonly<{
  time: number | null;
  estimatedNetFee: string | null;
  eventLegs: readonly Readonly<{
    venue: ExchangeVenue;
    legRole: "LONG" | "SHORT";
    fundingRate: number;
    fundingIntervalHours: number;
    estimatedCashflow: string;
  }>[];
  completeness: "COMPLETE" | "INCOMPLETE";
}>;

export type ArbitrageManagementEndMethod = "NORMAL_CLOSE" | "MANAGEMENT_RELEASE" | "MIXED"
  | "LEGACY_UNRESOLVED_SEAL";

export type ArbitrageLegVerificationStatus = "MATCHED" | "MISMATCH" | "UNKNOWN";

export type ArbitrageLegVerification = {
  arbitrageId: string;
  legId: string;
  expectedManagedQuantity: string;
  actualQuantity: string | null;
  availableQuantity?: string | null;
  verificationStatus: ArbitrageLegVerificationStatus;
  checkedAt: number;
};

export type ArbitragePositionVerification = {
  arbitrageId: string;
  checkedAt: number;
  legs: [ArbitrageLegVerification, ArbitrageLegVerification];
};

export type ArbitrageCloseSafetyReason =
  | "FULL_MANAGED_CLOSE_AVAILABLE"
  | "NO_ACTIVE_MANAGED_EXPOSURE"
  | "PROVIDER_REALITY_UNAVAILABLE"
  | "CLOSE_CAPABILITY_UNAVAILABLE"
  | "ONE_WAY_REALITY_INSUFFICIENT"
  | "HEDGE_BUCKET_INSUFFICIENT"
  | "SPOT_ROLE_UNSUPPORTED"
  | "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE"
  | "SPOT_AVAILABLE_BALANCE_UNAVAILABLE"
  | "SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT"
  | "QUANTITY_STEP_DUST"
  | "TRADING_RULES_REJECT_FULL_QUANTITY";

export type ArbitrageManagementReleaseEligibilityReason =
  | "RELEASE_ELIGIBLE"
  | "INSTANCE_TERMINAL"
  | "UNRESOLVED_EXECUTION"
  | "NO_ACTIVE_MANAGED_EXPOSURE"
  | "PROVIDER_REALITY_UNAVAILABLE"
  | "FULL_MANAGED_CLOSE_AVAILABLE";

export type ArbitrageCloseSafety = {
  activeManagedQuantity: string;
  safeClosableQuantity: string;
  fullManagedCloseAvailable: boolean;
  reason: ArbitrageCloseSafetyReason;
  checkedAt: number;
  realityReliable: boolean;
  releaseEligible: boolean;
  hasUnresolvedExecution: boolean;
  releaseEligibilityReason: ArbitrageManagementReleaseEligibilityReason;
  positionMode: "ONE_WAY" | "HEDGE" | null;
  actualQuantity: string | null;
  actualSignedNetQuantity: string | null;
  actualLongQuantity: string | null;
  actualShortQuantity: string | null;
  availableQuantity: string | null;
};

export type InstanceHedgeDeltaStatus = "KNOWN" | "UNKNOWN";
export type InstanceHedgeDeltaReason =
  | "EXECUTION_EVIDENCE_UNRESOLVED"
  | "EXECUTION_QUANTITY_INCOMPLETE"
  | "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE"
  | "LEG_IDENTITY_INVALID"
  | "ACTIVE_EXPOSURE_INVALID";

export type InstanceHedgeDeltaView = {
  status: InstanceHedgeDeltaStatus;
  signedDeltaBaseQuantity: string | null;
  absoluteDeltaBaseQuantity: string | null;
  reason: InstanceHedgeDeltaReason | null;
};

export type InstanceHedgeDeltaLegContribution = {
  legId: string;
  role: "LONG" | "SHORT";
  marketType: "SPOT" | "PERPETUAL";
  signedContribution: string | null;
  openingSignedContribution: string | null;
  activeManagedQuantity: string;
  source: "SPOT_OPENING_ATTRIBUTION" | "PERPETUAL_CONFIRMED_EXECUTION";
  openingStatus: InstanceHedgeDeltaStatus;
  openingReason: InstanceHedgeDeltaReason | null;
  activeStatus: InstanceHedgeDeltaStatus;
  activeReason: InstanceHedgeDeltaReason | null;
  status: InstanceHedgeDeltaStatus;
  reason: InstanceHedgeDeltaReason | null;
};

export type InstanceHedgeDelta = {
  arbitrageId: string;
  status: ArbitrageInstanceStatus;
  openingDelta: InstanceHedgeDeltaView;
  activeManagedDelta: InstanceHedgeDeltaView;
  openingWorkflow: {
    secondLegRequired: boolean;
    secondLegExecutionEligible: null;
    requiredSecondLegSignedExposure: string | null;
  };
  legContributions: [InstanceHedgeDeltaLegContribution, InstanceHedgeDeltaLegContribution];
  plannedResidualDelta: string;
  actualResidualDelta: string | null;
  derivedAt: number;
  deltaStatus: InstanceHedgeDeltaStatus;
  signedDeltaBaseQuantity: string | null;
  absoluteDeltaBaseQuantity: string | null;
  currentOpeningDelta: string | null;
  openingDeltaStatus: InstanceHedgeDeltaStatus;
  requiredSecondLegSignedExposure: string | null;
  deltaKnown: boolean;
  reason: InstanceHedgeDeltaReason | null;
};

export async function fetchActiveArbitrageInstances(signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-instances/active",
    "套利组合加载失败，请稍后重试",
    { userAuthFailure: true, init: { cache: "no-store", signal } },
  );
  return instanceList(payload);
}

export async function fetchArbitragePositionPresentations(signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-instances/presentation",
    "套利展示行情加载失败，请稍后重试",
    { userAuthFailure: true, init: { cache: "no-store", signal } },
  );
  if (!Array.isArray(payload)) throw invalidResponse();
  return payload.map(positionPresentation);
}

export async function fetchArbitrageInstanceHistory(page = 1, limit = 50, signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    `/api/arbitrage-instances/history?page=${page}&limit=${limit}`,
    "套利组合加载失败，请稍后重试",
    { userAuthFailure: true, init: { cache: "no-store", signal } },
  );
  return instanceList(payload);
}

export async function fetchArbitrageInstanceById(arbitrageId: string, signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    `/api/arbitrage-instances/${encodeURIComponent(arbitrageId)}`,
    "套利组合加载失败，请稍后重试",
    { userAuthFailure: true, init: { cache: "no-store", signal } },
  );
  return instance(payload);
}

export async function fetchArbitragePositionVerification(arbitrageId: string, signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    `/api/arbitrage-instances/${encodeURIComponent(arbitrageId)}/verification`,
    "当前仓位暂无法可靠确认",
    { userAuthFailure: true, init: { cache: "no-store", signal } },
  );
  return positionVerification(payload);
}

export async function fetchArbitrageCloseSafety(
  arbitrageId: string,
  legId: string,
  signal?: AbortSignal,
) {
  const payload = await requestJson<unknown>(
    `/api/arbitrage-instances/${encodeURIComponent(arbitrageId)}/legs/${encodeURIComponent(legId)}/close-safety`,
    "当前退出安全状态暂无法可靠确认",
    { userAuthFailure: true, init: { cache: "no-store", signal } },
  );
  return closeSafety(payload);
}

export async function fetchInstanceHedgeDelta(arbitrageId: string, signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    `/api/arbitrage-instances/${encodeURIComponent(arbitrageId)}/hedge-delta`,
    "当前实例对冲 Delta 暂无法可靠确认",
    { userAuthFailure: true, init: { cache: "no-store", signal } },
  );
  return instanceHedgeDelta(payload);
}

export type ArbitrageManagementReleaseConfirmation = Readonly<{
  instance: ArbitrageInstance;
  release: ArbitrageManagementRelease;
  idempotentReplay: boolean;
}>;

export async function releaseArbitrageLegManagement(input: Readonly<{
  arbitrageId: string;
  legId: string;
  commandId: string;
}>): Promise<ArbitrageManagementReleaseConfirmation> {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-execution/legs/release-management",
    "停止管理请求失败，请重新核验后再试。",
    {
      userAuthFailure: true,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, confirmed: true }),
      },
    },
  );
  const value = requiredRecord(payload);
  return Object.freeze({
    instance: instance(value.instance),
    release: managementRelease(value.release),
    idempotentReplay: booleanValue(value.idempotentReplay),
  });
}

export type ArbitrageUnstartedAbandonmentConfirmation = Readonly<{
  instance: ArbitrageInstance;
  idempotentReplay: boolean;
  providerMutationCount: 0;
}>;

export async function abandonUnstartedArbitrage(input: Readonly<{
  arbitrageId: string;
  commandId: string;
}>): Promise<ArbitrageUnstartedAbandonmentConfirmation> {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-execution/abandon-unstarted",
    "未开始套利终止失败，请重新加载实例状态后再试。",
    {
      userAuthFailure: true,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, confirmed: true }),
      },
    },
  );
  const value = requiredRecord(payload);
  if (value.providerMutationCount !== 0) {
    throw new Error("Unstarted arbitrage abandonment mutation count is invalid.");
  }
  return Object.freeze({
    instance: instance(value.instance),
    idempotentReplay: booleanValue(value.idempotentReplay),
    providerMutationCount: 0,
  });
}

export function requireArbitrageInstanceList(payload: unknown) {
  return instanceList(payload);
}

export function requireArbitrageInstance(payload: unknown) {
  return instance(payload);
}

export function requireArbitragePositionVerification(payload: unknown) {
  return positionVerification(payload);
}

export function deriveArbitrageManagementEndMethod(
  value: ArbitrageInstance,
): ArbitrageManagementEndMethod | null {
  if (value.status !== "CLOSED") return null;
  if (value.legacyUnresolvedExecutionSeals.length > 0) return "LEGACY_UNRESOLVED_SEAL";
  if (value.managementReleases.length === 0) return "NORMAL_CLOSE";
  const hasConfirmedCloseExecution = value.executionReferences.some((reference) =>
    reference.phase === "CLOSING"
    && reference.quantityEffect === "DECREASE"
    && !isZeroDecimal(reference.confirmedQuantity)
    && (reference.status === "CONFIRMED" || reference.status === "FAILED"));
  return hasConfirmedCloseExecution ? "MIXED" : "MANAGEMENT_RELEASE";
}

function instanceList(payload: unknown) {
  if (!Array.isArray(payload)) throw invalidResponse();
  return payload.map(instance);
}

function positionPresentation(payload: unknown): ArbitragePositionPresentation {
  const value = requiredRecord(payload);
  const market = requiredRecord(value.market);
  const revenue = requiredRecord(value.revenue);
  const completeness = market.completeness === "COMPLETE" || market.completeness === "INCOMPLETE"
    ? market.completeness : invalidResponse();
  const revenueCompleteness = revenue.completeness === "COMPLETE" || revenue.completeness === "INCOMPLETE"
    ? revenue.completeness : invalidResponse();
  const legs = Array.isArray(market.legs) && market.legs.length === 2
    ? market.legs.map(positionFundingLeg) as [ArbitragePositionFundingLeg, ArbitragePositionFundingLeg]
    : invalidResponse();
  const nextFundingEvent = parseNextFundingEvent(market.nextFundingEvent);
  const managedScaleCompleteness = market.managedScaleCompleteness === "COMPLETE" || market.managedScaleCompleteness === "INCOMPLETE"
    ? market.managedScaleCompleteness : invalidResponse();
  return {
    arbitrageId: requiredString(value.arbitrageId),
    market: {
      legs,
      netFundingRate8h: nullableFiniteNumber(market.netFundingRate8h),
      nextFundingEvent,
      managedScaleUsdt: nullableDecimal(market.managedScaleUsdt),
      managedScaleAsOf: nullableTimestamp(market.managedScaleAsOf),
      managedScaleCompleteness,
      fundingRate: nullableFiniteNumber(market.fundingRate),
      fundingIntervalHours: nullableFiniteNumber(market.fundingIntervalHours),
      nextFundingTime: nullableTimestamp(market.nextFundingTime),
      nextEstimatedFundingFee: nullableDecimal(market.nextEstimatedFundingFee),
      nextEstimatedFundingFeeAsset: nullableString(market.nextEstimatedFundingFeeAsset),
      spreadQuotePerBase: nullableFiniteNumber(market.spreadQuotePerBase),
      spreadBps: nullableFiniteNumber(market.spreadBps),
      quotedAt: nullableTimestamp(market.quotedAt),
      marketDataAsOf: nullableTimestamp(market.marketDataAsOf),
      completeness,
    },
    revenue: {
      expectedArbitrageNetProfit: nullableDecimal(revenue.expectedArbitrageNetProfit),
      cumulativeFundingIncome: nullableDecimal(revenue.cumulativeFundingIncome),
      incurredFees: nullableDecimal(revenue.incurredFees),
      estimatedExitFees: nullableDecimal(revenue.estimatedExitFees),
      exitSpreadProfit: nullableDecimal(revenue.exitSpreadProfit),
      completeness: revenueCompleteness,
    },
  };
}

function positionFundingLeg(payload: unknown): ArbitragePositionFundingLeg {
  const value = requiredRecord(payload);
  const marketType = value.marketType === "SPOT" || value.marketType === "PERPETUAL" ? value.marketType : invalidResponse();
  const legRole = value.legRole === "LONG" || value.legRole === "SHORT" ? value.legRole : invalidResponse();
  const cashflowDirection = value.cashflowDirection === "INCOME" || value.cashflowDirection === "EXPENSE"
    || value.cashflowDirection === "NEUTRAL" || value.cashflowDirection === "NOT_APPLICABLE"
    ? value.cashflowDirection : invalidResponse();
  const completeness = value.completeness === "COMPLETE" || value.completeness === "INCOMPLETE"
    ? value.completeness : invalidResponse();
  return {
    legId: requiredString(value.legId), venue: venue(value.venue), legRole, marketType,
    fundingRate: nullableFiniteNumber(value.fundingRate),
    fundingIntervalHours: nullableFiniteNumber(value.fundingIntervalHours),
    cashflowDirection, completeness,
  };
}

function parseNextFundingEvent(payload: unknown): ArbitrageNextFundingEvent {
  const value = requiredRecord(payload);
  if (!Array.isArray(value.eventLegs)) throw invalidResponse();
  const completeness = value.completeness === "COMPLETE" || value.completeness === "INCOMPLETE"
    ? value.completeness : invalidResponse();
  return {
    time: nullableTimestamp(value.time),
    estimatedNetFee: nullableDecimal(value.estimatedNetFee),
    eventLegs: value.eventLegs.map((payload) => {
      const leg = requiredRecord(payload);
      const legRole = leg.legRole === "LONG" || leg.legRole === "SHORT" ? leg.legRole : invalidResponse();
      return {
        venue: venue(leg.venue), legRole,
        fundingRate: requiredFiniteNumber(leg.fundingRate),
        fundingIntervalHours: requiredFiniteNumber(leg.fundingIntervalHours),
        estimatedCashflow: decimal(leg.estimatedCashflow),
      };
    }),
    completeness,
  };
}

function nullableFiniteNumber(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidResponse();
  return value;
}

function requiredFiniteNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidResponse();
  return value;
}

function instance(payload: unknown): ArbitrageInstance {
  const value = record(payload);
  if (!value || !Array.isArray(value.legs) || value.legs.length !== 2
    || !Array.isArray(value.executionReferences)) throw invalidResponse();
  const legs = value.legs.map(leg);
  if (legs[0]?.role !== "LONG" || legs[1]?.role !== "SHORT") throw invalidResponse();
  const pnl = requiredRecord(value.pnl);
  return {
    arbitrageId: requiredString(value.arbitrageId),
    userId: requiredString(value.userId),
    strategyType: strategyType(value.strategyType),
    sourcePlanId: nullableString(value.sourcePlanId),
    maxResidualBaseQuantity: decimal(value.maxResidualBaseQuantity),
    status: instanceStatus(value.status),
    createdAt: timestamp(value.createdAt),
    openedAt: nullableTimestamp(value.openedAt),
    updatedAt: timestamp(value.updatedAt),
    closedAt: nullableTimestamp(value.closedAt),
    legs: legs as [ArbitrageInstanceLeg, ArbitrageInstanceLeg],
    executionReferences: value.executionReferences.map(executionReference),
    managementReleases: value.managementReleases === undefined
      ? []
      : Array.isArray(value.managementReleases)
        ? value.managementReleases.map(managementRelease)
        : invalidResponse(),
    legacyUnresolvedExecutionSeals: value.legacyUnresolvedExecutionSeals === undefined
      ? []
      : Array.isArray(value.legacyUnresolvedExecutionSeals)
        ? value.legacyUnresolvedExecutionSeals.map(legacyUnresolvedExecutionSeal)
        : invalidResponse(),
    pnl: {
      asset: nullableString(pnl.asset),
      cumulativeFundingPnl: nullableDecimal(pnl.cumulativeFundingPnl),
      realizedTradingPnl: nullableDecimal(pnl.realizedTradingPnl),
      feesCosts: nullableDecimal(pnl.feesCosts),
      cumulativeNetPnl: nullableDecimal(pnl.cumulativeNetPnl),
      updatedAt: nullableTimestamp(pnl.updatedAt),
    },
  };
}

function legacyUnresolvedExecutionSeal(payload: unknown): ArbitrageLegacyUnresolvedExecutionSeal {
  const value = requiredRecord(payload);
  return {
    commandId: requiredString(value.commandId),
    operationType: value.operationType === "SEAL_LEGACY_UNRESOLVED_EXECUTION" ? value.operationType : invalidResponse(),
    requestedByUserId: requiredString(value.requestedByUserId),
    arbitrageId: requiredString(value.arbitrageId),
    legId: requiredString(value.legId),
    executionIntentId: requiredString(value.executionIntentId),
    executionRecordId: requiredString(value.executionRecordId),
    venue: venue(value.venue),
    accountId: requiredString(value.accountId),
    instrumentId: requiredString(value.instrumentId),
    originalStatus: value.originalStatus === "UNKNOWN" ? value.originalStatus : invalidResponse(),
    sealStatus: value.sealStatus === "LEGACY_UNRESOLVED_MANUALLY_SEALED" ? value.sealStatus : invalidResponse(),
    reason: value.reason === "LEGACY_RECOVERY_IDENTITY_GAP" ? value.reason : invalidResponse(),
    businessPayloadFingerprint: requiredString(value.businessPayloadFingerprint),
    sealedAt: timestamp(value.sealedAt),
  };
}

function managementRelease(payload: unknown): ArbitrageManagementRelease {
  const value = requiredRecord(payload);
  return {
    releaseId: requiredString(value.releaseId),
    arbitrageId: requiredString(value.arbitrageId),
    legId: requiredString(value.legId),
    releasedQuantity: decimal(value.releasedQuantity),
    reason: value.reason === "USER_CONFIRMED_STOP_MANAGEMENT" ? value.reason : invalidResponse(),
    source: value.source === "AUTHENTICATED_API" ? value.source : invalidResponse(),
    requestedByUserId: requiredString(value.requestedByUserId),
    requestedAt: timestamp(value.requestedAt),
    confirmedAt: timestamp(value.confirmedAt),
    venue: venue(value.venue),
    accountId: requiredString(value.accountId),
    instrumentId: requiredString(value.instrumentId),
    positionMode: positionMode(value.positionMode),
    actualQuantity: decimal(value.actualQuantity),
    actualSignedNetQuantity: nullableDecimal(value.actualSignedNetQuantity),
    actualLongQuantity: decimal(value.actualLongQuantity),
    actualShortQuantity: decimal(value.actualShortQuantity),
    availableQuantity: nullableDecimal(value.availableQuantity),
    realityCheckedAt: timestamp(value.realityCheckedAt),
  };
}

function positionVerification(payload: unknown): ArbitragePositionVerification {
  const value = requiredRecord(payload);
  if (!Array.isArray(value.legs) || value.legs.length !== 2) throw invalidVerificationResponse();
  const legs = value.legs.map(legVerification);
  const arbitrageId = requiredString(value.arbitrageId);
  if (legs.some((item) => item.arbitrageId !== arbitrageId)) throw invalidVerificationResponse();
  return {
    arbitrageId,
    checkedAt: timestamp(value.checkedAt),
    legs: legs as [ArbitrageLegVerification, ArbitrageLegVerification],
  };
}

function legVerification(payload: unknown): ArbitrageLegVerification {
  const value = requiredRecord(payload);
  return {
    arbitrageId: requiredString(value.arbitrageId),
    legId: requiredString(value.legId),
    expectedManagedQuantity: decimal(value.expectedManagedQuantity),
    actualQuantity: nullableDecimal(value.actualQuantity),
    availableQuantity: value.availableQuantity === undefined ? null : nullableDecimal(value.availableQuantity),
    verificationStatus: verificationStatus(value.verificationStatus),
    checkedAt: timestamp(value.checkedAt),
  };
}

function closeSafety(payload: unknown): ArbitrageCloseSafety {
  const value = requiredRecord(payload);
  return {
    activeManagedQuantity: decimal(value.activeManagedQuantity),
    safeClosableQuantity: decimal(value.safeClosableQuantity),
    fullManagedCloseAvailable: booleanValue(value.fullManagedCloseAvailable),
    reason: closeSafetyReason(value.reason),
    checkedAt: timestamp(value.checkedAt),
    realityReliable: booleanValue(value.realityReliable),
    releaseEligible: booleanValue(value.releaseEligible),
    hasUnresolvedExecution: booleanValue(value.hasUnresolvedExecution),
    releaseEligibilityReason: releaseEligibilityReason(value.releaseEligibilityReason),
    positionMode: value.positionMode === null ? null : positionMode(value.positionMode),
    actualQuantity: nullableDecimal(value.actualQuantity),
    actualSignedNetQuantity: nullableDecimal(value.actualSignedNetQuantity),
    actualLongQuantity: nullableDecimal(value.actualLongQuantity),
    actualShortQuantity: nullableDecimal(value.actualShortQuantity),
    availableQuantity: nullableDecimal(value.availableQuantity),
  };
}

function instanceHedgeDelta(payload: unknown): InstanceHedgeDelta {
  const value = requiredRecord(payload);
  if (!Array.isArray(value.legContributions) || value.legContributions.length !== 2) throw invalidResponse();
  return {
    arbitrageId: requiredString(value.arbitrageId),
    status: instanceStatus(value.status),
    openingDelta: deltaView(value.openingDelta),
    activeManagedDelta: deltaView(value.activeManagedDelta),
    openingWorkflow: openingWorkflow(value.openingWorkflow),
    legContributions: value.legContributions.map(deltaLegContribution) as [
      InstanceHedgeDeltaLegContribution,
      InstanceHedgeDeltaLegContribution,
    ],
    plannedResidualDelta: decimal(value.plannedResidualDelta),
    actualResidualDelta: nullableDecimal(value.actualResidualDelta),
    derivedAt: timestamp(value.derivedAt),
    deltaStatus: deltaStatus(value.deltaStatus),
    signedDeltaBaseQuantity: nullableDecimal(value.signedDeltaBaseQuantity),
    absoluteDeltaBaseQuantity: nullableDecimal(value.absoluteDeltaBaseQuantity),
    currentOpeningDelta: nullableDecimal(value.currentOpeningDelta),
    openingDeltaStatus: deltaStatus(value.openingDeltaStatus),
    requiredSecondLegSignedExposure: nullableDecimal(value.requiredSecondLegSignedExposure),
    deltaKnown: booleanValue(value.deltaKnown),
    reason: nullableDeltaReason(value.reason),
  };
}

function deltaView(payload: unknown): InstanceHedgeDeltaView {
  const value = requiredRecord(payload);
  return {
    status: deltaStatus(value.status),
    signedDeltaBaseQuantity: nullableDecimal(value.signedDeltaBaseQuantity),
    absoluteDeltaBaseQuantity: nullableDecimal(value.absoluteDeltaBaseQuantity),
    reason: nullableDeltaReason(value.reason),
  };
}

function openingWorkflow(payload: unknown): InstanceHedgeDelta["openingWorkflow"] {
  const value = requiredRecord(payload);
  if (value.secondLegExecutionEligible !== null) throw invalidResponse();
  return {
    secondLegRequired: booleanValue(value.secondLegRequired),
    secondLegExecutionEligible: null,
    requiredSecondLegSignedExposure: nullableDecimal(value.requiredSecondLegSignedExposure),
  };
}

function deltaLegContribution(payload: unknown): InstanceHedgeDeltaLegContribution {
  const value = requiredRecord(payload);
  return {
    legId: requiredString(value.legId),
    role: value.role === "LONG" || value.role === "SHORT" ? value.role : invalidResponse(),
    marketType: value.marketType === "SPOT" || value.marketType === "PERPETUAL"
      ? value.marketType : invalidResponse(),
    signedContribution: nullableDecimal(value.signedContribution),
    openingSignedContribution: nullableDecimal(value.openingSignedContribution),
    activeManagedQuantity: decimal(value.activeManagedQuantity),
    source: value.source === "SPOT_OPENING_ATTRIBUTION" || value.source === "PERPETUAL_CONFIRMED_EXECUTION"
      ? value.source : invalidResponse(),
    openingStatus: deltaStatus(value.openingStatus),
    openingReason: nullableDeltaReason(value.openingReason),
    activeStatus: deltaStatus(value.activeStatus),
    activeReason: nullableDeltaReason(value.activeReason),
    status: deltaStatus(value.status),
    reason: nullableDeltaReason(value.reason),
  };
}

function leg(payload: unknown): ArbitrageInstanceLeg {
  const value = requiredRecord(payload);
  return {
    legId: requiredString(value.legId),
    role: value.role === "LONG" || value.role === "SHORT" ? value.role : invalidResponse(),
    venue: venue(value.venue),
    accountId: requiredString(value.accountId),
    instrumentId: requiredString(value.instrumentId),
    plannedQuantity: decimal(value.plannedQuantity),
    confirmedOpenedQuantity: decimal(value.confirmedOpenedQuantity),
    confirmedClosedQuantity: decimal(value.confirmedClosedQuantity),
  };
}

function executionReference(payload: unknown): ArbitrageExecutionReference {
  const value = requiredRecord(payload);
  return {
    arbitrageId: requiredString(value.arbitrageId),
    legId: requiredString(value.legId),
    phase: value.phase === "OPENING" || value.phase === "ADJUSTMENT" || value.phase === "CLOSING"
      ? value.phase : invalidResponse(),
    quantityEffect: value.quantityEffect === "INCREASE" || value.quantityEffect === "DECREASE"
      ? value.quantityEffect : invalidResponse(),
    executionIntentId: requiredString(value.executionIntentId),
    executionRecordId: nullableString(value.executionRecordId),
    requestedQuantity: decimal(value.requestedQuantity),
    confirmedQuantity: decimal(value.confirmedQuantity),
    status: referenceStatus(value.status),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
}

function instanceStatus(value: unknown): ArbitrageInstanceStatus {
  if (value === "OPENING" || value === "HOLDING" || value === "RESIDUAL"
    || value === "CLOSING" || value === "CLOSED" || value === "FAILED") return value;
  throw invalidResponse();
}

function referenceStatus(value: unknown): ArbitrageExecutionReference["status"] {
  if (value === "CLAIMED" || value === "LINKED" || value === "PENDING_CONFIRMATION"
    || value === "CONFIRMED" || value === "FAILED" || value === "UNKNOWN") return value;
  throw invalidResponse();
}

function verificationStatus(value: unknown): ArbitrageLegVerificationStatus {
  if (value === "MATCHED" || value === "MISMATCH" || value === "UNKNOWN") return value;
  throw invalidVerificationResponse();
}

function closeSafetyReason(value: unknown): ArbitrageCloseSafetyReason {
  if (value === "FULL_MANAGED_CLOSE_AVAILABLE"
    || value === "NO_ACTIVE_MANAGED_EXPOSURE"
    || value === "PROVIDER_REALITY_UNAVAILABLE"
    || value === "CLOSE_CAPABILITY_UNAVAILABLE"
    || value === "ONE_WAY_REALITY_INSUFFICIENT"
    || value === "HEDGE_BUCKET_INSUFFICIENT"
    || value === "SPOT_ROLE_UNSUPPORTED"
    || value === "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE"
    || value === "SPOT_AVAILABLE_BALANCE_UNAVAILABLE"
    || value === "SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT"
    || value === "QUANTITY_STEP_DUST"
    || value === "TRADING_RULES_REJECT_FULL_QUANTITY") return value;
  throw invalidResponse();
}

function releaseEligibilityReason(value: unknown): ArbitrageManagementReleaseEligibilityReason {
  if (value === "RELEASE_ELIGIBLE"
    || value === "INSTANCE_TERMINAL"
    || value === "UNRESOLVED_EXECUTION"
    || value === "NO_ACTIVE_MANAGED_EXPOSURE"
    || value === "PROVIDER_REALITY_UNAVAILABLE"
    || value === "FULL_MANAGED_CLOSE_AVAILABLE") return value;
  throw invalidResponse();
}

function positionMode(value: unknown): "ONE_WAY" | "HEDGE" {
  if (value === "ONE_WAY" || value === "HEDGE") return value;
  throw invalidResponse();
}

function deltaStatus(value: unknown): InstanceHedgeDeltaStatus {
  if (value === "KNOWN" || value === "UNKNOWN") return value;
  throw invalidResponse();
}

function nullableDeltaReason(value: unknown): InstanceHedgeDeltaReason | null {
  if (value === null) return null;
  if (value === "EXECUTION_EVIDENCE_UNRESOLVED"
    || value === "EXECUTION_QUANTITY_INCOMPLETE"
    || value === "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE"
    || value === "LEG_IDENTITY_INVALID"
    || value === "ACTIVE_EXPOSURE_INVALID") return value;
  throw invalidResponse();
}

function strategyType(value: unknown): ArbitrageInstance["strategyType"] {
  if (value === "PERPETUAL_PERPETUAL" || value === "SPOT_PERPETUAL") return value;
  throw invalidResponse();
}

function venue(value: unknown): ExchangeVenue {
  if (value === "binance" || value === "okx" || value === "bybit" || value === "bitget") return value;
  throw invalidResponse();
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredRecord(value: unknown) {
  const parsed = record(value);
  if (!parsed) throw invalidResponse();
  return parsed;
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw invalidResponse();
  return value;
}

function nullableString(value: unknown) {
  return value === null ? null : requiredString(value);
}

function decimal(value: unknown) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw invalidResponse();
  return value;
}

function isZeroDecimal(value: string) {
  return /^-?0(?:\.0+)?$/u.test(value);
}

function nullableDecimal(value: unknown) {
  return value === null ? null : decimal(value);
}

function timestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidResponse();
  return value;
}

function nullableTimestamp(value: unknown) {
  return value === null ? null : timestamp(value);
}

function booleanValue(value: unknown) {
  if (typeof value !== "boolean") throw invalidResponse();
  return value;
}

function invalidResponse(): never {
  throw new Error("套利组合数据响应无效");
}

function invalidVerificationResponse(): never {
  throw new Error("仓位核验数据响应无效");
}
