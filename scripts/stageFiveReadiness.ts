import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, isAbsolute } from "node:path";
import {
  validateProductionComposeConfig,
  validateReleaseManifest,
  verifyRevisionEvidence,
} from "./deploymentRevision.mjs";
import {
  calculateMinimumCommonBaseQuantity,
} from "../server/modules/arbitrage/automation/RwaAutomationMinimumOrder.ts";
import {
  assessResidual,
} from "../server/modules/arbitrage/automation/RwaNeutralHedgeExecutionEngine.ts";
import {
  RWA_ACTIVITY_MAX_PAGES_PER_SOURCE,
  RWA_PERPETUAL_ACTIVITY_SOURCES,
  RWA_SPOT_ACTIVITY_SOURCES,
  createMonitoredActivityContinuity,
  recordStrategyProviderOrder,
} from "../server/modules/arbitrage/automation/RwaProviderActivityContinuity.ts";
import {
  parseBinanceActivityResponseForReadiness,
  scanBinancePositionAttribution,
} from "../server/modules/arbitrage/automation/RwaProviderActivityScanner.ts";
import {
  validateRwaAutomationBackupEnvelopeForReadiness,
} from "../server/modules/arbitrage/automation/RwaAutomationBackupService.ts";

export const STAGE_FIVE_REAL_WINDOW_MAX_MS = 30 * 60 * 1000;
export const STAGE_FIVE_MINIMUM_OBSERVATION_MS = 10 * 60 * 1000;
export const STAGE_FIVE_MINIMUM_PRIVATE_CHECKS = 3;

const FULL_REVISION = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const XAUT_BINANCE_PROFILE = "xaut:binance-xaut-spot-perp-v1";
const STAGE_FIVE_ACTIVITY_COLLECTOR = "rwa-binance-activity-capture-v1";
const STAGE_FIVE_ACTIVITY_REQUEST_PREFIX = "stage5-";
const REQUIRED_BINANCE_ACTIVITY_SOURCES = Object.freeze(
  [...new Set([...RWA_SPOT_ACTIVITY_SOURCES, ...RWA_PERPETUAL_ACTIVITY_SOURCES])].sort(),
);

export class StageFiveReadinessError extends Error {
  constructor(category, message) {
    super(message);
    this.category = category;
  }
}

const CAPITAL_TEST_GATE_STATUS = Object.freeze({
  p2FreshRwaRollbackReadiness: "INCOMPLETE",
  stsRestoreVerification: "BLOCKED",
  rollbackEvidence: "INCOMPLETE",
  riskAcceptance: "ACTIVE",
  capitalTestPreparation: "READY",
  capitalTestExecution: "BLOCKED_PENDING_AUTHORIZATION",
  providerAccess: "NOT_AUTHORIZED",
  realFunds: "NOT_AUTHORIZED",
});

export function capitalTestGateStatus() {
  return CAPITAL_TEST_GATE_STATUS;
}

export function canonicalStageFiveDigest(value) {
  return canonicalDigest(value);
}

export function validateBackendOperationsPreparation(value) {
  const evidence = exactObject(value, [
    "backendRevision",
    "finalReleaseArtifactsBuilt",
    "productionChanged",
    "productionConnections",
    "providerMutations",
    "realMaterialsRead",
  ], "backend preparation evidence");
  revision(evidence.backendRevision, "backend revision");
  zero(evidence.productionConnections, "production connections");
  zero(evidence.providerMutations, "provider mutations");
  zero(evidence.realMaterialsRead, "real materials read");
  falseValue(evidence.finalReleaseArtifactsBuilt, "final release artifacts");
  falseValue(evidence.productionChanged, "production changed");
  return Object.freeze({
    scope: "backend_operations_preparation",
    revision: evidence.backendRevision,
    overallStageFivePassed: false,
  });
}

export function validateOfflineBackendCoverage(value) {
  const evidence = exactObject(value, [
    "accountAuthorization",
    "backupRestore",
    "binanceProtocolFixtures",
    "bybitProtocolFixtures",
    "crashRecoveryEveryMutationPoint",
    "externalDerisk",
    "fakeProvidersOnly",
    "fundingExit",
    "monitor",
    "otherAssetWrites",
    "providerMutations",
    "reconfirm",
    "takeover",
    "userExit",
  ], "offline backend coverage");
  for (const key of [
    "accountAuthorization",
    "backupRestore",
    "binanceProtocolFixtures",
    "bybitProtocolFixtures",
    "crashRecoveryEveryMutationPoint",
    "externalDerisk",
    "fundingExit",
    "monitor",
    "reconfirm",
    "takeover",
    "userExit",
  ]) trueValue(evidence[key], key);
  trueValue(evidence.fakeProvidersOnly, "fake providers only");
  zero(evidence.otherAssetWrites, "other asset writes");
  zero(evidence.providerMutations, "real provider mutations");
  return Object.freeze({ backendOfflineCoverage: "complete" });
}

export function validateCombinedRevisionForGateOne(value) {
  const evidence = exactObject(value, [
    "backendRevision",
    "developRevision",
    "finalReleaseArtifactsBuilt",
    "frontendMerged",
    "frontendRevision",
    "mainRevision",
    "productionConnected",
    "worktreeClean",
  ], "Gate 1 revision evidence");
  const expected = revision(evidence.backendRevision, "backend revision");
  for (const [field, name] of [
    ["frontendRevision", "frontend revision"],
    ["developRevision", "develop revision"],
    ["mainRevision", "main revision"],
  ]) {
    if (revision(evidence[field], name) !== expected) {
      fail("combined_revision_mismatch", "前后端、develop 与 main 必须处于同一完整 revision。");
    }
  }
  if (evidence.frontendMerged !== true) {
    fail("frontend_not_merged", "前端未合入时只能报告后端/运维准备，不能进入统一发布批准点。");
  }
  trueValue(evidence.worktreeClean, "worktree clean");
  falseValue(evidence.finalReleaseArtifactsBuilt, "final release artifacts");
  falseValue(evidence.productionConnected, "production connected");
  return Object.freeze({ revision: expected, nextStop: "gate_1_external_approval_required" });
}

export function requireGateOneExternalApproval() {
  fail(
    "gate_1_external_approval_required",
    "必须由项目管理在当前现场另行取得统一生产发布批准；脚本不能创建或复用该批准。",
  );
}

export function validatePostApprovalReleaseEvidence(value) {
  const evidence = exactObject(value, [
    "components",
    "composeConfig",
    "manifest",
    "revision",
  ], "post-approval release evidence");
  const expected = revision(evidence.revision, "release revision");
  const manifest = validateReleaseManifest(evidence.manifest);
  if (manifest.revision !== expected) {
    fail("release_revision_mismatch", "release archive 与 manifest revision 不一致。");
  }
  validateProductionComposeConfig(manifest, evidence.composeConfig);
  verifyRevisionEvidence({
    expectedRevision: expected,
    components: evidence.components,
    requireRuntimeEvidence: true,
  });
  return Object.freeze({ revision: expected, releaseEvidence: "verified" });
}

export function validateZeroFundsReadiness(value) {
  const evidence = exactObject(value, [
    "accountFingerprintMatched",
    "accountModeComplete",
    "accountPermissionsComplete",
    "activeOrdersComplete",
    "asset",
    "authorizationCreated",
    "authorizationPreviewGenerated",
    "feesComplete",
    "fundingComplete",
    "instrumentRulesComplete",
    "liquidationDataComplete",
    "monitorReadOnlyGenerated",
    "oneWayIsolatedSupported",
    "privateDataFresh",
    "providerMutations",
    "runtimeSwitches",
    "serverAccountMatched",
    "spotBalanceComplete",
    "takeoverCalculationGenerated",
    "takeoverCreated",
    "venue",
    "withdrawalDisabled",
  ], "zero-funds readiness evidence");
  if (evidence.venue !== "binance" || evidence.asset !== "XAUT") {
    fail("real_window_scope_invalid", "首次真实闭环只允许 Binance XAUT。");
  }
  for (const key of [
    "accountFingerprintMatched",
    "accountModeComplete",
    "accountPermissionsComplete",
    "activeOrdersComplete",
    "authorizationPreviewGenerated",
    "feesComplete",
    "fundingComplete",
    "instrumentRulesComplete",
    "liquidationDataComplete",
    "monitorReadOnlyGenerated",
    "oneWayIsolatedSupported",
    "privateDataFresh",
    "serverAccountMatched",
    "spotBalanceComplete",
    "takeoverCalculationGenerated",
    "withdrawalDisabled",
  ]) trueValue(evidence[key], key);
  falseValue(evidence.authorizationCreated, "authorization created");
  falseValue(evidence.takeoverCreated, "takeover created");
  zero(evidence.providerMutations, "provider mutations");
  validateRuntimeSwitchesDisabled(evidence.runtimeSwitches);
  return Object.freeze({
    zeroFundsReadiness: "verified",
    capitalTestGate: capitalTestGateStatus(),
    nextStop: "gate_2_external_approval_required",
  });
}

