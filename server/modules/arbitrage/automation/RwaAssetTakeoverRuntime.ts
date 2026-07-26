import { createHash, randomBytes } from "node:crypto";
import type { RwaAssetOrderReference } from "./RwaAccountAssetAuthorization";
import type { RwaAutomationResolvedAssetProfile } from "./RwaAutomationAssetProfile";
import type { RwaProviderOrder } from "./RwaNeutralExecutionTypes";

export const RWA_ASSET_RUNTIME_POLL_INTERVAL_MS = 60_000;
export const RWA_ASSET_RUNTIME_PUBLIC_POLL_INTERVAL_MS = 5_000;
export const RWA_ASSET_RUNTIME_READ_FAILURE_LIMIT = 3;
export const RWA_ASSET_RUNTIME_READ_FAILURE_MAX_MS = 5 * 60_000;
export const RWA_ASSET_RUNTIME_MAX_FUNDING_SETTLEMENTS = 96;
export const RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS = 96;
export const RWA_ASSET_RUNTIME_NORMAL_SLIPPAGE_BPS = 15 as const;
export const RWA_ASSET_RUNTIME_EMERGENCY_SLIPPAGE_BPS = [15, 30, 50] as const;
export const RWA_ASSET_EXIT_PREVIEW_TTL_MS = 30_000;

export type RwaAssetFundingSettlement = {
  cycleId: string;
  settlementId: string;
  settledAt: number;
  netFundingUsd: number;
  fundingRate: number | null;
};

export function aggregateRwaAssetFundingCycles(
  settlements: readonly RwaAssetFundingSettlement[],
): RwaAssetFundingSettlement[] {
  const cycles = new Map<string, RwaAssetFundingSettlement[]>();
  for (const settlement of settlements) {
    const items = cycles.get(settlement.cycleId) ?? [];
    items.push(settlement);
    cycles.set(settlement.cycleId, items);
  }
  return [...cycles.entries()].map(([cycleId, items]) => {
    const ordered = [...items].sort((left, right) =>
      left.settlementId.localeCompare(right.settlementId));
    const settledAt = ordered[0]!.settledAt;
    if (ordered.some((item) => item.settledAt !== settledAt)) {
      throw new Error("asset_takeover_funding_cycle_invalid");
    }
    return {
      cycleId,
      settlementId: createHash("sha256")
        .update(JSON.stringify(ordered.map((item) => item.settlementId)))
        .digest("hex"),
      settledAt,
      netFundingUsd: ordered.reduce((total, item) => total + item.netFundingUsd, 0),
      fundingRate: ordered.every((item) => item.fundingRate === ordered[0]!.fundingRate)
        ? ordered[0]!.fundingRate
        : null,
    };
  }).sort((left, right) =>
    left.settledAt - right.settledAt || left.cycleId.localeCompare(right.cycleId));
}

