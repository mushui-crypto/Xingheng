import { createHash, randomBytes } from "node:crypto";
import type {
  RwaBinancePreflightSnapshot,
} from "./RwaBinanceAutomationTypes";
import type { RwaProviderOrder } from "./RwaNeutralExecutionTypes";

export const RWA_CONNECTIVITY_SMOKE_BUDGET_USD = 25;
export const RWA_CONNECTIVITY_SMOKE_PURPOSE = "connectivity_smoke" as const;
export const RWA_CONNECTIVITY_SMOKE_MODE = "connectivity_smoke" as const;
export const RWA_CONNECTIVITY_SMOKE_MAX_RECORDS = 100;
export const RWA_CONNECTIVITY_SMOKE_POLICY_VERSION = "connectivity-smoke-non-atomic-v1" as const;
export const RWA_CONNECTIVITY_SMOKE_SLIPPAGE_FLOOR_BPS = 10;
export const RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS = Object.freeze({
  spotOpen: Object.freeze({ suffix: "s1", category: "spot", side: "Buy", reduceOnly: false }),
  futuresOpen: Object.freeze({ suffix: "p1", category: "linear", side: "Sell", reduceOnly: false }),
  futuresClose: Object.freeze({ suffix: "c1", category: "linear", side: "Buy", reduceOnly: true }),
  spotClose: Object.freeze({ suffix: "c2", category: "spot", side: "Sell", reduceOnly: false }),
} as const);
export const RWA_CONNECTIVITY_SMOKE_POLICY = deepFreeze({
  version: RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
  venue: "binance",
  symbol: "XAUTUSDT",
  maxPlannedCapitalUsd: 25,
  dedicatedBlankSubaccount: true,
  singleExecution: true,
  immediateExit: true,
  challengeTtlMs: 60_000,
  continuity: "non_atomic_incomplete",
  requiredConfirmations: [
    "exclusive_window",
    "manual_recovery",
    "non_atomic_risk",
  ],
  exclusiveWindowRules: [
    {
      code: "dedicated_blank_subaccount",
      message: "必须使用专用空白 Binance 子账户，开始时 XAUT 余额、仓位和活动订单均为零。",
    },
    {
      code: "single_execution_immediate_exit",
      message: "仅授权一次 connectivity smoke，并在建仓后立即退出；总计划资本不超过 25 USDT。",
    },
    {
      code: "no_other_xaut_activity",
      message: "窗口内不得通过 Binance UI、其他 API Key、转账或其他系统操作 XAUT。",
    },
  ],
  manualRecoveryRequirements: [
    {
      code: "manual_cancel_capability",
      message: "用户必须具备在 Binance 人工识别并撤销 smoke 相关活动订单的能力。",
    },
    {
      code: "manual_close_capability",
      message: "用户必须具备在自动恢复停止后人工平 Futures 并卖出归属 Spot 的能力。",
    },
  ],
  residualRisks: [
    {
      code: "scan_cutoff_to_mutation_race",
      message: "REST 扫描截止点到 provider mutation 之间存在非原子竞态窗口。",
    },
    {
      code: "rest_history_visibility_delay",
      message: "Binance 历史订单、成交或划转接口可能延迟显示活动。",
    },
    {
      code: "same_net_round_trip_may_not_be_detected",
      message: "人工同净额往返若未在 REST 历史中及时可见，系统可能无法识别。",
    },
    {
      code: "asset_fungibility_prevents_mathematical_ownership_proof",
      message: "XAUT 可替代性使经济归属无法由余额变化获得数学证明。",
    },
    {
      code: "budget_is_not_a_maximum_loss_guarantee",
      message: "25 USDT 是总计划资本硬预算，不是最大损失保证。",
    },
  ],
} as const);
export const RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST = createHash("sha256")
  .update(JSON.stringify(RWA_CONNECTIVITY_SMOKE_POLICY))
  .digest("base64url");

export type RwaConnectivitySmokePolicyDiscovery = {
  mode: typeof RWA_CONNECTIVITY_SMOKE_MODE;
  venue: "binance";
  accountId: string;
  executionAuthorized: false;
  message: string;
  policy: typeof RWA_CONNECTIVITY_SMOKE_POLICY & {
    digest: typeof RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST;
  };
};