export function requireGateTwoExternalApproval() {
  fail(
    "gate_2_external_approval_required",
    "真实资金窗口必须在统一发布和零资金只读验证后另行批准；Gate 1 或历史批准不能复用。",
  );
}

export async function validateRealWindowEvidence(value) {
  const evidence = exactObject(value, [
    "artifacts",
    "exit",
    "gateState",
    "minimumSizing",
    "mutationJournal",
    "observation",
    "restart",
    "scope",
    "windowClosedAt",
    "windowOpenedAt",
  ], "real-window evidence");
  const scope = validateScope(evidence.scope);
  const openedAt = timestamp(evidence.windowOpenedAt, "window openedAt");
  const closedAt = timestamp(evidence.windowClosedAt, "window closedAt");
  if (closedAt < openedAt || closedAt - openedAt > STAGE_FIVE_REAL_WINDOW_MAX_MS) {
    fail("real_window_expired", "真实资金窗口必须在服务器侧 30 分钟内关闭。");
  }
  const sizing = validateMinimumSizing(evidence.minimumSizing, scope, openedAt, closedAt);
  const observation = validateObservation(evidence.observation, scope, openedAt, closedAt);
  const restart = validateRestart(evidence.restart, scope, openedAt, closedAt);
  const mutationJournal = validateMutationJournal(
    evidence.mutationJournal,
    scope,
    openedAt,
    closedAt,
    sizing.currentCapturedAt,
  );
  const exit = await validateExitEvidence(
    evidence.exit,
    scope,
    openedAt,
    closedAt,
    mutationJournal,
  );
  if (
    Math.max(observation.lastPersistedAt, restart.persistedAt, restart.ordersAfterCapturedAt)
      >= exit.startedAt
    || mutationJournal.entries.some((entry) => entry.requestedAt < exit.startedAt)
    || mutationJournal.lastPersistedAt > exit.snapshotCapturedAt
    || exit.snapshotCapturedAt > exit.completedAt
    || exit.completedAt > exit.persistedAt
  ) {
    fail("causal_timeline_invalid", "观察、重启、退出和落盘事件的权威时间链不成立。");
  }
  const gateState = validateGateState(
    evidence.gateState,
    scope,
    openedAt,
    closedAt,
    exit.persistedAt,
  );
  const artifacts = validateArtifacts(
    evidence.artifacts,
    scope,
    openedAt,
    closedAt,
    restart,
    mutationJournal,
    exit,
    gateState,
  );
  return Object.freeze({
    realWindowEvidence: "verified",
    fundingObservationRequiredLater: true,
    scopeDigest: canonicalDigest(scope),
    minimumQuantityBase: sizing.quantity,
    previewMarketDigest: sizing.previewDigest,
    currentMarketDigest: sizing.currentDigest,
    privateSnapshotDigests: Object.freeze(observation.snapshotDigests),
    restartOrdersDigest: restart.ordersDigest,
    spotResidual: Object.freeze(exit.spotResidual),
    artifactDigests: Object.freeze(artifacts),
  });
}

function validateScope(value) {
  const scope = exactObject(value, [
    "accountFingerprint",
    "asset",
    "authorizationId",
    "profileId",
    "revision",
    "takeoverId",
    "userDomain",
    "venue",
    "windowId",
  ], "real-window scope");
  if (
    typeof scope.userDomain !== "string"
    || !/^[a-f0-9]{16}$/u.test(scope.userDomain)
    || typeof scope.accountFingerprint !== "string"
    || !/^[a-f0-9]{16,64}$/u.test(scope.accountFingerprint)
    || scope.venue !== "binance"
    || scope.asset !== "XAUT"
    || scope.profileId !== XAUT_BINANCE_PROFILE
  ) {
    fail("real_window_scope_invalid", "真实窗口 scope 必须绑定一个脱敏 Binance XAUT 账户资产范围。");
  }
  uuid(scope.authorizationId, "authorizationId");
  uuid(scope.takeoverId, "takeoverId");
  uuid(scope.windowId, "windowId");
  revision(scope.revision, "scope revision");
  return Object.freeze({
    userDomain: scope.userDomain,
    accountFingerprint: scope.accountFingerprint,
    authorizationId: scope.authorizationId,
    takeoverId: scope.takeoverId,
    profileId: scope.profileId,
    windowId: scope.windowId,
    revision: scope.revision,
    venue: "binance",
    asset: "XAUT",
  });
}

function validateMinimumSizing(value, scope, openedAt, closedAt) {
  const sizing = exactObject(value, [
    "current",
    "maxManagedCapitalUsd",
    "preview",
    "totalManagedCapitalUsd",
  ], "minimum sizing evidence");
  const preview = validateAuthoritativeMarket(sizing.preview, scope, "preview market");
  const current = validateAuthoritativeMarket(sizing.current, scope, "current market");
  if (
    preview.capturedAt < openedAt
    || current.capturedAt > closedAt
    || current.capturedAt <= preview.capturedAt
  ) {
    fail("minimum_quantity_invalid", "共同最小数量必须由窗口内先后两次权威市场快照独立计算。");
  }
  const previewMinimum = calculateMinimumCommonBaseQuantity(preview);
  const currentMinimum = calculateMinimumCommonBaseQuantity(current);
  if (
    previewMinimum.quantity !== currentMinimum.quantity
    || previewMinimum.commonStep !== currentMinimum.commonStep
  ) {
    fail("minimum_quantity_changed", "下单前规则、价格或共同最小数量变化，必须停止并重新预览。");
  }
  if (
    preview.spot.executableDepthBase + 1e-12 < previewMinimum.quantity
    || preview.perpetual.executableDepthBase + 1e-12 < previewMinimum.quantity
    || current.spot.executableDepthBase + 1e-12 < currentMinimum.quantity
    || current.perpetual.executableDepthBase + 1e-12 < currentMinimum.quantity
  ) {
    fail("minimum_quantity_invalid", "权威盘口深度不足以执行共同最小数量。");
  }
  positiveFinite(sizing.totalManagedCapitalUsd, "total managed capital");
  const currentNotional = Math.max(
    currentMinimum.quantity * current.spot.ask,
    currentMinimum.quantity * current.perpetual.bid,
  );
  if (
    sizing.maxManagedCapitalUsd !== 2_000
    || sizing.totalManagedCapitalUsd > sizing.maxManagedCapitalUsd
    || currentNotional > sizing.totalManagedCapitalUsd
  ) {
    fail("managed_capital_exceeded", "XAUT 当前总管理资金不得超过 profile 冻结的 2000U 上限。");
  }
  return {
    quantity: currentMinimum.quantity,
    currentCapturedAt: current.capturedAt,
    previewDigest: canonicalDigest(preview),
    currentDigest: canonicalDigest(current),
  };
}

function validateAuthoritativeMarket(value, scope, label) {
  const market = exactObject(value, [
    "capturedAt",
    "perpetual",
    "scope",
    "spot",
  ], label);
  assertSameScope(market.scope, scope, label);
  const spot = validateInstrument(market.spot, "spot");
  const perpetual = validateInstrument(market.perpetual, "perpetual");
  return Object.freeze({
    capturedAt: timestamp(market.capturedAt, `${label} capturedAt`),
    scope,
    spot,
    perpetual,
  });
}

function validateInstrument(value, market) {
  const priceKey = market === "spot" ? "ask" : "bid";
  const instrument = exactObject(value, [
    priceKey,
    "executableDepthBase",
    "minNotionalUsd",
    "minOrderQty",
    "priceTick",
    "qtyStep",
    "status",
    "symbol",
  ], `${market} instrument`);
  if (instrument.status !== "Trading" || instrument.symbol !== "XAUTUSDT") {
    fail("minimum_quantity_invalid", "权威产品状态或 symbol 与冻结 profile 不一致。");
  }
  for (const key of [
    priceKey,
    "executableDepthBase",
    "minNotionalUsd",
    "minOrderQty",
    "priceTick",
    "qtyStep",
  ]) positiveFinite(instrument[key], `${market} ${key}`);
  return Object.freeze({ ...instrument });
}

function validateRuntimeSwitchesDisabled(value) {
  const switches = exactObject(value, [
    "allUserKillSwitchesEnabled",
    "executionEnabled",
    "globalEnabled",
    "serverKillSwitchEnabled",
    "strategyEnabled",
  ], "runtime switch evidence");
  trueValue(switches.allUserKillSwitchesEnabled, "all user kill switches");
  trueValue(switches.serverKillSwitchEnabled, "server kill switch");
  falseValue(switches.executionEnabled, "execution enabled");
  falseValue(switches.globalEnabled, "global enabled");
  falseValue(switches.strategyEnabled, "strategy enabled");
}