export type RwaAssetTakeoverRuntimeSnapshot = {
  capturedAt: number;
  ordersDigest: string;
  providerStateDigest: string;
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

export type RwaAssetTakeoverRuntimePhase =
  | "recovery_required"
  | "monitoring"
  | "paused"
  | "reducing"
  | "exiting"
  | "manual_intervention"
  | "exited";

export type RwaAssetTakeoverRuntimeReason =
  | "user_exit"
  | "user_kill_switch"
  | "server_kill_switch"
  | "liquidation_distance"
  | "funding_unfavorable"
  | "account_changed"
  | "external_position_change"
  | "provider_read_failure"
  | "persistent_state_invalid"
  | null;

export type RwaAssetTakeoverRuntimeMutation =
  | {
    kind: "cancel";
    category: "spot" | "linear";
    orderId: string;
  }
  | {
    kind: "place";
    category: "spot" | "linear";
    orderLinkId: string;
    quantityBase: number;
    limitPrice: number;
    reduceOnly: boolean;
    slippageBps: 15 | 30 | 50;
    attempt: number;
  };

export type RwaAssetTakeoverRuntimeState = {
  schemaVersion: 1;
  phase: RwaAssetTakeoverRuntimePhase;
  reason: RwaAssetTakeoverRuntimeReason;
  authoritativeSnapshot: RwaAssetTakeoverRuntimeSnapshot | null;
  plannedMutation: RwaAssetTakeoverRuntimeMutation | null;
  mutationSequence: number;
  acceptedOrders: Array<{
    category: "spot" | "linear";
    orderId: string;
    orderLinkId: string;
  }>;
  providerResults: RwaProviderOrder[];
  cancelledOrders: Array<Pick<RwaAssetOrderReference, "category" | "orderId" | "symbol">>;
  fundingCheckpointAt: number;
  fundingSettlements: RwaAssetFundingSettlement[];
  unfavorableFundingStreak: number;
  consecutiveReadFailures: number;
  firstReadFailureAt: number | null;
  lastSuccessfulCheckAt: number | null;
  exitStartedAt: number | null;
  exitCompletedAt: number | null;
  exitIdempotencyKey: string | null;
  residualSpotQuantity: number;
  residualPerpetualQuantity: number;
  message: string;
  updatedAt: number;
};

export type RwaAssetTakeoverExitPreview = {
  previewId: string;
  takeoverId: string;
  venue: "binance" | "bybit";
  assetId: "xaut";
  profileId: string;
  authorizationId: string;
  authorizationCreatedAt: number;
  spotQuantity: number;
  spotAvailableQuantity: number;
  spotLockedQuantity: number;
  perpetualQuantity: number;
  perpetualSide: "short" | "flat";
  ordersDigest: string;
  normalSlippageBps: 15;
  emergencySlippageBps: readonly [15, 30, 50];
  generatedAt: number;
  expiresAt: number;
  previewDigest: string;
};

export function createRwaAssetTakeoverRuntimeRecovery(updatedAt: number): RwaAssetTakeoverRuntimeState {
  return {
    schemaVersion: 1,
    phase: "recovery_required",
    reason: null,
    authoritativeSnapshot: null,
    plannedMutation: null,
    mutationSequence: 0,
    acceptedOrders: [],
    providerResults: [],
    cancelledOrders: [],
    fundingCheckpointAt: updatedAt,
    fundingSettlements: [],
    unfavorableFundingStreak: 0,
    consecutiveReadFailures: 0,
    firstReadFailureAt: null,
    lastSuccessfulCheckAt: null,
    exitStartedAt: null,
    exitCompletedAt: null,
    exitIdempotencyKey: null,
    residualSpotQuantity: 0,
    residualPerpetualQuantity: 0,
    message: "接管运行状态需要先读取交易所权威快照后恢复。",
    updatedAt,
  };
}

export function createRwaAssetTakeoverRuntime(
  snapshot: RwaAssetTakeoverRuntimeSnapshot,
): RwaAssetTakeoverRuntimeState {
  return {
    ...createRwaAssetTakeoverRuntimeRecovery(snapshot.capturedAt),
    phase: "monitoring",
    authoritativeSnapshot: snapshot,
    fundingCheckpointAt: snapshot.capturedAt,
    lastSuccessfulCheckAt: snapshot.capturedAt,
    message: "XAUT 双腿严格对冲，后台监控已就绪。",
  };
}

export function createRwaAssetTakeoverRuntimeManual(
  updatedAt: number,
  reason: Exclude<RwaAssetTakeoverRuntimeReason, null> = "persistent_state_invalid",
  message = "XAUT 接管或运行状态无法安全恢复，已要求人工处理。",
): RwaAssetTakeoverRuntimeState {
  return {
    ...createRwaAssetTakeoverRuntimeRecovery(updatedAt),
    phase: "manual_intervention",
    reason,
    message,
  };
}

export function createRwaAssetTakeoverExitPreview(input: {
  takeoverId: string;
  venue: "binance" | "bybit";
  assetId: "xaut";
  profileId: string;
  authorizationId: string;
  authorizationCreatedAt: number;
  snapshot: RwaAssetTakeoverRuntimeSnapshot;
  now: number;
}): RwaAssetTakeoverExitPreview {
  const state = {
    takeoverId: input.takeoverId,
    venue: input.venue,
    assetId: input.assetId,
    profileId: input.profileId,
    authorizationId: input.authorizationId,
    authorizationCreatedAt: input.authorizationCreatedAt,
    spotQuantity: input.snapshot.spotQuantity,
    spotAvailableQuantity: input.snapshot.spotAvailableQuantity,
    spotLockedQuantity: input.snapshot.spotLockedQuantity,
    perpetualQuantity: input.snapshot.perpetualQuantity,
    perpetualSide: input.snapshot.perpetualSide,
    ordersDigest: input.snapshot.ordersDigest,
    normalSlippageBps: RWA_ASSET_RUNTIME_NORMAL_SLIPPAGE_BPS,
    emergencySlippageBps: RWA_ASSET_RUNTIME_EMERGENCY_SLIPPAGE_BPS,
  } as const;
  const generatedAt = input.now;
  const payload = {
    previewId: randomBytes(32).toString("hex"),
    ...state,
    generatedAt,
    expiresAt: generatedAt + RWA_ASSET_EXIT_PREVIEW_TTL_MS,
  };
  return {
    ...payload,
    previewDigest: runtimeDigest(payload),
  };
}

export function validateRwaAssetTakeoverExitPreview(value: unknown): RwaAssetTakeoverExitPreview {
  const preview = exactObject(value, exitPreviewKeys);
  if (
    !hex(preview.previewId, 64)
    || !nonEmptyString(preview.takeoverId)
    || !["binance", "bybit"].includes(String(preview.venue))
    || preview.assetId !== "xaut"
    || !nonEmptyString(preview.profileId)
    || !nonEmptyString(preview.authorizationId)
    || !safeTimestamp(preview.authorizationCreatedAt)
    || !nonNegativeFinite(preview.spotQuantity)
    || !nonNegativeFinite(preview.spotAvailableQuantity)
    || !nonNegativeFinite(preview.spotLockedQuantity)
    || !nonNegativeFinite(preview.perpetualQuantity)
    || !["short", "flat"].includes(String(preview.perpetualSide))
    || !hex(preview.ordersDigest, 64)
    || preview.normalSlippageBps !== RWA_ASSET_RUNTIME_NORMAL_SLIPPAGE_BPS
    || !Array.isArray(preview.emergencySlippageBps)
    || preview.emergencySlippageBps.join(",") !== RWA_ASSET_RUNTIME_EMERGENCY_SLIPPAGE_BPS.join(",")
    || !safeTimestamp(preview.generatedAt)
    || preview.expiresAt !== preview.generatedAt + RWA_ASSET_EXIT_PREVIEW_TTL_MS
    || !hex(preview.previewDigest, 64)
  ) throw new Error("asset_takeover_exit_preview_invalid");
  const { previewDigest, ...payload } = preview;
  if (previewDigest !== runtimeDigest(payload)) throw new Error("asset_takeover_exit_preview_invalid");
  return preview as unknown as RwaAssetTakeoverExitPreview;
}

export function assertRwaAssetTakeoverExitPreview(input: {
  provided: RwaAssetTakeoverExitPreview;
  current: RwaAssetTakeoverExitPreview;
  now: number;
}) {
  const provided = validateRwaAssetTakeoverExitPreview(input.provided);
  const current = validateRwaAssetTakeoverExitPreview(input.current);
  if (
    provided.expiresAt <= input.now
    || provided.takeoverId !== current.takeoverId
    || provided.venue !== current.venue
    || provided.assetId !== current.assetId
    || provided.profileId !== current.profileId
    || provided.authorizationId !== current.authorizationId
    || provided.authorizationCreatedAt !== current.authorizationCreatedAt
    || provided.spotQuantity !== current.spotQuantity
    || provided.spotAvailableQuantity !== current.spotAvailableQuantity
    || provided.spotLockedQuantity !== current.spotLockedQuantity
    || provided.perpetualQuantity !== current.perpetualQuantity
    || provided.perpetualSide !== current.perpetualSide
    || provided.ordersDigest !== current.ordersDigest
  ) throw new Error("asset_takeover_exit_preview_invalid");
}

export function validateRwaAssetTakeoverRuntime(
  value: unknown,
  profile: RwaAutomationResolvedAssetProfile,
): RwaAssetTakeoverRuntimeState {
  const runtime = exactObject(value, runtimeKeys);
  if (
    runtime.schemaVersion !== 1
    || !runtimePhases.includes(runtime.phase as RwaAssetTakeoverRuntimePhase)
    || !runtimeReasons.includes(runtime.reason as RwaAssetTakeoverRuntimeReason)
    || !(runtime.authoritativeSnapshot === null || typeof runtime.authoritativeSnapshot === "object")
    || !(runtime.plannedMutation === null || typeof runtime.plannedMutation === "object")
    || !safeIntegerInRange(runtime.mutationSequence, 0, Number.MAX_SAFE_INTEGER)
    || !Array.isArray(runtime.acceptedOrders)
    || !Array.isArray(runtime.providerResults)
    || !Array.isArray(runtime.cancelledOrders)
    || !Array.isArray(runtime.fundingSettlements)
    || runtime.acceptedOrders.length > RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS
    || runtime.providerResults.length > RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS
    || runtime.cancelledOrders.length > RWA_ASSET_RUNTIME_MAX_PROVIDER_RESULTS
    || runtime.fundingSettlements.length > RWA_ASSET_RUNTIME_MAX_FUNDING_SETTLEMENTS
    || !safeTimestamp(runtime.fundingCheckpointAt)
    || !safeIntegerInRange(runtime.unfavorableFundingStreak, 0, 2)
    || !safeIntegerInRange(runtime.consecutiveReadFailures, 0, RWA_ASSET_RUNTIME_READ_FAILURE_LIMIT)
    || !nullableTimestamp(runtime.firstReadFailureAt)
    || !nullableTimestamp(runtime.lastSuccessfulCheckAt)
    || !nullableTimestamp(runtime.exitStartedAt)
    || !nullableTimestamp(runtime.exitCompletedAt)
    || !(runtime.exitIdempotencyKey === null
      || (typeof runtime.exitIdempotencyKey === "string"
        && /^[A-Za-z0-9._:-]{8,128}$/.test(runtime.exitIdempotencyKey)))
    || !nonNegativeFinite(runtime.residualSpotQuantity)
    || !nonNegativeFinite(runtime.residualPerpetualQuantity)
    || typeof runtime.message !== "string"
    || runtime.message.length > 500
    || !safeTimestamp(runtime.updatedAt)
  ) throw invalidRuntime();

  if (runtime.authoritativeSnapshot !== null) validateRuntimeSnapshot(runtime.authoritativeSnapshot);
  if (runtime.phase === "recovery_required" && runtime.authoritativeSnapshot !== null) throw invalidRuntime();
  if (
    !["recovery_required", "paused", "manual_intervention"].includes(String(runtime.phase))
    && runtime.authoritativeSnapshot === null
  ) throw invalidRuntime();
  if (runtime.phase === "exited") {
    if (runtime.exitCompletedAt === null || runtime.residualPerpetualQuantity !== 0) throw invalidRuntime();
  } else if (runtime.exitCompletedAt !== null) throw invalidRuntime();

  if (runtime.plannedMutation !== null) validateRuntimeMutation(runtime.plannedMutation);
  runtime.acceptedOrders.forEach((value) => {
    const order = exactObject(value, ["category", "orderId", "orderLinkId"]);
    if (
      !["spot", "linear"].includes(String(order.category))
      || !nonEmptyString(order.orderId)
      || !nonEmptyString(order.orderLinkId)
    ) throw invalidRuntime();
  });
  runtime.providerResults.forEach(validateProviderOrder);
  runtime.cancelledOrders.forEach((value) => {
    const order = exactObject(value, ["category", "orderId", "symbol"]);
    if (
      !["spot", "linear"].includes(String(order.category))
      || !nonEmptyString(order.orderId)
      || order.symbol !== (
        order.category === "spot" ? profile.venue.spotSymbol : profile.venue.perpetualSymbol
      )
    ) throw invalidRuntime();
  });
  runtime.fundingSettlements.forEach(validateFundingSettlement);
  const settlementKeys = runtime.fundingSettlements.map((item) => item.cycleId);
  if (
    new Set(settlementKeys).size !== settlementKeys.length
    || runtime.fundingSettlements.some((item, index) =>
      index > 0 && item.settledAt < runtime.fundingSettlements[index - 1]!.settledAt)
  ) throw invalidRuntime();
  return runtime as unknown as RwaAssetTakeoverRuntimeState;
}

export function publicRwaAssetTakeoverRuntime(runtime: RwaAssetTakeoverRuntimeState | null) {
  if (!runtime) return null;
  const {
    authoritativeSnapshot,
    plannedMutation: _plannedMutation,
    acceptedOrders,
    providerResults,
    cancelledOrders,
    fundingSettlements,
    fundingCheckpointAt: _fundingCheckpointAt,
    exitIdempotencyKey: _exitIdempotencyKey,
    mutationSequence: _mutationSequence,
    ...safe
  } = runtime;
  const publicSnapshot = authoritativeSnapshot === null
    ? null
    : (({
      ordersDigest: _ordersDigest,
      providerStateDigest: _providerStateDigest,
      ...snapshot
    }) => snapshot)(authoritativeSnapshot);
  return {
    ...safe,
    authoritativeSnapshot: publicSnapshot,
    acceptedOrderCount: acceptedOrders.length,
    providerResultCount: providerResults.length,
    cancelledOrderCount: cancelledOrders.length,
    fundingSettlementCount: fundingSettlements.length,
    lastFundingSettlementAt: fundingSettlements.at(-1)?.settledAt ?? null,
  };
}

function validateRuntimeSnapshot(value: unknown): asserts value is RwaAssetTakeoverRuntimeSnapshot {
  const snapshot = exactObject(value, snapshotKeys);
  if (
    !safeTimestamp(snapshot.capturedAt)
    || !hex(snapshot.ordersDigest, 64)
    || !hex(snapshot.providerStateDigest, 64)
    || !nonNegativeFinite(snapshot.spotQuantity)
    || !nonNegativeFinite(snapshot.spotAvailableQuantity)
    || !nonNegativeFinite(snapshot.spotLockedQuantity)
    || !positiveFinite(snapshot.spotBid)
    || !nonNegativeFinite(snapshot.perpetualQuantity)
    || !["short", "flat"].includes(String(snapshot.perpetualSide))
    || !positiveFinite(snapshot.perpetualAsk)
    || !positiveFinite(snapshot.perpetualMark)
    || !Number.isFinite(snapshot.currentFundingRate)
    || !(snapshot.liquidationDistancePercent === null
      || nonNegativeFinite(snapshot.liquidationDistancePercent))
    || !nonNegativeFinite(snapshot.reserveUsd)
    || !nonNegativeFinite(snapshot.managedCapitalUsd)
    || snapshot.spotAvailableQuantity + snapshot.spotLockedQuantity + 1e-9 < snapshot.spotQuantity
    || (snapshot.perpetualSide === "flat" && snapshot.perpetualQuantity !== 0)
    || (snapshot.perpetualSide === "short" && snapshot.perpetualQuantity <= 0)
  ) throw invalidRuntime();
}

function validateRuntimeMutation(value: unknown) {
  const mutation = value as Record<string, unknown>;
  if (mutation.kind === "cancel") {
    const cancel = exactObject(mutation, ["category", "kind", "orderId"]);
    if (!["spot", "linear"].includes(String(cancel.category)) || !nonEmptyString(cancel.orderId)) {
      throw invalidRuntime();
    }
    return;
  }
  const place = exactObject(mutation, [
    "attempt", "category", "kind", "limitPrice", "orderLinkId", "quantityBase",
    "reduceOnly", "slippageBps",
  ]);
  if (
    place.kind !== "place"
    || !["spot", "linear"].includes(String(place.category))
    || !nonEmptyString(place.orderLinkId)
    || !positiveFinite(place.quantityBase)
    || !positiveFinite(place.limitPrice)
    || typeof place.reduceOnly !== "boolean"
    || ![15, 30, 50].includes(Number(place.slippageBps))
    || !safeIntegerInRange(place.attempt, 1, 3)
    || (place.category === "spot" && place.reduceOnly)
    || (place.category === "linear" && !place.reduceOnly)
  ) throw invalidRuntime();
}

function validateFundingSettlement(value: unknown) {
  const settlement = exactObject(value, settlementKeys);
  if (
    !nonEmptyString(settlement.cycleId)
    || String(settlement.cycleId).length > 160
    || !nonEmptyString(settlement.settlementId)
    || String(settlement.settlementId).length > 160
    || !safeTimestamp(settlement.settledAt)
    || !Number.isFinite(settlement.netFundingUsd)
    || !(settlement.fundingRate === null || Number.isFinite(settlement.fundingRate))
  ) throw invalidRuntime();
}

function validateProviderOrder(value: unknown) {
  const order = exactObject(value, providerOrderKeys);
  if (
    !nonEmptyString(order.orderId)
    || !nonEmptyString(order.orderLinkId)
    || !["New", "PartiallyFilled", "Filled", "Cancelled", "Rejected", "Unknown"]
      .includes(String(order.status))
    || !nonNegativeFinite(order.requestedQuantityXaut)
    || !nonNegativeFinite(order.filledQuantityXaut)
    || !(order.positionQuantityXaut === undefined
      || nonNegativeFinite(order.positionQuantityXaut))
    || !(order.averagePrice === null || positiveFinite(order.averagePrice))
    || !nonNegativeFinite(order.feeUsd)
    || !safeTimestamp(order.updatedAt)
  ) throw invalidRuntime();
}

function exactObject(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRuntime();
  const object = value as Record<string, any>;
  if (Object.keys(object).sort().join(",") !== [...keys].sort().join(",")) throw invalidRuntime();
  return object;
}

function invalidRuntime(): never {
  throw new Error("asset_takeover_runtime_state_invalid");
}

function runtimeDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hex(value: unknown, length: number) {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableTimestamp(value: unknown) {
  return value === null || safeTimestamp(value);
}

function safeIntegerInRange(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const runtimePhases: RwaAssetTakeoverRuntimePhase[] = [
  "recovery_required", "monitoring", "paused", "reducing", "exiting",
  "manual_intervention", "exited",
];
const runtimeReasons: RwaAssetTakeoverRuntimeReason[] = [
  null, "user_exit", "user_kill_switch", "server_kill_switch", "liquidation_distance",
  "funding_unfavorable", "account_changed", "external_position_change",
  "provider_read_failure", "persistent_state_invalid",
];
const runtimeKeys = [
  "acceptedOrders", "authoritativeSnapshot", "cancelledOrders", "consecutiveReadFailures",
  "exitCompletedAt", "exitIdempotencyKey", "exitStartedAt", "firstReadFailureAt", "fundingCheckpointAt",
  "fundingSettlements", "lastSuccessfulCheckAt", "message", "mutationSequence", "phase", "plannedMutation",
  "providerResults", "reason", "residualPerpetualQuantity", "residualSpotQuantity",
  "schemaVersion", "unfavorableFundingStreak", "updatedAt",
] as const;
const snapshotKeys = [
  "capturedAt", "currentFundingRate", "liquidationDistancePercent", "managedCapitalUsd",
  "ordersDigest", "perpetualAsk", "perpetualMark", "perpetualQuantity", "perpetualSide",
  "providerStateDigest", "reserveUsd",
  "spotAvailableQuantity", "spotBid", "spotLockedQuantity", "spotQuantity",
] as const;
const settlementKeys = ["cycleId", "fundingRate", "netFundingUsd", "settledAt", "settlementId"] as const;
const providerOrderKeys = [
  "averagePrice", "feeUsd", "filledQuantityXaut", "orderId", "orderLinkId",
  "positionQuantityXaut", "requestedQuantityXaut", "status", "updatedAt",
] as const;
const exitPreviewKeys = [
  "assetId", "authorizationCreatedAt", "authorizationId", "emergencySlippageBps",
  "expiresAt", "generatedAt", "normalSlippageBps", "ordersDigest", "perpetualQuantity",
  "perpetualSide", "previewDigest", "previewId", "profileId", "spotAvailableQuantity",
  "spotLockedQuantity", "spotQuantity", "takeoverId", "venue",
] as const;