export function connectivitySmokePolicyDiscovery(
  accountId: string,
): RwaConnectivitySmokePolicyDiscovery {
  return {
    mode: RWA_CONNECTIVITY_SMOKE_MODE,
    venue: "binance",
    accountId,
    executionAuthorized: false,
    message: "此响应仅用于展示并确认当前服务端 policy，不表示 preflight 通过、执行开关开启或真实窗口已授权。",
    policy: {
      ...RWA_CONNECTIVITY_SMOKE_POLICY,
      digest: RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export type RwaConnectivitySmokePolicyAcceptance = {
  version: typeof RWA_CONNECTIVITY_SMOKE_POLICY_VERSION;
  digest: typeof RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST;
  exclusiveWindowConfirmed: true;
  manualRecoveryConfirmed: true;
  nonAtomicRiskAccepted: true;
};

export type RwaConnectivitySmokeStage =
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

export type RwaConnectivitySmokeBudget = {
  limitUsd: typeof RWA_CONNECTIVITY_SMOKE_BUDGET_USD;
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

export type RwaConnectivitySmokeExitProgress = {
  futuresCloseOrder: RwaProviderOrder | null;
  spotCloseOrder: RwaProviderOrder | null;
  futuresFlatConfirmed: boolean;
  spotFlatConfirmed: boolean;
};

export type RwaConnectivitySmokeProviderState = {
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

export type RwaConnectivitySmokeTimelineEvent = {
  stage: RwaConnectivitySmokeStage;
  at: number;
  code: string;
};

export const RWA_CONNECTIVITY_SMOKE_TIMELINE_CODE = {
  reserved: "reserved",
  spot_opening: "stage_spot_opening",
  spot_open: "stage_spot_open",
  futures_opening: "stage_futures_opening",
  hedged: "stage_hedged",
  futures_closing: "stage_futures_closing",
  spot_closing: "stage_spot_closing",
  flat: "stage_flat",
  failed: "stage_failed",
  manual_intervention: "stage_manual_intervention",
} as const satisfies Record<RwaConnectivitySmokeStage, string>;

const RWA_CONNECTIVITY_SMOKE_TRANSITIONS: Readonly<Record<RwaConnectivitySmokeStage, readonly RwaConnectivitySmokeStage[]>> = {
  reserved: ["spot_opening", "failed", "manual_intervention"],
  spot_opening: ["spot_open", "spot_closing", "flat", "failed", "manual_intervention"],
  spot_open: ["futures_opening", "spot_closing", "failed", "manual_intervention"],
  futures_opening: ["hedged", "futures_closing", "spot_closing", "flat", "failed", "manual_intervention"],
  hedged: ["futures_closing", "spot_closing", "flat", "failed", "manual_intervention"],
  futures_closing: ["spot_closing", "flat", "failed", "manual_intervention"],
  spot_closing: ["flat", "failed", "manual_intervention"],
  flat: [],
  failed: [],
  manual_intervention: [],
};

export function appendConnectivitySmokeTimeline(smoke: RwaConnectivitySmokeRecord, at: number) {
  const last = smoke.timeline.at(-1);
  if (last?.stage === smoke.stage) return;
  if (last && !isConnectivitySmokeTransitionAllowed(last.stage, smoke.stage)) {
    throw new Error("connectivity smoke timeline transition is invalid");
  }
  smoke.timeline.push({
    stage: smoke.stage,
    at,
    code: RWA_CONNECTIVITY_SMOKE_TIMELINE_CODE[smoke.stage],
  });
}

export function validateConnectivitySmokeTimeline(smoke: RwaConnectivitySmokeRecord) {
  const timeline = smoke.timeline;
  if (!Array.isArray(timeline) || timeline.length === 0 || timeline.length > 64) {
    throw new Error("connectivity smoke timeline is invalid");
  }
  let previousAt = -Infinity;
  for (let index = 0; index < timeline.length; index += 1) {
    const event = timeline[index]!;
    if (!event || typeof event !== "object" || Array.isArray(event)
      || !hasExactKeys(event, ["at", "code", "stage"])
      || !isConnectivitySmokeStage(event.stage)
      || !Number.isFinite(event.at) || event.at < 0 || event.at < previousAt) {
      throw new Error("connectivity smoke timeline event is invalid");
    }
    const isLegacyReserved = index === 0 && event.stage === "reserved"
      && event.code === "legacy_migration_reserved";
    const isLegacyCurrent = index === 1
      && timeline[0]?.code === "legacy_migration_reserved"
      && event.code === "legacy_migration_current_stage";
    if (
      (!isLegacyReserved && !isLegacyCurrent
        && event.code !== RWA_CONNECTIVITY_SMOKE_TIMELINE_CODE[event.stage])
      || (index === 0 && event.stage !== "reserved")
      || (index > 0 && timeline[index - 1]!.stage === event.stage)
      || (index > 0 && !isLegacyCurrent
        && !isConnectivitySmokeTransitionAllowed(timeline[index - 1]!.stage, event.stage))
    ) {
      throw new Error("connectivity smoke timeline transition is invalid");
    }
    previousAt = event.at;
  }
  if (timeline.at(-1)?.stage !== smoke.stage) {
    throw new Error("connectivity smoke timeline does not match record stage");
  }
  if (timeline[0]!.at < smoke.createdAt || timeline.at(-1)!.at > smoke.updatedAt) {
    throw new Error("connectivity smoke timeline is outside the record lifetime");
  }
}

export type RwaConnectivitySmokeReceipt = {
  receiptId: string;
  smokeId: string;
  purpose: typeof RWA_CONNECTIVITY_SMOKE_PURPOSE;
  venue: "binance";
  symbol: "XAUTUSDT";
  accountFingerprint: string;
  policyVersion: typeof RWA_CONNECTIVITY_SMOKE_POLICY_VERSION;
  policyDigest: string;
  budget: RwaConnectivitySmokeBudget;
  openedSpotQuantityXaut: number;
  openedFuturesQuantityXaut: number;
  finalSpotQuantityXaut: number;
  finalFuturesQuantityXaut: number;
  providerFlatConfirmed: boolean;
  completedAt: number;
};

export type RwaConnectivitySmokeRecord = {
  smokeId: string;
  userId: string;
  accountId: string;
  accountFingerprint: string;
  purpose: typeof RWA_CONNECTIVITY_SMOKE_PURPOSE;
  mode: typeof RWA_CONNECTIVITY_SMOKE_MODE;
  idempotencyKey: string;
  challengeId: string;
  requestDigest: string;
  policyVersion: typeof RWA_CONNECTIVITY_SMOKE_POLICY_VERSION;
  policyDigest: string;
  orderLinkPrefix: string;
  stage: RwaConnectivitySmokeStage;
  budget: RwaConnectivitySmokeBudget;
  authorization: {
    operation: "connectivity_smoke_execute";
    consumedBeforeProviderMutation: true;
    exitAuthorized: true;
    reservedAt: number;
  };
  spotOpenOrder: RwaProviderOrder | null;
  futuresOpenOrder: RwaProviderOrder | null;
  openedSpotQuantityXaut: number;
  openedFuturesQuantityXaut: number;
  exit: RwaConnectivitySmokeExitProgress;
  providerState: RwaConnectivitySmokeProviderState;
  timeline: RwaConnectivitySmokeTimelineEvent[];
  receipt: RwaConnectivitySmokeReceipt | null;
  noReopen: true;
  providerMutationCount: number;
  errorCategory: string | null;
  message: string;
  createdAt: number;
  updatedAt: number;
};

const CONNECTIVITY_SMOKE_RECORD_KEYS = [
  "accountFingerprint", "accountId", "authorization", "budget", "challengeId", "createdAt",
  "errorCategory", "exit", "futuresOpenOrder", "idempotencyKey", "message", "mode", "noReopen",
  "openedFuturesQuantityXaut", "openedSpotQuantityXaut", "orderLinkPrefix", "policyDigest",
  "policyVersion", "providerMutationCount", "providerState", "purpose", "receipt", "requestDigest",
  "smokeId", "spotOpenOrder", "stage", "timeline", "updatedAt", "userId",
] as const;

const LEGACY_CONNECTIVITY_SMOKE_RECORD_KEYS = CONNECTIVITY_SMOKE_RECORD_KEYS
  .filter((key) => key !== "providerState" && key !== "timeline");

export function migrateLegacyConnectivitySmokeRecord(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const hasProviderState = Object.hasOwn(record, "providerState");
  const hasTimeline = Object.hasOwn(record, "timeline");
  if (hasProviderState || hasTimeline) return value;
  if (!hasExactKeys(record, LEGACY_CONNECTIVITY_SMOKE_RECORD_KEYS)
    || !isConnectivitySmokeStage(record.stage)
    || !Number.isFinite(record.createdAt) || Number(record.createdAt) < 0
    || !Number.isFinite(record.updatedAt) || Number(record.updatedAt) < Number(record.createdAt)) {
    return value;
  }
  const stage = record.stage;
  const createdAt = Number(record.createdAt);
  const updatedAt = Number(record.updatedAt);
  const timeline: RwaConnectivitySmokeTimelineEvent[] = [{
    stage: "reserved",
    at: createdAt,
    code: "legacy_migration_reserved",
  }];
  if (stage !== "reserved") {
    timeline.push({
      stage,
      at: updatedAt,
      code: "legacy_migration_current_stage",
    });
  }
  return {
    ...record,
    providerState: {
      verificationStatus: "unavailable",
      observedAt: null,
      residualSpotQuantityXaut: null,
      residualFuturesQuantityXaut: null,
      activeSpotOrderCount: null,
      activeFuturesOrderCount: null,
      activeTotalOrderCount: null,
      providerFlatConfirmed: null,
      reason: "legacy_provider_state_unavailable",
    },
    timeline,
    // A parent-version receipt did not persist the authoritative snapshot needed by the new contract.
    receipt: null,
  } satisfies Partial<RwaConnectivitySmokeRecord>;
}

export function validateConnectivitySmokeFacts(smoke: RwaConnectivitySmokeRecord) {
  validateConnectivitySmokeOrder(
    smoke.spotOpenOrder,
    smoke.orderLinkPrefix,
    RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS.spotOpen.suffix,
  );
  validateConnectivitySmokeOrder(
    smoke.futuresOpenOrder,
    smoke.orderLinkPrefix,
    RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS.futuresOpen.suffix,
  );
  validateConnectivitySmokeOrder(
    smoke.exit.futuresCloseOrder,
    smoke.orderLinkPrefix,
    RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS.futuresClose.suffix,
  );
  validateConnectivitySmokeOrder(
    smoke.exit.spotCloseOrder,
    smoke.orderLinkPrefix,
    RWA_CONNECTIVITY_SMOKE_ORDER_SLOTS.spotClose.suffix,
  );
  if (
    (smoke.spotOpenOrder !== null
      && smoke.openedSpotQuantityXaut !== smokeOrderPositionQuantity(smoke.spotOpenOrder))
    || (smoke.futuresOpenOrder !== null
      && smoke.openedFuturesQuantityXaut !== smokeOrderPositionQuantity(smoke.futuresOpenOrder))
    || (["spot_open", "futures_opening", "hedged", "futures_closing", "spot_closing"].includes(smoke.stage)
      && smoke.spotOpenOrder === null)
    || (["hedged", "futures_closing"].includes(smoke.stage) && smoke.futuresOpenOrder === null)
  ) {
    throw new Error("connectivity smoke order slots do not match the stage ledger");
  }
  validateConnectivitySmokeTimeline(smoke);
  validateProviderStateFacts(smoke.providerState);
  if (smoke.receipt === null) return;
  const receipt = smoke.receipt;
  const lastEvent = smoke.timeline.at(-1)!;
  if (
    smoke.stage !== "flat"
    || smoke.exit.futuresFlatConfirmed !== true
    || smoke.exit.spotFlatConfirmed !== true
    || smoke.providerState.verificationStatus !== "verified"
    || smoke.providerState.residualSpotQuantityXaut !== 0
    || smoke.providerState.residualFuturesQuantityXaut !== 0
    || smoke.providerState.activeSpotOrderCount !== 0
    || smoke.providerState.activeFuturesOrderCount !== 0
    || smoke.providerState.activeTotalOrderCount !== 0
    || smoke.providerState.providerFlatConfirmed !== true
    || receipt.receiptId.length === 0
    || receipt.smokeId !== smoke.smokeId
    || receipt.purpose !== smoke.purpose
    || receipt.venue !== "binance"
    || receipt.symbol !== "XAUTUSDT"
    || receipt.accountFingerprint !== smoke.accountFingerprint
    || receipt.policyVersion !== smoke.policyVersion
    || receipt.policyDigest !== smoke.policyDigest
    || !sameJson(receipt.budget, smoke.budget)
    || receipt.openedSpotQuantityXaut !== smoke.openedSpotQuantityXaut
    || receipt.openedFuturesQuantityXaut !== smoke.openedFuturesQuantityXaut
    || receipt.finalSpotQuantityXaut !== 0
    || receipt.finalFuturesQuantityXaut !== 0
    || receipt.providerFlatConfirmed !== true
    || (smoke.openedSpotQuantityXaut > 0 && smoke.exit.spotCloseOrder === null)
    || (smoke.openedFuturesQuantityXaut > 0 && smoke.exit.futuresCloseOrder === null)
    || !Number.isFinite(receipt.completedAt)
    || receipt.completedAt < lastEvent.at
  ) {
    throw new Error("connectivity smoke receipt facts are inconsistent");
  }
}

function smokeOrderPositionQuantity(order: RwaProviderOrder) {
  return order.positionQuantityXaut ?? order.filledQuantityXaut;
}

function validateConnectivitySmokeOrder(
  order: RwaProviderOrder | null,
  prefix: string,
  suffix: "s1" | "p1" | "c1" | "c2",
) {
  if (order === null) return;
  if (!order || typeof order !== "object" || Array.isArray(order)
    || !hasExactKeys(order, [
      "averagePrice", "feeUsd", "filledQuantityXaut", "orderId", "orderLinkId",
      "positionQuantityXaut", "requestedQuantityXaut", "status", "updatedAt",
    ], true)
    || typeof order.orderId !== "string" || order.orderId.length === 0
    || order.orderLinkId !== `${prefix}${suffix}`
    || !["New", "PartiallyFilled", "Filled", "Cancelled", "Rejected", "Unknown"].includes(order.status)
    || !finiteNonNegative(order.requestedQuantityXaut)
    || !finiteNonNegative(order.filledQuantityXaut)
    || order.filledQuantityXaut > order.requestedQuantityXaut + 1e-12
    || !(order.positionQuantityXaut === undefined || (
      finiteNonNegative(order.positionQuantityXaut)
      && order.positionQuantityXaut <= order.requestedQuantityXaut + 1e-12
    ))
    || !(order.averagePrice === null || finiteNonNegative(order.averagePrice))
    || !finiteNonNegative(order.feeUsd)
    || !Number.isFinite(order.updatedAt) || order.updatedAt < 0) {
    throw new Error("connectivity smoke order facts are invalid");
  }
}

function validateProviderStateFacts(state: RwaConnectivitySmokeProviderState) {
  const quantities = [
    state.residualSpotQuantityXaut,
    state.residualFuturesQuantityXaut,
    state.activeSpotOrderCount,
    state.activeFuturesOrderCount,
    state.activeTotalOrderCount,
  ];
  if (
    !["verified", "stale", "unavailable", "ambiguous"].includes(state.verificationStatus)
    || !(state.observedAt === null || (Number.isFinite(state.observedAt) && state.observedAt >= 0))
    || quantities.some((value) => !(value === null || finiteNonNegative(value)))
    || [state.activeSpotOrderCount, state.activeFuturesOrderCount, state.activeTotalOrderCount]
      .some((value) => value !== null && !Number.isInteger(value))
    || typeof state.reason !== "string" || state.reason.length === 0
    || (state.activeSpotOrderCount !== null
      && state.activeFuturesOrderCount !== null
      && state.activeTotalOrderCount !== state.activeSpotOrderCount + state.activeFuturesOrderCount)
    || (state.verificationStatus !== "verified" && state.providerFlatConfirmed !== null)
    || (state.providerFlatConfirmed === true && (
      state.residualSpotQuantityXaut !== 0
      || state.residualFuturesQuantityXaut !== 0
      || state.activeTotalOrderCount !== 0
    ))
  ) {
    throw new Error("connectivity smoke provider state facts are invalid");
  }
}

function isConnectivitySmokeTransitionAllowed(
  from: RwaConnectivitySmokeStage,
  to: RwaConnectivitySmokeStage,
) {
  return RWA_CONNECTIVITY_SMOKE_TRANSITIONS[from].includes(to);
}

function isConnectivitySmokeStage(value: unknown): value is RwaConnectivitySmokeStage {
  return typeof value === "string" && Object.hasOwn(RWA_CONNECTIVITY_SMOKE_TIMELINE_CODE, value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasExactKeys(
  value: object,
  expected: readonly string[],
  optionalPositionQuantity = false,
) {
  const actual = Object.keys(value).sort();
  const required = optionalPositionQuantity && !Object.hasOwn(value, "positionQuantityXaut")
    ? expected.filter((key) => key !== "positionQuantityXaut")
    : expected;
  return actual.length === required.length
    && actual.every((key, index) => key === [...required].sort()[index]);
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type RwaConnectivitySmokeChallengeReport = {
  purpose: typeof RWA_CONNECTIVITY_SMOKE_PURPOSE;
  mode: typeof RWA_CONNECTIVITY_SMOKE_MODE;
  venue: "binance";
  network: "binance_mainnet";
  accountId: string;
  accountFingerprint: string;
  symbol: "XAUTUSDT";
  policy: {
    version: typeof RWA_CONNECTIVITY_SMOKE_POLICY_VERSION;
    digest: string;
    accepted: true;
    continuity: "nonAtomic/incomplete";
  };
  budget: RwaConnectivitySmokeBudget;
  checks: Array<{ name: string; passed: boolean; message: string }>;
  passed: boolean;
  generatedAt: number;
  expiresAt: number;
};

export function calculateConnectivitySmokeBudget(
  snapshot: RwaBinancePreflightSnapshot,
  maxCombinedSlippageBps: number,
): RwaConnectivitySmokeBudget {
  const commonQtyStep = commonDecimalStep(snapshot.spot.qtyStep, snapshot.perpetual.qtyStep);
  const minQuantity = ceilStep(
    Math.max(
      snapshot.spot.minOrderQty,
      snapshot.perpetual.minOrderQty,
      snapshot.spot.minNotionalUsd / snapshot.spot.ask,
      snapshot.perpetual.minNotionalUsd / snapshot.perpetual.bid,
    ),
    commonQtyStep,
  );
  const slippageBpsPerAction = Math.max(
    RWA_CONNECTIVITY_SMOKE_SLIPPAGE_FLOOR_BPS,
    maxCombinedSlippageBps,
  );
  const slippageRate = slippageBpsPerAction / 10_000;
  const spotFeeRate = snapshot.fees.spotTakerBps / 10_000;
  const futuresFeeRate = snapshot.fees.perpetualTakerBps / 10_000;
  const prices = {
    spotOpenLimit: ceilPrice(snapshot.spot.ask * (1 + slippageRate), snapshot.spot.priceTick),
    futuresOpenLimit: floorPrice(snapshot.perpetual.bid * (1 - slippageRate), snapshot.perpetual.priceTick),
    futuresCloseLimit: ceilPrice(snapshot.perpetual.ask * (1 + slippageRate), snapshot.perpetual.priceTick),
    spotCloseLimit: floorPrice(snapshot.spot.bid * (1 - slippageRate), snapshot.spot.priceTick),
  };
  const perUnit = prices.spotOpenLimit * (1 + 2 * spotFeeRate)
    + prices.futuresCloseLimit * (1 + 2 * futuresFeeRate)
    + (prices.spotOpenLimit + prices.spotCloseLimit + prices.futuresOpenLimit + prices.futuresCloseLimit)
      * slippageRate;
  const maxQuantity = floorStep(RWA_CONNECTIVITY_SMOKE_BUDGET_USD / perUnit, commonQtyStep);
  const quantityXaut = maxQuantity >= minQuantity ? minQuantity : 0;
  const spotNotionalUsd = quantityXaut * prices.spotOpenLimit;
  const futuresMarginUsd = quantityXaut * prices.futuresCloseLimit;
  const spotFeesUsd = spotNotionalUsd * spotFeeRate * 2;
  const futuresFeesUsd = futuresMarginUsd * futuresFeeRate * 2;
  const spotSlippageReserveUsd = quantityXaut
    * (prices.spotOpenLimit + prices.spotCloseLimit) * slippageRate;
  const futuresSlippageReserveUsd = quantityXaut
    * (prices.futuresOpenLimit + prices.futuresCloseLimit) * slippageRate;
  const subtotal = spotNotionalUsd + futuresMarginUsd + spotFeesUsd + futuresFeesUsd
    + spotSlippageReserveUsd + futuresSlippageReserveUsd;
  const roundingReserveUsd = quantityXaut > 0
    ? Math.max(0, Math.min(RWA_CONNECTIVITY_SMOKE_BUDGET_USD - subtotal, commonQtyStep * Math.max(snapshot.spot.ask, snapshot.perpetual.bid)))
    : 0;
  return {
    limitUsd: RWA_CONNECTIVITY_SMOKE_BUDGET_USD,
    quantityXaut,
    commonQtyStep,
    slippageBpsPerAction,
    prices,
    spotNotionalUsd,
    futuresMarginUsd,
    spotFeesUsd,
    futuresFeesUsd,
    spotSlippageReserveUsd,
    futuresSlippageReserveUsd,
    roundingReserveUsd,
    totalCapitalUsd: subtotal + roundingReserveUsd,
  };
}

export function assertConnectivitySmokePolicyAcceptance(
  value: unknown,
): asserts value is RwaConnectivitySmokePolicyAcceptance {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (
    Object.keys(input).sort().join(",") !== [
      "digest", "exclusiveWindowConfirmed", "manualRecoveryConfirmed",
      "nonAtomicRiskAccepted", "version",
    ].sort().join(",")
    || input.version !== RWA_CONNECTIVITY_SMOKE_POLICY_VERSION
    || input.digest !== RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST
    || input.exclusiveWindowConfirmed !== true
    || input.manualRecoveryConfirmed !== true
    || input.nonAtomicRiskAccepted !== true
  ) throw new Error("connectivity smoke policy acceptance invalid");
}

export function newSmokeOrderPrefix(userDomain: string) {
  return `rwacs${userDomain}${randomBytes(4).toString("hex")}`.slice(0, 28);
}

export function isActiveConnectivitySmoke(record: RwaConnectivitySmokeRecord) {
  return !["flat", "failed", "manual_intervention"].includes(record.stage);
}

function commonDecimalStep(left: number, right: number) {
  const scale = 10 ** Math.max(decimalPlaces(left), decimalPlaces(right));
  const a = Math.round(left * scale);
  const b = Math.round(right * scale);
  return lcm(a, b) / scale;
}

function decimalPlaces(value: number) {
  const text = value.toFixed(12).replace(/0+$/, "");
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

function gcd(left: number, right: number): number {
  return right === 0 ? Math.abs(left) : gcd(right, left % right);
}

function lcm(left: number, right: number) {
  return Math.abs(left * right) / gcd(left, right);
}

function floorStep(value: number, step: number) {
  return Math.floor((value + 1e-12) / step) * step;
}

function ceilStep(value: number, step: number) {
  return Math.ceil((value - 1e-12) / step) * step;
}

function ceilPrice(value: number, tick: number) {
  return Math.ceil((value - 1e-12) / tick) * tick;
}

function floorPrice(value: number, tick: number) {
  return Math.floor((value + 1e-12) / tick) * tick;
}