function validateObservation(value, scope, openedAt, closedAt) {
  const observation = exactObject(value, ["checks"], "observation evidence");
  if (!Array.isArray(observation.checks) || observation.checks.length < STAGE_FIVE_MINIMUM_PRIVATE_CHECKS) {
    fail("private_checks_incomplete", "首次真实闭环必须完成至少三次私有权威核对。");
  }
  const ids = new Set();
  const snapshotDigests = [];
  let previousTime = -1;
  for (const check of observation.checks) {
    const item = exactObject(check, [
      "checkId",
      "checkedAt",
      "persistedAt",
      "scope",
      "snapshot",
    ], "private check");
    assertSameScope(item.scope, scope, "private check");
    if (typeof item.checkId !== "string" || item.checkId.length < 1 || ids.has(item.checkId)) {
      fail("private_checks_incomplete", "私有权威核对 ID 必须唯一。");
    }
    const checkedAt = timestamp(item.checkedAt, "private check time");
    const persistedAt = timestamp(item.persistedAt, "private check persistedAt");
    if (
      checkedAt < openedAt
      || checkedAt > closedAt
      || checkedAt <= previousTime
      || persistedAt < checkedAt
      || persistedAt > closedAt
    ) {
      fail("private_checks_incomplete", "私有权威核对必须在窗口内按权威时间严格递增。");
    }
    const snapshot = validatePrivateSnapshot(item.snapshot, scope);
    if (snapshot.capturedAt !== checkedAt) {
      fail("causal_timeline_invalid", "私有权威快照时间必须与对应核对时间一致。");
    }
    ids.add(item.checkId);
    previousTime = checkedAt;
    snapshotDigests.push(canonicalDigest({ checkedAt, persistedAt, scope, snapshot }));
  }
  const first = timestamp(observation.checks[0].checkedAt, "first private check");
  const last = timestamp(observation.checks.at(-1).checkedAt, "last private check");
  if (last - first < STAGE_FIVE_MINIMUM_OBSERVATION_MS) {
    fail("observation_too_short", "首次到末次私有权威核对本身必须覆盖至少 10 分钟。");
  }
  return {
    snapshotDigests,
    lastPersistedAt: timestamp(observation.checks.at(-1).persistedAt, "last private check persistedAt"),
  };
}

function validatePrivateSnapshot(value, scope) {
  const snapshot = exactObject(value, [
    "accountFingerprint",
    "capturedAt",
    "hedgeState",
    "openOrders",
    "perpetualShortQuantityBase",
    "spotQuantityBase",
    "takeoverState",
  ], "private snapshot");
  if (
    snapshot.accountFingerprint !== scope.accountFingerprint
    || snapshot.hedgeState !== "strict"
    || snapshot.takeoverState !== "managed"
  ) {
    fail("scope_binding_invalid", "私有权威快照与当前账户或 takeover 状态不一致。");
  }
  nonNegativeFinite(snapshot.spotQuantityBase, "private spot quantity");
  nonNegativeFinite(snapshot.perpetualShortQuantityBase, "private perpetual quantity");
  if (snapshot.spotQuantityBase !== snapshot.perpetualShortQuantityBase) {
    fail("scope_binding_invalid", "私有权威快照不是严格对冲。");
  }
  const openOrders = validateOrders(snapshot.openOrders, scope, "private snapshot orders");
  return Object.freeze({
    ...snapshot,
    capturedAt: timestamp(snapshot.capturedAt, "private snapshot capturedAt"),
    openOrders,
  });
}

function validateRestart(value, scope, openedAt, closedAt) {
  const restart = exactObject(value, [
    "apiRestartedAt",
    "completedAt",
    "ordersAfter",
    "ordersBefore",
    "persistedAt",
    "requestedAt",
    "scope",
    "takeoverStateAfter",
    "takeoverStateBefore",
  ], "restart evidence");
  assertSameScope(restart.scope, scope, "restart");
  const requestedAt = timestamp(restart.requestedAt, "restart requestedAt");
  const restartedAt = timestamp(restart.apiRestartedAt, "API restartedAt");
  const completedAt = timestamp(restart.completedAt, "restart completedAt");
  const persistedAt = timestamp(restart.persistedAt, "restart persistedAt");
  const before = validateOrderSnapshot(restart.ordersBefore, scope, "orders before restart");
  const after = validateOrderSnapshot(restart.ordersAfter, scope, "orders after restart");
  if (
    before.capturedAt < openedAt
    || before.capturedAt >= requestedAt
    || requestedAt > restartedAt
    || restartedAt > completedAt
    || completedAt >= after.capturedAt
    || after.capturedAt > persistedAt
    || persistedAt > closedAt
    || restart.takeoverStateBefore !== "managed"
    || restart.takeoverStateAfter !== "managed"
  ) {
    fail("restart_recovery_invalid", "必须在严格对冲持仓存在时受控重启 API。");
  }
  const beforeDigest = canonicalDigest(before.orders);
  const afterDigest = canonicalDigest(after.orders);
  if (beforeDigest !== afterDigest) {
    fail("restart_duplicate_order", "重启恢复不得新增或重复 provider 订单。");
  }
  return Object.freeze({
    apiRestartedAt: restartedAt,
    completedAt,
    ordersAfterCapturedAt: after.capturedAt,
    ordersBeforeCapturedAt: before.capturedAt,
    ordersDigest: beforeDigest,
    persistedAt,
    requestedAt,
    takeoverStateAfter: restart.takeoverStateAfter,
    takeoverStateBefore: restart.takeoverStateBefore,
  });
}

function validateOrderSnapshot(value, scope, label) {
  const snapshot = exactObject(value, [
    "capturedAt",
    "orders",
    "scope",
  ], label);
  assertSameScope(snapshot.scope, scope, label);
  return Object.freeze({
    capturedAt: timestamp(snapshot.capturedAt, `${label} capturedAt`),
    orders: validateOrders(snapshot.orders, scope, label),
  });
}

function validateOrders(value, scope, label) {
  if (!Array.isArray(value)) fail("stage_five_evidence_invalid", `${label} must be an array`);
  const keys = new Set();
  const orders = value.map((entry) => {
    const order = exactObject(entry, [
      "clientOrderId",
      "market",
      "providerOrderId",
      "scope",
      "symbol",
    ], label);
    assertSameScope(order.scope, scope, label);
    if (
      !["spot", "perpetual"].includes(order.market)
      || order.symbol !== "XAUTUSDT"
      || typeof order.clientOrderId !== "string"
      || !order.clientOrderId
      || typeof order.providerOrderId !== "string"
      || !order.providerOrderId
    ) {
      fail("stage_five_evidence_invalid", `${label} contains an invalid order`);
    }
    const key = `${order.market}\0${order.clientOrderId}\0${order.providerOrderId}`;
    if (keys.has(key)) fail("restart_duplicate_order", `${label} contains duplicate orders`);
    keys.add(key);
    return Object.freeze({ ...order, scope });
  });
  return Object.freeze(orders.sort((left, right) =>
    canonicalString(left).localeCompare(canonicalString(right))));
}

function validateMutationJournal(value, scope, openedAt, closedAt, currentCapturedAt) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("mutation_journal_invalid", "真实闭环必须提供完整且非空的系统 mutation journal。");
  }
  const entries = [];
  const ids = new Set();
  let previousPersistedAt = -1;
  for (let index = 0; index < value.length; index += 1) {
    const raw = exactObject(value[index], [
      "acceptedQuantityBase",
      "acceptedAt",
      "actualFillQuantityBase",
      "clientOrderId",
      "completedAt",
      "eventType",
      "journalId",
      "market",
      "operation",
      "persistedAt",
      "providerEventId",
      "providerOrderId",
      "requestedQuantityBase",
      "requestedAt",
      "scope",
      "sequence",
      "symbol",
    ], "mutation journal entry");
    assertSameScope(raw.scope, scope, "mutation journal entry");
    uuid(raw.journalId, "mutation journal ID");
    if (ids.has(raw.journalId) || raw.sequence !== index + 1) {
      fail("mutation_journal_invalid", "mutation journal ID 与 sequence 必须唯一且连续。");
    }
    ids.add(raw.journalId);
    if (
      !["accepted", "fill", "cancel"].includes(raw.eventType)
      || !["cancel_active_order", "perpetual_reduce", "spot_sell"].includes(raw.operation)
      || !["spot", "perpetual"].includes(raw.market)
      || raw.symbol !== "XAUTUSDT"
      || typeof raw.clientOrderId !== "string"
      || !raw.clientOrderId
      || typeof raw.providerOrderId !== "string"
      || !raw.providerOrderId
      || typeof raw.providerEventId !== "string"
      || !raw.providerEventId
    ) {
      fail("mutation_journal_invalid", "mutation journal provider 事实无效。");
    }
    if (
      (raw.operation === "cancel_active_order") !== (raw.eventType === "cancel")
      || (raw.operation === "perpetual_reduce" && raw.market !== "perpetual")
      || (raw.operation === "spot_sell" && raw.market !== "spot")
    ) {
      fail("mutation_journal_invalid", "mutation journal 操作、市场和事件类型不一致。");
    }
    nonNegativeFinite(raw.requestedQuantityBase, "mutation requested quantity");
    nonNegativeFinite(raw.acceptedQuantityBase, "mutation accepted quantity");
    nonNegativeFinite(raw.actualFillQuantityBase, "mutation actual fill quantity");
    if (
      (
        raw.eventType === "accepted"
        && (
          !(raw.requestedQuantityBase > 0)
          || !(raw.acceptedQuantityBase > 0)
          || raw.acceptedQuantityBase > raw.requestedQuantityBase + 1e-12
          || raw.actualFillQuantityBase !== 0
        )
      )
      || (
        raw.eventType === "fill"
        && (
          raw.requestedQuantityBase !== 0
          || raw.acceptedQuantityBase !== 0
          || !(raw.actualFillQuantityBase > 0)
        )
      )
      || (
        raw.eventType === "cancel"
        && (
          raw.requestedQuantityBase !== 0
          || raw.acceptedQuantityBase !== 0
          || raw.actualFillQuantityBase !== 0
        )
      )
    ) {
      fail("mutation_journal_invalid", "mutation 请求、受理和实际成交数量与事件类型不一致。");
    }
    const requestedAt = timestamp(raw.requestedAt, "mutation requestedAt");
    const acceptedAt = timestamp(raw.acceptedAt, "mutation acceptedAt");
    const completedAt = timestamp(raw.completedAt, "mutation completedAt");
    const persistedAt = timestamp(raw.persistedAt, "mutation persistedAt");
    if (
      requestedAt < openedAt
      || requestedAt <= currentCapturedAt
      || requestedAt > acceptedAt
      || acceptedAt > completedAt
      || completedAt > persistedAt
      || persistedAt > closedAt
      || persistedAt <= previousPersistedAt
    ) {
      fail("causal_timeline_invalid", "mutation 必须在当前权威 sizing 后按受理、完成、落盘顺序发生。");
    }
    previousPersistedAt = persistedAt;
    entries.push(Object.freeze({
      ...raw,
      acceptedAt,
      completedAt,
      persistedAt,
      requestedAt,
      scope,
    }));
  }
  validateAcceptedFillAggregation(entries);
  return Object.freeze({
    entries: Object.freeze(entries),
    firstAcceptedAt: entries[0].acceptedAt,
    lastPersistedAt: entries.at(-1).persistedAt,
  });
}

function mutationOrderKey(entry) {
  return [
    entry.operation,
    entry.market,
    entry.symbol,
    entry.clientOrderId,
    entry.providerOrderId,
  ].join("\0");
}

function validateAcceptedFillAggregation(entries) {
  const accepted = new Map();
  const fills = new Map();
  const fillIds = new Set();
  for (const entry of entries) {
    if (entry.eventType === "accepted") {
      const key = mutationOrderKey(entry);
      if (accepted.has(key)) fail("mutation_journal_invalid", "同一 provider 订单只能有一条 accepted 记录。");
      accepted.set(key, entry);
    } else if (entry.eventType === "fill") {
      if (fillIds.has(entry.providerEventId)) {
        fail("mutation_journal_invalid", "provider fill ID 不得重复。");
      }
      fillIds.add(entry.providerEventId);
      const key = mutationOrderKey(entry);
      fills.set(key, [...(fills.get(key) ?? []), entry]);
    }
  }
  if (
    accepted.size !== fills.size
    || [...accepted].some(([key, acceptedEntry]) => {
      const orderFills = fills.get(key);
      if (!orderFills?.length) return true;
      const total = orderFills.reduce((sum, fill) => sum + fill.actualFillQuantityBase, 0);
      return !(total > 0) || total > acceptedEntry.acceptedQuantityBase + 1e-12;
    })
    || [...fills].some(([key]) => !accepted.has(key))
  ) {
    fail("mutation_journal_invalid", "每个 accepted 订单的去重实际成交总量必须大于零且不超过受理数量。");
  }
  const perpetualFilled = entries
    .filter((entry) => entry.eventType === "fill" && entry.operation === "perpetual_reduce")
    .reduce((sum, entry) => sum + entry.actualFillQuantityBase, 0);
  const spotAccepted = entries
    .filter((entry) => entry.eventType === "accepted" && entry.operation === "spot_sell")
    .reduce((sum, entry) => sum + entry.acceptedQuantityBase, 0);
  const spotFilled = entries
    .filter((entry) => entry.eventType === "fill" && entry.operation === "spot_sell")
    .reduce((sum, entry) => sum + entry.actualFillQuantityBase, 0);
  if (
    !(perpetualFilled > 0)
    || !(spotFilled > 0)
    || spotFilled > spotAccepted + 1e-12
    || spotAccepted > perpetualFilled + 1e-12
  ) {
    fail("mutation_journal_invalid", "现货卖出只能跟随权威永续实际 reduce fill，且不得超过已受理数量。");
  }
}

async function validateExitEvidence(value, scope, openedAt, closedAt, mutationJournal) {
  const exit = exactObject(value, [
    "activity",
    "completedAt",
    "persistedAt",
    "scope",
    "snapshot",
    "startedAt",
  ], "exit evidence");
  assertSameScope(exit.scope, scope, "exit");
  const startedAt = timestamp(exit.startedAt, "exit startedAt");
  const completedAt = timestamp(exit.completedAt, "exit completedAt");
  const persistedAt = timestamp(exit.persistedAt, "exit persistedAt");
  if (
    startedAt < openedAt
    || startedAt > completedAt
    || completedAt > persistedAt
    || persistedAt > closedAt
  ) {
    fail("causal_timeline_invalid", "退出开始、完成和落盘时间无效。");
  }
  const snapshot = validateExitSnapshot(exit.snapshot, scope);
  const spotResidual = assessResidual(
    snapshot.spotAvailableQuantityBase,
    snapshot.spot.bid,
    snapshot.spot.qtyStep,
    snapshot.spot.minOrderQty,
    snapshot.spot.minNotionalUsd,
  );
  if (spotResidual.tradable) {
    fail("tradable_spot_residual_present", "现货残余只有在权威规则独立证明不可交易时才可保留。");
  }
  if (snapshot.perpetualShortQuantityBase !== 0) {
    fail("perpetual_residual_present", "永续残余必须精确为零，不能按 dust 忽略。");
  }
  const activityDigest = await validateProviderActivity(
    exit.activity,
    scope,
    openedAt,
    snapshot.capturedAt,
    mutationJournal.entries,
  );
  return Object.freeze({
    activityDigest,
    completedAt,
    persistedAt,
    snapshotCapturedAt: snapshot.capturedAt,
    snapshotDigest: canonicalDigest(snapshot),
    spotResidual,
    startedAt,
  });
}

function validateExitSnapshot(value, scope) {
  const snapshot = exactObject(value, [
    "accountFingerprint",
    "activeOrders",
    "capturedAt",
    "perpetual",
    "perpetualShortQuantityBase",
    "scope",
    "spot",
    "spotAvailableQuantityBase",
  ], "exit authoritative snapshot");
  assertSameScope(snapshot.scope, scope, "exit authoritative snapshot");
  if (snapshot.accountFingerprint !== scope.accountFingerprint) {
    fail("scope_binding_invalid", "退出权威快照账户 fingerprint 不一致。");
  }
  nonNegativeFinite(snapshot.spotAvailableQuantityBase, "exit spot quantity");
  nonNegativeFinite(snapshot.perpetualShortQuantityBase, "exit perpetual quantity");
  const activeOrders = validateOrders(snapshot.activeOrders, scope, "exit active orders");
  if (activeOrders.length !== 0) {
    fail("exit_snapshot_invalid", "退出完成时目标 XAUT 仍有活动订单。");
  }
  return Object.freeze({
    accountFingerprint: snapshot.accountFingerprint,
    activeOrders,
    capturedAt: timestamp(snapshot.capturedAt, "exit snapshot capturedAt"),
    perpetual: validateExitInstrument(snapshot.perpetual, "perpetual"),
    perpetualShortQuantityBase: snapshot.perpetualShortQuantityBase,
    scope,
    spot: validateExitInstrument(snapshot.spot, "spot"),
    spotAvailableQuantityBase: snapshot.spotAvailableQuantityBase,
  });
}

function validateExitInstrument(value, market) {
  const priceKey = market === "spot" ? "bid" : "ask";
  const instrument = exactObject(value, [
    priceKey,
    "executableDepthBase",
    "minNotionalUsd",
    "minOrderQty",
    "priceTick",
    "qtyStep",
    "status",
    "symbol",
  ], `exit ${market} instrument`);
  if (instrument.status !== "Trading" || instrument.symbol !== "XAUTUSDT") {
    fail("exit_snapshot_invalid", "退出时产品规则或 symbol 与冻结 profile 不一致。");
  }
  for (const key of [
    priceKey,
    "executableDepthBase",
    "minNotionalUsd",
    "minOrderQty",
    "priceTick",
    "qtyStep",
  ]) positiveFinite(instrument[key], `exit ${market} ${key}`);
  return Object.freeze({ ...instrument });
}

async function validateProviderActivity(value, scope, openedAt, snapshotCapturedAt, journalEntries) {
  const activity = exactObject(value, ["collector", "scope", "sources"], "provider activity");
  assertSameScope(activity.scope, scope, "provider activity");
  const collector = exactObject(activity.collector, [
    "capturedAt",
    "collectorId",
    "revision",
    "schemaVersion",
    "windowEnd",
    "windowStart",
  ], "provider activity collector");
  if (
    collector.schemaVersion !== 1
    || collector.collectorId !== STAGE_FIVE_ACTIVITY_COLLECTOR
    || revision(collector.revision, "activity collector revision") !== scope.revision
    || timestamp(collector.windowStart, "activity windowStart") !== openedAt
    || timestamp(collector.windowEnd, "activity windowEnd") !== snapshotCapturedAt
    || timestamp(collector.capturedAt, "activity capturedAt") < snapshotCapturedAt
  ) {
    fail("provider_activity_incomplete", "provider 采集器、revision 或权威窗口边界不完整。");
  }
  if (!Array.isArray(activity.sources)) {
    fail("provider_activity_incomplete", "provider 活动必须提供逐来源原始响应证据。");
  }
  const sourceNames = activity.sources.map((raw) =>
    exactObject(raw, ["requests", "source"], "provider activity source").source);
  if (
    sourceNames.length !== REQUIRED_BINANCE_ACTIVITY_SOURCES.length
    || new Set(sourceNames).size !== sourceNames.length
    || canonicalString(sourceNames) !== canonicalString(REQUIRED_BINANCE_ACTIVITY_SOURCES)
  ) {
    fail("provider_activity_incomplete", "provider 活动来源集合必须与服务端冻结的 Binance XAUT 集合完全一致。");
  }

  const captures = [];
  const parsedEvents = [];
  for (const rawSource of activity.sources) {
    const sourceEvidence = exactObject(rawSource, ["requests", "source"], "provider activity source");
    const source = sourceEvidence.source;
    if (!Array.isArray(sourceEvidence.requests) || sourceEvidence.requests.length === 0) {
      fail("provider_activity_incomplete", `provider source ${source} 缺少原始响应。`);
    }
    for (const rawRequest of sourceEvidence.requests) {
      const request = exactObject(rawRequest, [
        "apiScope",
        "cursorIn",
        "cursorOut",
        "endpoint",
        "httpMethod",
        "pageIndex",
        "pageLimit",
        "params",
        "requestDigest",
        "requestedAt",
        "responseArtifact",
        "responseAttestation",
        "responseCapturedAt",
        "streamId",
        "termination",
        "watermarkIn",
        "watermarkOut",
      ], "provider activity request");
      const params = validateStringRecord(request.params, "provider activity request params");
      if (
        request.httpMethod !== "GET"
        || !["spot", "futures"].includes(request.apiScope)
        || typeof request.endpoint !== "string"
        || !request.endpoint.startsWith("/")
        || !endpointMatchesActivitySource(source, request.apiScope, request.endpoint, params)
        || request.pageLimit !== RWA_ACTIVITY_MAX_PAGES_PER_SOURCE
        || request.watermarkIn !== openedAt
        || request.watermarkOut !== snapshotCapturedAt
        || !Number.isSafeInteger(request.pageIndex)
        || request.pageIndex < 0
        || request.pageIndex >= RWA_ACTIVITY_MAX_PAGES_PER_SOURCE
        || !["more", "complete"].includes(request.termination)
        || params.startTime !== String(openedAt)
        || params.endTime !== String(snapshotCapturedAt)
      ) {
        fail("provider_activity_incomplete", `provider source ${source} 请求契约无效。`);
      }
      const streamId = activityStreamId(source, request.apiScope, request.endpoint, params);
      if (
        request.streamId !== streamId
        || request.cursorIn !== activityCursorIn(request.endpoint, params, request.pageIndex)
        || !(
          request.cursorOut === null
          || (typeof request.cursorOut === "string" && request.cursorOut.length > 0)
        )
        || (request.termination === "complete") !== (request.cursorOut === null)
      ) {
        fail("provider_activity_incomplete", "provider stream/cursor/termination 绑定无效。");
      }
      const requestedAt = timestamp(request.requestedAt, "provider request requestedAt");
      const responseCapturedAt = timestamp(request.responseCapturedAt, "provider response capturedAt");
      if (
        requestedAt < openedAt
        || requestedAt > responseCapturedAt
        || responseCapturedAt > collector.capturedAt
      ) {
        fail("provider_activity_incomplete", "provider 原始响应采集时间无效。");
      }
      const expectedRequestDigest = canonicalDigest({
        apiScope: request.apiScope,
        endpoint: request.endpoint,
        httpMethod: request.httpMethod,
        params,
        scopeDigest: canonicalDigest(scope),
        source,
        windowEnd: snapshotCapturedAt,
        windowStart: openedAt,
      });
      if (request.requestDigest !== expectedRequestDigest) {
        fail("provider_activity_incomplete", "provider request canonical digest 不一致。");
      }
      const artifact = readArtifact(request.responseArtifact, 0o400, "provider response");
      validateProviderResponseAttestation(
        request.responseAttestation,
        artifact,
        request.requestDigest,
        source,
        scope,
        openedAt,
        snapshotCapturedAt,
      );
      const response = parseJson(artifact.bytes, "provider response");
      let events;
      try {
        events = parseBinanceActivityResponseForReadiness(source, response);
      } catch {
        fail("provider_activity_incomplete", `provider source ${source} 响应 schema 无效。`);
      }
      captures.push(Object.freeze({
        ...request,
        artifact,
        params,
        response,
        source,
        streamId,
      }));
      parsedEvents.push(...events.map((event) => ({ ...event, source })));
    }
  }

  validateSharedActivityCaptures(captures);
  validateActivityStreams(captures);
  const replay = activityReplay(captures);
  let continuity = createMonitoredActivityContinuity(
    openedAt,
    STAGE_FIVE_ACTIVITY_REQUEST_PREFIX,
  );
  for (const entry of journalEntries) {
    continuity = recordStrategyProviderOrder(
      continuity,
      entry.market === "spot" ? "spot" : "linear",
      entry.providerOrderId,
      openedAt,
    );
  }
  const attribution = await scanBinancePositionAttribution(
    replay.spot,
    replay.futures,
    {
      checkedThrough: snapshotCapturedAt,
      continuity,
      since: openedAt,
      strategyOrderPrefixes: [STAGE_FIVE_ACTIVITY_REQUEST_PREFIX],
    },
  );
  if (
    replay.remaining() !== 0
    || attribution.coverage !== "complete"
    || attribution.externalPositionActivity
    || attribution.checkedFrom !== openedAt
    || attribution.checkedThrough !== snapshotCapturedAt
    || attribution.sources.length !== REQUIRED_BINANCE_ACTIVITY_SOURCES.length
    || attribution.sources.some((source) =>
      source.coverage !== "complete"
      || source.checkedFrom !== openedAt
      || source.checkedThrough !== snapshotCapturedAt)
  ) {
    fail("provider_activity_incomplete", "共享 Binance scanner 未证明所有冻结来源完整且无外部 XAUT 活动。");
  }

  const expected = new Map(journalEntries.map((entry) => [entry.providerEventId, entry]));
  const actual = new Map();
  for (const event of parsedEvents) {
    if (!event.affectsXaut) continue;
    if (!["spot_orders", "spot_trades", "perpetual_orders", "perpetual_trades"].includes(event.source)) {
      fail("provider_activity_unknown", `非订单来源 ${event.source} 出现 XAUT 资产变化。`);
    }
    const providerEventId = `${event.source}:${event.id}`;
    const journal = expected.get(providerEventId);
    if (!journal || actual.has(providerEventId)) {
      fail("provider_activity_mismatch", "provider 原始活动包含未归属或重复的 XAUT 事件。");
    }
    const market = event.source.startsWith("spot_") ? "spot" : "perpetual";
    const eventType = event.source.endsWith("_trades")
      ? "fill"
      : ["CANCELED", "CANCELLED"].includes(event.orderStatus)
        ? "cancel"
        : "accepted";
    const quantity = eventType === "fill"
      ? journal.actualFillQuantityBase
      : eventType === "accepted"
        ? journal.acceptedQuantityBase
        : 0;
    if (
      journal.eventType !== eventType
      || journal.market !== market
      || journal.providerOrderId !== event.providerOrderId
      || (event.clientOrderId && journal.clientOrderId !== event.clientOrderId)
      || journal[eventType === "accepted" ? "acceptedAt" : "completedAt"] !== event.occurredAt
      || (eventType !== "cancel" && Math.abs(event.quantityBase - quantity) > 1e-12)
      || (
        eventType === "accepted"
        && !["NEW", "PARTIALLY_FILLED", "FILLED"].includes(event.orderStatus)
      )
    ) {
      fail("provider_activity_mismatch", "共享 parser 结果与 system mutation journal 不一致。");
    }
    actual.set(providerEventId, event);
  }
  if (
    actual.size !== expected.size
    || [...expected].some(([providerEventId]) => !actual.has(providerEventId))
  ) {
    fail("provider_activity_mismatch", "全部冻结来源的 canonical XAUT 事件与 journal 必须双向 exact-set 对应。");
  }
  return canonicalDigest(activity);
}

function validateProviderResponseAttestation(
  value,
  artifact,
  requestDigest,
  source,
  scope,
  windowStart,
  windowEnd,
) {
  const attestationArtifact = readArtifact(value, 0o400, "provider response attestation");
  const attestation = exactObject(
    parseJson(attestationArtifact.bytes, "provider response attestation"),
    [
      "artifactKind",
      "artifactSha256",
      "artifactSizeBytes",
      "kind",
      "requestDigest",
      "revision",
      "schemaVersion",
      "scopeDigest",
      "source",
      "windowEnd",
      "windowStart",
    ],
    "provider response attestation",
  );
  if (
    attestation.schemaVersion !== 1
    || attestation.kind !== "stage-five-provider-response-attestation"
    || attestation.artifactKind !== "binance-xaut-readonly-response"
    || attestation.artifactSha256 !== artifact.sha256
    || attestation.artifactSizeBytes !== artifact.sizeBytes
    || attestation.requestDigest !== requestDigest
    || attestation.revision !== scope.revision
    || attestation.scopeDigest !== canonicalDigest(scope)
    || attestation.source !== source
    || attestation.windowStart !== windowStart
    || attestation.windowEnd !== windowEnd
  ) {
    fail("provider_activity_incomplete", "provider response attestation 未绑定请求、scope、窗口或 artifact。");
  }
}

function validateActivityStreams(captures) {
  const streams = new Map();
  for (const capture of captures) {
    streams.set(capture.streamId, [...(streams.get(capture.streamId) ?? []), capture]);
  }
  for (const pages of streams.values()) {
    pages.sort((left, right) => left.pageIndex - right.pageIndex);
    const nonNullCursors = pages.flatMap((page) =>
      [page.cursorIn, page.cursorOut].filter((cursor) => cursor !== null));
    if (
      pages.length > RWA_ACTIVITY_MAX_PAGES_PER_SOURCE
      || pages.some((page, index) =>
        page.pageIndex !== index
        || (index === 0 ? page.cursorIn !== null : page.cursorIn !== pages[index - 1].cursorOut)
        || (page.cursorOut !== null && page.cursorOut === page.cursorIn)
        || (index < pages.length - 1
          ? page.termination !== "more" || page.cursorOut === null
          : page.termination !== "complete" || page.cursorOut !== null))
      || new Set(nonNullCursors).size !== Math.ceil(nonNullCursors.length / 2)
      || new Set(pages.map((page) => page.artifact.sha256)).size !== pages.length
    ) {
      fail("provider_activity_incomplete", "provider 分页存在缺口、重复、无进展或未完整终止。");
    }
  }
}

function validateSharedActivityCaptures(captures) {
  const requests = new Map();
  for (const capture of captures) {
    const key = activityRequestKey(capture.apiScope, capture.endpoint, capture.params);
    requests.set(key, [...(requests.get(key) ?? []), capture]);
  }
  for (const shared of requests.values()) {
    if (shared.length === 1) continue;
    const sources = [...shared.map((capture) => capture.source)].sort();
    const reference = shared[0];
    if (
      canonicalString(sources) !== canonicalString(["deposits", "internal_deposits"])
      || shared.length !== 2
      || shared.some((capture) =>
        capture.artifact.path !== reference.artifact.path
        || capture.artifact.sha256 !== reference.artifact.sha256
        || capture.artifact.sizeBytes !== reference.artifact.sizeBytes
        || capture.requestedAt !== reference.requestedAt
        || capture.responseCapturedAt !== reference.responseCapturedAt
        || capture.pageIndex !== reference.pageIndex
        || capture.cursorIn !== reference.cursorIn
        || capture.cursorOut !== reference.cursorOut
        || capture.termination !== reference.termination
        || capture.watermarkIn !== reference.watermarkIn
        || capture.watermarkOut !== reference.watermarkOut)
    ) {
      fail(
        "provider_activity_incomplete",
        "相同 Binance 请求只能由 deposits/internal_deposits 共享同一次已认证原始响应。",
      );
    }
  }
}

function activityReplay(captures) {
  const pending = new Map();
  for (const capture of captures) {
    const key = activityRequestKey(capture.apiScope, capture.endpoint, capture.params);
    pending.set(key, [...(pending.get(key) ?? []), capture]);
  }
  const request = (apiScope) => async (endpoint, params) => {
    const key = activityRequestKey(apiScope, endpoint, params);
    const queue = pending.get(key);
    const capture = queue?.shift();
    if (!capture) throw new Error("provider activity response missing");
    return structuredClone(capture.response);
  };
  return {
    spot: request("spot"),
    futures: request("futures"),
    remaining: () => [...pending.values()].reduce((total, queue) => total + queue.length, 0),
  };
}

function activityRequestKey(apiScope, endpoint, params) {
  return canonicalString({ apiScope, endpoint, params });
}

function activityStreamId(source, apiScope, endpoint, params) {
  const paginationKeys = activityPaginationKeys(endpoint);
  const baseParams = Object.fromEntries(Object.entries(params)
    .filter(([key]) => !["startTime", "endTime", ...paginationKeys].includes(key)));
  return canonicalDigest({ apiScope, baseParams, endpoint, source });
}

function activityCursorIn(endpoint, params, pageIndex) {
  const key = activityPaginationKeys(endpoint)[0];
  if (!key || pageIndex === 0) return null;
  return params[key] ?? null;
}

function activityPaginationKeys(endpoint) {
  if (["/api/v3/allOrders", "/fapi/v1/allOrders"].includes(endpoint)) return ["orderId"];
  if (["/api/v3/myTrades", "/fapi/v1/userTrades"].includes(endpoint)) return ["fromId"];
  if (endpoint === "/fapi/v1/income") return ["tranId"];
  if (endpoint === "/sapi/v1/asset/transfer") return ["current"];
  if ([
    "/sapi/v1/capital/deposit/hisrec",
    "/sapi/v1/capital/withdraw/history",
    "/sapi/v1/asset/assetDividend",
  ].includes(endpoint)) return ["offset"];
  return [];
}

function endpointMatchesActivitySource(source, apiScope, endpoint, params) {
  if (source === "spot_orders") return apiScope === "spot" && endpoint === "/api/v3/allOrders";
  if (source === "spot_trades") return apiScope === "spot" && endpoint === "/api/v3/myTrades";
  if (source === "perpetual_orders") return apiScope === "futures" && endpoint === "/fapi/v1/allOrders";
  if (source === "perpetual_trades") return apiScope === "futures" && endpoint === "/fapi/v1/userTrades";
  if (source === "account_transactions") return apiScope === "futures" && endpoint === "/fapi/v1/income";
  if (source === "internal_transfers") {
    return apiScope === "spot"
      && endpoint === "/sapi/v1/asset/transfer"
      && ["MAIN_UMFUTURE", "MAIN_CMFUTURE"].includes(params.type);
  }
  if (source === "universal_transfers") {
    return apiScope === "spot"
      && endpoint === "/sapi/v1/asset/transfer"
      && typeof params.type === "string"
      && !["MAIN_UMFUTURE", "MAIN_CMFUTURE"].includes(params.type);
  }
  if (source === "deposits" || source === "internal_deposits") {
    return apiScope === "spot" && endpoint === "/sapi/v1/capital/deposit/hisrec";
  }
  if (source === "withdrawals") {
    return apiScope === "spot" && endpoint === "/sapi/v1/capital/withdraw/history";
  }
  if (source === "convert") return apiScope === "spot" && endpoint === "/sapi/v1/convert/tradeFlow";
  if (source === "dust") return apiScope === "spot" && endpoint === "/sapi/v1/asset/dribblet";
  return source === "balance_adjustments"
    && apiScope === "spot"
    && endpoint === "/sapi/v1/asset/assetDividend";
}

function validateStringRecord(value, label) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.values(value).some((item) => typeof item !== "string")
  ) {
    fail("provider_activity_incomplete", `${label} must be an object of strings`);
  }
  return Object.freeze({ ...value });
}

function validateGateState(value, scope, openedAt, closedAt, exitPersistedAt) {
  const gate = exactObject(value, [
    "allUserKillSwitchesEnabled",
    "capturedAt",
    "closedAt",
    "executionEnabled",
    "globalEnabled",
    "persistedAt",
    "scope",
    "serverKillSwitchEnabled",
    "strategyEnabled",
  ], "gate state evidence");
  assertSameScope(gate.scope, scope, "gate state");
  const capturedAt = timestamp(gate.capturedAt, "gate capturedAt");
  const gateClosedAt = timestamp(gate.closedAt, "gate closedAt");
  const persistedAt = timestamp(gate.persistedAt, "gate persistedAt");
  if (
    capturedAt < exitPersistedAt
    || capturedAt > gateClosedAt
    || gateClosedAt > persistedAt
    || persistedAt > closedAt
    || gateClosedAt !== closedAt
    || capturedAt < openedAt
  ) {
    fail("causal_timeline_invalid", "执行门禁必须在退出完成并落盘后关闭并持久化。");
  }
  validateRuntimeSwitchesDisabled({
    allUserKillSwitchesEnabled: gate.allUserKillSwitchesEnabled,
    executionEnabled: gate.executionEnabled,
    globalEnabled: gate.globalEnabled,
    serverKillSwitchEnabled: gate.serverKillSwitchEnabled,
    strategyEnabled: gate.strategyEnabled,
  });
  return Object.freeze({
    allUserKillSwitchesEnabled: gate.allUserKillSwitchesEnabled,
    capturedAt,
    closedAt: gateClosedAt,
    executionEnabled: gate.executionEnabled,
    globalEnabled: gate.globalEnabled,
    persistedAt,
    serverKillSwitchEnabled: gate.serverKillSwitchEnabled,
    strategyEnabled: gate.strategyEnabled,
  });
}

function validateArtifacts(
  value,
  scope,
  openedAt,
  closedAt,
  restart,
  mutationJournal,
  exit,
  gateState,
) {
  const artifacts = exactObject(value, [
    "auditLog",
    "releaseManifest",
    "rollbackManifest",
    "rwaEncryptedBackup",
    "sqliteBackup",
  ], "artifact evidence");
  const releaseEvidence = validateArtifactVerification(
    artifacts.releaseManifest,
    openedAt,
    closedAt,
    "release manifest",
  );
  const release = readArtifact(releaseEvidence.artifact, 0o444, "release manifest");
  const releaseManifest = validateReleaseManifest(parseJson(release.bytes, "release manifest"));
  if (releaseManifest.revision !== scope.revision) {
    fail("artifact_revision_mismatch", "release manifest 与真实窗口 revision 不一致。");
  }
  const rollbackEvidence = validateArtifactVerification(
    artifacts.rollbackManifest,
    openedAt,
    closedAt,
    "rollback manifest",
  );
  const rollback = readArtifact(rollbackEvidence.artifact, 0o444, "rollback manifest");
  const rollbackManifest = validateReleaseManifest(parseJson(rollback.bytes, "rollback manifest"));
  const sqliteEvidence = validateAttestedArtifact(
    artifacts.sqliteBackup,
    "sqlite_backup",
    scope.revision,
    openedAt,
    closedAt,
    "SQLite backup",
  );
  if (
    canonicalString(validateSqliteBackup(sqliteEvidence.artifact))
      !== canonicalString(sqliteEvidence.validation)
  ) {
    fail("sqlite_backup_invalid", "SQLite backup validation result is not bound by its attestation");
  }
  const rwaEvidence = validateAttestedArtifact(
    artifacts.rwaEncryptedBackup,
    "rwa_encrypted_backup",
    scope.revision,
    openedAt,
    closedAt,
    "RWA encrypted backup",
  );
  if (
    canonicalString(validateRwaBackup(rwaEvidence.artifact))
      !== canonicalString(rwaEvidence.validation)
  ) {
    fail("rwa_backup_invalid", "RWA backup envelope result is not bound by its attestation");
  }
  const audit = readArtifact(artifacts.auditLog, 0o400, "audit log");
  const expectedAuditEntries = [
    auditExpectation(
      "release_manifest_verified",
      release.sha256,
      releaseEvidence.verifiedAt,
      {
        artifactSha256: release.sha256,
        artifactSizeBytes: release.sizeBytes,
        revision: releaseManifest.revision,
      },
    ),
    auditExpectation(
      "sqlite_backup_verified",
      sqliteEvidence.artifact.sha256,
      sqliteEvidence.verifiedAt,
      {
        artifactSha256: sqliteEvidence.artifact.sha256,
        artifactSizeBytes: sqliteEvidence.artifact.sizeBytes,
        revision: scope.revision,
      },
    ),
    auditExpectation(
      "rwa_backup_verified",
      rwaEvidence.artifact.sha256,
      rwaEvidence.verifiedAt,
      {
        artifactSha256: rwaEvidence.artifact.sha256,
        artifactSizeBytes: rwaEvidence.artifact.sizeBytes,
        revision: scope.revision,
      },
    ),
    auditExpectation(
      "rollback_verified",
      rollback.sha256,
      rollbackEvidence.verifiedAt,
      {
        artifactSha256: rollback.sha256,
        artifactSizeBytes: rollback.sizeBytes,
        revision: rollbackManifest.revision,
      },
    ),
    ...mutationJournal.entries.map((entry) => auditExpectation(
      entry.eventType,
      entry.journalId,
      entry.eventType === "accepted" ? entry.acceptedAt : entry.completedAt,
      mutationAuditSubject(entry),
    )),
    auditExpectation(
      "restart",
      `restart:${scope.windowId}`,
      restart.persistedAt,
      {
        apiRestartedAt: restart.apiRestartedAt,
        completedAt: restart.completedAt,
        ordersAfterCapturedAt: restart.ordersAfterCapturedAt,
        ordersBeforeCapturedAt: restart.ordersBeforeCapturedAt,
        ordersDigest: restart.ordersDigest,
        persistedAt: restart.persistedAt,
        requestedAt: restart.requestedAt,
        takeoverStateAfter: restart.takeoverStateAfter,
        takeoverStateBefore: restart.takeoverStateBefore,
      },
    ),
    auditExpectation(
      "exit_complete",
      `exit:${scope.takeoverId}`,
      exit.persistedAt,
      {
        activityDigest: exit.activityDigest,
        completedAt: exit.completedAt,
        persistedAt: exit.persistedAt,
        snapshotCapturedAt: exit.snapshotCapturedAt,
        snapshotDigest: exit.snapshotDigest,
        spotResidual: exit.spotResidual,
        startedAt: exit.startedAt,
      },
    ),
    auditExpectation(
      "gate_closed",
      `gate:${scope.windowId}`,
      gateState.persistedAt,
      gateState,
    ),
  ];
  validateAuditLog(
    parseJson(audit.bytes, "audit log"),
    scope,
    openedAt,
    closedAt,
    expectedAuditEntries,
  );
  return {
    releaseManifest: release.sha256,
    rollbackManifest: rollback.sha256,
    rwaEncryptedBackup: rwaEvidence.artifact.sha256,
    sqliteBackup: sqliteEvidence.artifact.sha256,
    auditLog: audit.sha256,
  };
}

function validateArtifactVerification(value, openedAt, closedAt, label) {
  const evidence = exactObject(value, [
    "artifact",
    "verifiedAt",
  ], `${label} verification`);
  const verifiedAt = timestamp(evidence.verifiedAt, `${label} verifiedAt`);
  if (verifiedAt < openedAt || verifiedAt > closedAt) {
    fail("causal_timeline_invalid", `${label} verification time is outside the real window`);
  }
  return { artifact: evidence.artifact, verifiedAt };
}

function validateAttestedArtifact(value, artifactKind, expectedRevision, openedAt, closedAt, label) {
  const evidence = exactObject(value, [
    "artifact",
    "attestation",
    "verifiedAt",
  ], `${label} evidence`);
  const verifiedAt = timestamp(evidence.verifiedAt, `${label} verifiedAt`);
  if (verifiedAt < openedAt || verifiedAt > closedAt) {
    fail("causal_timeline_invalid", `${label} verification time is outside the real window`);
  }
  const artifact = readArtifact(evidence.artifact, 0o400, label);
  const attestationArtifact = readArtifact(
    evidence.attestation,
    0o400,
    `${label} attestation`,
  );
  const attestation = exactObject(parseJson(attestationArtifact.bytes, `${label} attestation`), [
    "artifactKind",
    "artifactSha256",
    "artifactSizeBytes",
    "kind",
    "revision",
    "schemaVersion",
    "validation",
  ], `${label} attestation`);
  if (
    attestation.schemaVersion !== 1
    || attestation.kind !== "stage-five-artifact-attestation"
    || attestation.artifactKind !== artifactKind
    || attestation.artifactSha256 !== artifact.sha256
    || attestation.artifactSizeBytes !== artifact.sizeBytes
    || revision(attestation.revision, `${label} attestation revision`) !== expectedRevision
  ) {
    fail("artifact_revision_mismatch", `${label} attestation does not bind the artifact to the release revision`);
  }
  return { artifact, validation: attestation.validation, verifiedAt };
}

function validateSqliteBackup(artifact) {
  if (
    artifact.bytes.length < 16
    || artifact.bytes.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
  ) {
    fail("sqlite_backup_invalid", "SQLite backup header is invalid");
  }
  let database;
  try {
    database = new DatabaseSync(":memory:");
    database.deserialize(artifact.bytes);
    const rows = database.prepare("PRAGMA integrity_check").all();
    if (
      rows.length !== 1
      || Object.values(rows[0] ?? {}).length !== 1
      || Object.values(rows[0] ?? {})[0] !== "ok"
    ) {
      fail("sqlite_backup_invalid", "SQLite backup integrity_check did not return ok");
    }
    return Object.freeze({
      format: "sqlite3",
      integrityCheck: "ok",
    });
  } catch (error) {
    if (error instanceof StageFiveReadinessError) throw error;
    fail("sqlite_backup_invalid", "SQLite backup cannot be opened for integrity verification");
  } finally {
    database?.close();
  }
}

function validateRwaBackup(artifact) {
  try {
    const value = JSON.parse(artifact.bytes.toString("utf8"));
    const envelope = validateRwaAutomationBackupEnvelopeForReadiness(
      value,
      basename(artifact.path),
    );
    return Object.freeze({
      backupId: envelope.backupId,
      createdAt: envelope.createdAt,
      environment: envelope.environment,
      purpose: "automation-backup",
      schemaVersion: 1,
    });
  } catch {
    fail("rwa_backup_invalid", "RWA encrypted backup envelope is invalid");
  }
}

function readArtifact(value, expectedMode, label) {
  const artifact = exactObject(value, [
    "path",
    "sha256",
    "sizeBytes",
  ], `${label} artifact`);
  if (typeof artifact.path !== "string" || !isAbsolute(artifact.path)) {
    fail("artifact_evidence_invalid", `${label} path must be absolute`);
  }
  digest(artifact.sha256, `${label} SHA-256`);
  let descriptor = -1;
  let metadata;
  let bytes;
  try {
    descriptor = openSync(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    metadata = fstatSync(descriptor);
  } catch {
    fail("artifact_evidence_invalid", `${label} regular-file boundary is invalid`);
  }
  try {
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== expectedMode
      || metadata.size !== artifact.sizeBytes
      || !Number.isSafeInteger(metadata.size)
      || metadata.size <= 0
      || metadata.size > MAX_ARTIFACT_BYTES
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (typeof process.getgid === "function" && metadata.gid !== process.getgid())
    ) {
      fail("artifact_evidence_invalid", `${label} regular-file boundary is invalid`);
    }
    bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail("artifact_evidence_invalid", `${label} is truncated`);
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== metadata.dev
      || after.ino !== metadata.ino
      || after.size !== metadata.size
      || after.nlink !== 1
      || (after.mode & 0o777) !== expectedMode
    ) {
      fail("artifact_evidence_invalid", `${label} changed while being read`);
    }
  } catch {
    fail("artifact_evidence_invalid", `${label} could not be read`);
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== artifact.sha256) {
    fail("artifact_evidence_invalid", `${label} SHA-256 mismatch`);
  }
  return {
    bytes,
    path: artifact.path,
    sha256: actualSha256,
    sizeBytes: metadata.size,
  };
}

function auditExpectation(eventType, sourceId, occurredAt, subject) {
  return Object.freeze({ eventType, sourceId, occurredAt, subject });
}

function mutationAuditSubject(entry) {
  return Object.freeze({
    acceptedQuantityBase: entry.acceptedQuantityBase,
    acceptedAt: entry.acceptedAt,
    actualFillQuantityBase: entry.actualFillQuantityBase,
    clientOrderId: entry.clientOrderId,
    completedAt: entry.completedAt,
    eventType: entry.eventType,
    journalId: entry.journalId,
    market: entry.market,
    operation: entry.operation,
    persistedAt: entry.persistedAt,
    providerEventId: entry.providerEventId,
    providerOrderId: entry.providerOrderId,
    requestedQuantityBase: entry.requestedQuantityBase,
    requestedAt: entry.requestedAt,
    sequence: entry.sequence,
    symbol: entry.symbol,
  });
}

function validateAuditLog(value, scope, openedAt, closedAt, expectedEntries) {
  const audit = exactObject(value, [
    "entries",
    "revision",
    "schemaVersion",
    "scope",
  ], "audit log");
  if (audit.schemaVersion !== 1 || audit.revision !== scope.revision) {
    fail("artifact_revision_mismatch", "audit log revision 与真实窗口不一致。");
  }
  assertSameScope(audit.scope, scope, "audit log");
  if (!Array.isArray(audit.entries)) {
    fail("artifact_evidence_invalid", "audit entries must be an array");
  }
  const expected = new Map(expectedEntries.map((entry) => [
    `${entry.eventType}\0${entry.sourceId}`,
    entry,
  ]));
  if (expected.size !== expectedEntries.length || audit.entries.length !== expected.size) {
    fail("artifact_evidence_invalid", "audit and structured runtime evidence are not an exact set");
  }
  const eventIds = new Set();
  const matched = new Set();
  let previousTime = -1;
  for (let index = 0; index < audit.entries.length; index += 1) {
    const raw = audit.entries[index];
    const entry = exactObject(raw, [
      "eventId",
      "eventType",
      "occurredAt",
      "sequence",
      "scope",
      "sourceId",
      "subject",
    ], "audit entry");
    uuid(entry.eventId, "audit eventId");
    if (eventIds.has(entry.eventId)) {
      fail("artifact_evidence_invalid", "audit event IDs must be unique");
    }
    eventIds.add(entry.eventId);
    assertSameScope(entry.scope, scope, "audit entry");
    const occurredAt = timestamp(entry.occurredAt, "audit occurredAt");
    if (
      occurredAt < openedAt
      || occurredAt > closedAt
      || occurredAt <= previousTime
      || entry.sequence !== index + 1
      || typeof entry.sourceId !== "string"
      || !entry.sourceId
    ) {
      fail("artifact_evidence_invalid", "audit entries must be strictly ordered inside the window");
    }
    previousTime = occurredAt;
    const key = `${entry.eventType}\0${entry.sourceId}`;
    const expectedEntry = expected.get(key);
    if (
      !expectedEntry
      || matched.has(key)
      || occurredAt !== expectedEntry.occurredAt
      || canonicalString(entry.subject) !== canonicalString(expectedEntry.subject)
    ) {
      fail("artifact_evidence_invalid", "audit entry does not exactly match its structured source event");
    }
    matched.add(key);
  }
  if (matched.size !== expected.size) {
    fail("artifact_evidence_invalid", "audit log and runtime journal must match bidirectionally");
  }
}

function assertSameScope(value, expected, label) {
  const actual = validateScope(value);
  if (canonicalString(actual) !== canonicalString(expected)) {
    fail("scope_binding_invalid", `${label} scope 与真实窗口不一致。`);
  }
}

function canonicalDigest(value) {
  return createHash("sha256").update(canonicalString(value)).digest("hex");
}

function canonicalString(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalString(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("artifact_evidence_invalid", `${label} is not valid JSON`);
  }
}

function exactObject(value, keys, label) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")
  ) {
    fail("stage_five_evidence_invalid", `${label} schema is invalid`);
  }
  return value;
}

function revision(value, label) {
  if (typeof value !== "string" || !FULL_REVISION.test(value)) {
    fail("stage_five_evidence_invalid", `${label} must be a full lowercase Git commit`);
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail("stage_five_evidence_invalid", `${label} must be a UUID`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail("stage_five_evidence_invalid", `${label} must be a SHA-256 digest`);
  }
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("stage_five_evidence_invalid", `${label} must be a non-negative safe integer`);
  }
  return value;
}

function stringSet(value, label) {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.length < 1)
    || new Set(value).size !== value.length
  ) {
    fail("stage_five_evidence_invalid", `${label} must contain unique non-empty strings`);
  }
  return new Set(value);
}

function trueValue(value, label) {
  if (value !== true) fail("stage_five_evidence_invalid", `${label} must be true`);
}

function falseValue(value, label) {
  if (value !== false) fail("stage_five_evidence_invalid", `${label} must be false`);
}

function zero(value, label) {
  if (value !== 0) fail("stage_five_evidence_invalid", `${label} must be zero`);
}

function positiveFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail("stage_five_evidence_invalid", `${label} must be finite and positive`);
  }
}

function nonNegativeFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("stage_five_evidence_invalid", `${label} must be finite and non-negative`);
  }
}

function fail(category, message) {
  throw new StageFiveReadinessError(category, message);
}
