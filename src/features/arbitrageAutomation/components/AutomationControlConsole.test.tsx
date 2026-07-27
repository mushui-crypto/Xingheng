import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFakeAutomationConsoleClient } from "../../../api/arbitrageAutomationConsole.fake";
import { createFakeAssetManagementClient } from "../../../api/arbitrageAssetManagement.fake";
import { createAutomationConsoleFixture } from "../model/controlConsoleFixture";
import { AutomationCandidates, canPreflightCandidate } from "./AutomationCandidates";
import {
  AutomationAssetManagement,
  TakeoverMonitor,
  assetAuthorityGate,
  authorizationForAssetScope,
  createAssetScopeGuard,
  takeoverDisplayAfterAbort,
  takeoverDisplayAfterAbortFailure,
} from "./AutomationAssetManagement";
import {
  AutomationControlConsole,
  PreflightModeNotice,
  PreflightWarnings,
  shouldCancelStepUpForAccountScope,
} from "./AutomationControlConsole";
import { AutomationCredentials, resolveCredentialVerificationPanel } from "./AutomationCredentials";
import { AutomationParameters } from "./AutomationParameters";
import { AutomationPositions } from "./AutomationPositions";
import {
  ManualInterventionReconciliation,
  authoritativeSummary,
} from "./ManualInterventionReconciliation";
import { AutomationSafety } from "./AutomationSafety";
import { AutomationStepUpSecurity, StepUpSecurityStatusTag } from "./AutomationStepUpSecurity";
import { TotpQrCode } from "./TotpQrCode";
import type { StepUpSecurityClient } from "../model/stepUpTypes";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const snapshot = createAutomationConsoleFixture();

test("console overview keeps controlled Mainnet boundaries in compact help without persistent callouts", () => {
  const html = renderToStaticMarkup(
    <AutomationControlConsole
      client={createFakeAutomationConsoleClient(snapshot)}
      onReload={async () => undefined}
      snapshot={snapshot}
    />,
  );
  assert.match(html, /查看 Mainnet 执行边界/);
  assert.match(html, /受控真实执行/);
  assert.doesNotMatch(html, />Mainnet 能力边界</);
  assert.doesNotMatch(html, />当前无自动策略候选</);
  assert.match(html, /策略级口径/);
  assert.match(html, /候选与执行/);
  assert.match(html, /连通性验证/);
  assert.match(html, /安全操作/);
  assert.doesNotMatch(html, /fixture-secret|apiSecret/);
});

test("connectivity smoke entry is hidden when Binance capability is unavailable", () => {
  const unavailable = {
    ...snapshot,
    credentials: snapshot.credentials.map((credential) => credential.venue === "binance"
      ? { ...credential, canExecute: false, providerWritesEnabled: false }
      : credential),
  };
  const html = renderToStaticMarkup(
    <AutomationControlConsole
      client={createFakeAutomationConsoleClient(unavailable)}
      onReload={async () => undefined}
      snapshot={unavailable}
    />,
  );
  assert.doesNotMatch(html, /连通性验证/);
});

test("asset management is a single XAUT-only task surface without account internals", () => {
  const html = renderToStaticMarkup(
    <AutomationAssetManagement
      client={createFakeAssetManagementClient()}
      credentials={snapshot.credentials}
      onFeedback={() => undefined}
      requestStepUp={async () => "fixture-step-up"}
    />,
  );
  assert.match(html, /XAUT 资产管理/);
  assert.match(html, /资产授权/);
  assert.match(html, /接管计算器/);
  assert.match(html, /Binance/);
  assert.match(html, /Bybit/);
  assert.doesNotMatch(html, /BTC|ETH|SOL|accountId|fingerprint|provider payload|userDomain/);
  assert.doesNotMatch(html, new RegExp(`\\u${"817f"}`, "u"));
  assert.match(html, /min-h-11 min-w-24/);
  assert.match(html, /杠杆（1–3x）/);
  assert.match(html, /max="3" min="1"/);
  assert.match(html, /h-11 min-h-11/);
  assert.doesNotMatch(html, /\bh-9\b/);
});

test("asset scope generation rejects stale async results after venue or account changes", async () => {
  const guard = createAssetScopeGuard("binance:account-a:verified-a");
  const staleSnapshot = guard.capture();
  let staleCommit = false;
  const staleResponse = Promise.resolve().then(() => {
    if (guard.isCurrent(staleSnapshot)) staleCommit = true;
  });

  guard.sync("bybit:account-b:verified-b");
  await staleResponse;
  assert.equal(staleCommit, false);
  assert.equal(guard.isCurrent(staleSnapshot), false);

  const currentSnapshot = guard.capture();
  assert.equal(guard.isCurrent(currentSnapshot), true);
});

test("first current failure settles with retry while account actions remain fail-closed", () => {
  const scope = "binance:account-a:verified-a";
  const initial = assetAuthorityGate({
    accountScope: scope,
    authorizationError: null,
    authorizationLoading: false,
    lifecycleError: null,
    lifecycleLoading: false,
    resolvedAuthorizationScope: scope,
    resolvedLifecycleScope: null,
  });
  assert.equal(initial.pending, true);
  assert.equal(initial.actionsReady, false);
  assert.equal(initial.canRetry, false);

  const rejected = assetAuthorityGate({
    accountScope: scope,
    authorizationError: null,
    authorizationLoading: false,
    lifecycleError: "服务暂不可用",
    lifecycleLoading: false,
    resolvedAuthorizationScope: scope,
    resolvedLifecycleScope: null,
  });
  assert.equal(rejected.pending, false);
  assert.equal(rejected.actionsReady, false);
  assert.equal(rejected.canRetry, true);

  const retrying = assetAuthorityGate({
    accountScope: scope,
    authorizationError: null,
    authorizationLoading: false,
    lifecycleError: null,
    lifecycleLoading: true,
    resolvedAuthorizationScope: scope,
    resolvedLifecycleScope: null,
  });
  assert.equal(retrying.pending, true);
  assert.equal(retrying.actionsReady, false);

  const resolved = assetAuthorityGate({
    accountScope: scope,
    authorizationError: null,
    authorizationLoading: false,
    lifecycleError: null,
    lifecycleLoading: false,
    resolvedAuthorizationScope: scope,
    resolvedLifecycleScope: scope,
  });
  assert.equal(resolved.pending, false);
  assert.equal(resolved.actionsReady, true);
  assert.equal(resolved.canRetry, false);
});

test("authorization is hidden and every account action stays disabled across scope changes", () => {
  const authorization = {
    active: true,
    assetId: "xaut" as const,
    venue: "binance" as const,
    spotQuantity: 0.02,
    spotAvailableQuantity: 0.02,
    spotLockedQuantity: 0,
    perpetualQuantity: 0.02,
    perpetualSide: "short" as const,
    spotOrderCount: 1,
    perpetualOrderCount: 1,
    maxManagedSpotQuantity: 0.02,
    maxManagedPerpetualQuantity: 0.02,
    maxManagedNotionalUsd: 200,
    createdAt: 1,
    revokedAt: null,
  };
  const oldScope = "binance:account-a:verified-a";
  const nextScope = "bybit:account-b:verified-b";
  assert.equal(authorizationForAssetScope(authorization, oldScope, oldScope), authorization);
  assert.equal(authorizationForAssetScope(authorization, oldScope, nextScope), null);

  const delayed = assetAuthorityGate({
    accountScope: nextScope,
    authorizationError: null,
    authorizationLoading: true,
    lifecycleError: null,
    lifecycleLoading: true,
    resolvedAuthorizationScope: oldScope,
    resolvedLifecycleScope: oldScope,
  });
  assert.equal(delayed.actionsReady, false);
  assert.equal(delayed.pending, true);

  const currentFailure = assetAuthorityGate({
    accountScope: nextScope,
    authorizationError: null,
    authorizationLoading: false,
    lifecycleError: "当前接管读取失败",
    lifecycleLoading: false,
    resolvedAuthorizationScope: nextScope,
    resolvedLifecycleScope: null,
  });
  assert.equal(currentFailure.actionsReady, false);
  assert.equal(currentFailure.canRetry, true);
});

test("discovered awaiting-reconfirm takeover stays visible with safe abort and no TOTP action", () => {
  const html = renderToStaticMarkup(
    <TakeoverMonitor
      busy={false}
      onAbort={() => undefined}
      onExit={() => undefined}
      onRefresh={() => undefined}
      takeover={{
        takeoverId: "takeover-discovered",
        assetId: "xaut",
        venue: "binance",
        newCapitalUsd: 100,
        totalManagedCapitalUsd: 200,
        reservedCapitalUsd: 200,
        leverage: 2,
        state: "awaiting_reconfirm",
        targetHedgedQuantity: 0.02,
        finalSpotQuantity: 0.02,
        finalPerpetualQuantity: 0.02,
        residualQuantity: 0,
        errorCategory: null,
        message: "等待最新状态确认。",
        createdAt: 1,
        updatedAt: 1,
        runtime: null,
        requiresReconfirmation: true,
      }}
    />,
  );
  assert.match(html, /等待确认/);
  assert.match(html, /安全终止接管/);
  assert.match(html, /等待详情/);
  assert.doesNotMatch(html, /TOTP|全部退出/);
});

test("discovered manual-intervention takeover remains visible without unsafe actions", () => {
  const html = renderToStaticMarkup(
    <TakeoverMonitor
      busy={false}
      onAbort={() => undefined}
      onExit={() => undefined}
      onRefresh={() => undefined}
      takeover={{
        takeoverId: "takeover-manual",
        assetId: "xaut",
        venue: "binance",
        newCapitalUsd: 100,
        totalManagedCapitalUsd: 200,
        reservedCapitalUsd: 200,
        leverage: 2,
        state: "manual_intervention",
        targetHedgedQuantity: 0.02,
        finalSpotQuantity: 0.02,
        finalPerpetualQuantity: 0.01,
        residualQuantity: 0.01,
        errorCategory: "asset_takeover_manual_intervention",
        message: "账户仍有 XAUT 仓位，需要人工处理。",
        createdAt: 1,
        updatedAt: 2,
        runtime: null,
        requiresReconfirmation: false,
      }}
    />,
  );
  assert.match(html, /需要人工处理/);
  assert.match(html, /账户仍有 XAUT 仓位/);
  assert.match(html, /刷新状态/);
  assert.doesNotMatch(html, /安全终止接管|全部退出|TOTP/);
});

test("discovered managed takeover restores exiting runtime without exposing a second exit action", () => {
  const html = renderToStaticMarkup(
    <TakeoverMonitor
      busy={false}
      onAbort={() => undefined}
      onExit={() => undefined}
      onRefresh={() => undefined}
      takeover={{
        takeoverId: "takeover-exiting",
        assetId: "xaut",
        venue: "binance",
        newCapitalUsd: 100,
        totalManagedCapitalUsd: 200,
        reservedCapitalUsd: 50,
        leverage: 2,
        state: "managed",
        targetHedgedQuantity: 0.02,
        finalSpotQuantity: 0.02,
        finalPerpetualQuantity: 0.02,
        residualQuantity: 0,
        errorCategory: null,
        message: "正在退出对冲组合。",
        createdAt: 1,
        updatedAt: 2,
        requiresReconfirmation: false,
        runtime: {
          phase: "exiting",
          reason: "user_exit",
          message: "正在退出对冲组合。",
          lastSuccessfulCheckAt: 2,
          exitStartedAt: 2,
          exitCompletedAt: null,
          residualSpotQuantity: 0.02,
          residualPerpetualQuantity: 0.02,
          acceptedOrderCount: 0,
          providerResultCount: 0,
          cancelledOrderCount: 1,
          fundingSettlementCount: 0,
          lastFundingSettlementAt: null,
          snapshot: null,
        },
      }}
    />,
  );
  assert.match(html, /退出中/);
  assert.match(html, /正在退出对冲组合/);
  assert.doesNotMatch(html, />全部退出</);
  assert.doesNotMatch(html, /安全终止接管|TOTP/);
});

test("safe abort releases only failed takeover and preserves manual intervention", () => {
  const failed = takeoverDisplayAfterAbort({
    takeoverId: "takeover-failed",
    assetId: "xaut",
    venue: "binance",
    newCapitalUsd: 100,
    totalManagedCapitalUsd: 200,
    reservedCapitalUsd: 0,
    leverage: 2,
    state: "failed",
    targetHedgedQuantity: 0.02,
    finalSpotQuantity: 0,
    finalPerpetualQuantity: 0,
    residualQuantity: 0,
    errorCategory: null,
    message: "安全终止。",
    createdAt: 1,
    updatedAt: 2,
    runtime: null,
    requiresReconfirmation: false,
  });
  assert.equal(failed, null);

  const manual = takeoverDisplayAfterAbort({
    takeoverId: "takeover-manual",
    assetId: "xaut",
    venue: "binance",
    newCapitalUsd: 100,
    totalManagedCapitalUsd: 200,
    reservedCapitalUsd: 200,
    leverage: 2,
    state: "manual_intervention",
    targetHedgedQuantity: 0.02,
    finalSpotQuantity: 0.02,
    finalPerpetualQuantity: 0.01,
    residualQuantity: 0.01,
    errorCategory: "asset_takeover_manual_intervention",
    message: "需要人工处理。",
    createdAt: 1,
    updatedAt: 2,
    runtime: null,
    requiresReconfirmation: false,
  });
  assert.equal(manual?.state, "manual_intervention");
  assert.equal(manual?.reservedCapitalUsd, 200);
  assert.ok(manual && "requiresReconfirmation" in manual);
  assert.equal(takeoverDisplayAfterAbortFailure(manual, null), manual);
  assert.equal(takeoverDisplayAfterAbortFailure(manual, manual), manual);
});

test("candidate table separates manual, safety-blocked and adapter-unavailable states", () => {
  const candidates = snapshot.candidates.map((candidate, index) => (
    index === 0 ? { ...candidate, basisBps: null } : candidate
  ));
  const html = renderToStaticMarkup(
    <AutomationCandidates candidates={candidates} onPreflight={() => undefined} />,
  );
  assert.match(html, /可预检 2 个/);
  assert.match(html, /自动策略 0 个/);
  assert.match(html, /安全条件通过/);
  assert.match(html, /未达到自动策略条件/);
  assert.match(html, /手动风险预检/);
  assert.match(html, /安全阻断/);
  assert.match(html, /Adapter 未接入/);
  assert.match(html, /disabled=""/);
  assert.match(html, /单侧盘口滑点超限/);
  assert.match(html, /align-middle/);
  assert.doesNotMatch(html, /align-top/);
});

test("candidate preflight intersects venue capability, execution readiness and candidate adapter support", () => {
  const binanceXaut = snapshot.candidates.find((candidate) => candidate.id === "cand-xaut-binance-shadow-01");
  assert.ok(binanceXaut);
  const executionDisabled = { ...binanceXaut, executionReady: false };
  const binanceUnsupported = {
    ...binanceXaut,
    id: "cand-paxg-binance-unavailable",
    asset: "PAXG",
    adapterImplemented: false,
    longLeg: { ...binanceXaut.longLeg, symbol: "PAXGUSDT" },
    shortLeg: { ...binanceXaut.shortLeg, symbol: "PAXGUSDT" },
  };

  assert.equal(canPreflightCandidate(binanceXaut), true);
  assert.equal(canPreflightCandidate(executionDisabled), false);
  assert.equal(canPreflightCandidate(binanceUnsupported), false);
  const html = renderToStaticMarkup(
    <AutomationCandidates
      candidates={[binanceXaut, executionDisabled, binanceUnsupported]}
      onPreflight={() => undefined}
    />,
  );
  assert.match(html, /可预检 1 个/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.match(html, /执行未就绪/);
  assert.match(html, /Adapter 未接入/);
});

test("manual preflight notice keeps user decision separate from recommendations and safety gates", () => {
  const html = renderToStaticMarkup(<PreflightModeNotice mode="manual_entry" />);
  assert.match(html, /由用户手动决策/);
  assert.match(html, /不构成系统推荐/);
  assert.match(html, /不会绕过任何安全门槛/);
  assert.match(html, /收益、Funding、基差和持续性仅是风险提示/);
});

test("position surface keeps strategy PnL, both market sides and execution history separate", () => {
  const html = renderToStaticMarkup(
    <AutomationPositions groups={snapshot.positionGroups} onClose={async () => undefined} />,
  );
  assert.match(html, /演练 #024/);
  assert.match(html, /真实 #007/);
  assert.match(html, /现货侧/);
  assert.match(html, /永续侧/);
  assert.match(html, /订单、成交与 Funding 历史/);
  assert.match(html, /强平距离/);
  assert.match(html, /资金占用/);
});

test("Binance execution-capable position exposes the controlled exit action", () => {
  const group = {
    ...snapshot.positionGroups[0],
    id: "binance-live-fixture",
    accountId: "binance-fixture",
    venue: "binance" as const,
    mode: "live" as const,
    label: "Binance XAUT 现货与永续对冲组合",
  };
  const html = renderToStaticMarkup(
    <AutomationPositions
      groups={[group]}
      onClose={async () => undefined}
      writableVenues={["bybit", "binance"]}
    />,
  );
  assert.match(html, /退出对冲组合/);
  assert.doesNotMatch(html, /当前阶段无平台代理退出/);
});

test("manual intervention separates strategy records from a fresh authoritative snapshot", () => {
  const base = snapshot.positionGroups[0];
  assert.ok(base);
  const report = {
    reconciliationId: "execution-manual-1",
    strategyId: base.strategyId,
    recordedState: "manual_intervention" as const,
    authoritativeState: {
      snapshotAt: Date.now(),
      status: "ok" as const,
      stale: false,
      openOrders: { spot: 0, perpetual: 0, total: 0 },
      legs: {
        spot: {
          quantityXaut: 0.0003,
          freeQuantityXaut: 0.0003,
          markPrice: 3_360,
          minOrderQty: 0.0001,
          minNotionalUsd: 5,
          qtyStep: 0.0001,
        },
        perpetual: {
          quantityXaut: 0,
          freeQuantityXaut: null,
          markPrice: 3_361,
          minOrderQty: 0.001,
          minNotionalUsd: 5,
          qtyStep: 0.001,
        },
      },
    },
    legDiffs: { spotQuantityXaut: -7.1397, perpetualQuantityXaut: -7.1 },
    tradableResidual: { spot: null, perpetual: null },
    dustResidual: {
      spot: {
        quantityXaut: 0.0003,
        notionalUsd: 1.008,
        minOrderQty: 0.0001,
        minNotionalUsd: 5,
        qtyStep: 0.0001,
        tradable: false,
        reason: "below_min_notional" as const,
      },
      perpetual: null,
    },
    recommendedAction: "manual_finalize" as const,
    canFinalize: true,
    blockingReasons: [],
  };
  const group = {
    ...base,
    mode: "live" as const,
    status: "attention" as const,
    executionState: "manual_intervention" as const,
    reconciliationId: report.reconciliationId,
    reconciliation: report,
    capitalUsedUsd: 8.11,
  };
  const state = {
    scope: `binance:${group.accountId}:${report.reconciliationId}`,
    phase: "success" as const,
    requestId: "request-1",
    report,
    error: null,
  };
  const html = renderToStaticMarkup(
    <ManualInterventionReconciliation
      group={group}
      onFinalize={() => undefined}
      onReconcile={() => undefined}
      state={state}
    />,
  );

  assert.match(html, /策略记录待核对/);
  assert.match(html, /交易所最新状态/);
  assert.match(html, /不可交易小额余额/);
  assert.match(html, /minQty/);
  assert.match(html, /minNotional/);
  assert.match(html, /stepSize/);
  assert.match(html, /服务端允许申请人工结案/);
  assert.equal(authoritativeSummary(report)?.capitalUsedUsd, 1.008);
  assert.equal(authoritativeSummary({
    ...report,
    authoritativeState: { ...report.authoritativeState, status: "stale", stale: true },
  }), null);
});

test("manual intervention error state withdraws every old authoritative detail", () => {
  const group = {
    ...snapshot.positionGroups[0]!,
    mode: "live" as const,
    status: "attention" as const,
    executionState: "manual_intervention" as const,
    reconciliationId: "execution-manual-error",
    reconciliation: null,
  };
  const html = renderToStaticMarkup(
    <ManualInterventionReconciliation
      group={group}
      onFinalize={() => undefined}
      onReconcile={() => undefined}
      state={{
        scope: `binance:${group.accountId}:execution-manual-error`,
        phase: "error",
        requestId: "request-2",
        report: null,
        error: "交易所最新状态核对失败。",
      }}
    />,
  );
  assert.match(html, /对账结果不可用/);
  assert.match(html, /交易所最新状态核对失败/);
  assert.doesNotMatch(html, /实际资金占用|服务端允许申请人工结案|minNotional/);
});

test("preflight warnings render every server risk without score language", () => {
  const html = renderToStaticMarkup(
    <PreflightWarnings warnings={["当前 Funding 不利", "当前净收益未达到自动策略条件", "基差超过自动策略范围"]} />,
  );
  assert.match(html, /服务端实时风险提示/);
  assert.match(html, /当前 Funding 不利/);
  assert.match(html, /当前净收益未达到自动策略条件/);
  assert.match(html, /基差超过自动策略范围/);
  assert.doesNotMatch(html, /分数|评分/);
});

test("credential, parameter and safety surfaces expose current execution controls without secrets", () => {
  const credentials = renderToStaticMarkup(
    <AutomationCredentials
      credentials={snapshot.credentials}
      onDelete={async () => undefined}
      onFeedback={() => undefined}
      onGoToSafety={() => undefined}
      onValidate={async () => undefined}
      productionEgressIps={snapshot.productionEgressIps}
    />,
  );
  const parameters = renderToStaticMarkup(
    <AutomationParameters
      controls={snapshot.venueControls}
      onValidate={async () => undefined}
      parameters={snapshot.parameters}
    />,
  );
  const safety = renderToStaticMarkup(
    <AutomationSafety onAction={() => undefined} snapshot={snapshot} />,
  );
  assert.match(credentials, /withdraw=false/);
  assert.match(credentials, /Secret 不回显/);
  assert.match(credentials, /已连接/);
  assert.match(credentials, /受控真实执行/);
  assert.match(credentials, /XAUTUSDT/);
  assert.doesNotMatch(credentials, /type="password"|实盘执行未开放/);
  assert.match(parameters, /范围 25–300 USDT/);
  assert.match(parameters, /Binance 策略参数/);
  assert.match(parameters, /未修改/);
  assert.doesNotMatch(parameters, /草稿未保存|交易所限制/);
  assert.match(safety, /Kill switch/);
  assert.match(safety, /退出全部对冲组合/);
  assert.match(safety, /服务端全局急停/);
  assert.match(safety, /当前用户不能修改或绕过/);
});

test("credential lifecycle states and exposure safeguards remain explicit", () => {
  const lifecycle = [
    "unconfigured",
    "validating",
    "connected",
    "permission_incomplete",
    "ip_unbound",
    "expired",
    "revoked",
    "rotation_required",
  ] as const;
  const credentials = lifecycle.map((status, index) => ({
    ...snapshot.credentials[index % snapshot.credentials.length],
    accountId: `fixture-${status}`,
    venue: (["bybit", "bitget", "binance", "okx"] as const)[index % 4],
    status,
    activeOrderCount: status === "expired" ? 1 : 0,
    openPositionCount: status === "revoked" ? 1 : 0,
  }));
  const html = renderToStaticMarkup(
    <AutomationCredentials
      credentials={credentials}
      onDelete={async () => undefined}
      onFeedback={() => undefined}
      onGoToSafety={() => undefined}
      onValidate={async () => undefined}
      productionEgressIps={snapshot.productionEgressIps}
    />,
  );
  for (const label of ["未配置", "校验中", "已连接", "权限不完整", "IP 未绑定", "已失效", "已撤销", "需轮换"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /先退出仓位/);
  assert.match(html, /人工处理订单与仓位/);
});

test("credential verification panel separates requirements, progress, failures and restored active state", () => {
  const active = snapshot.credentials.find((credential) => credential.venue === "binance");
  assert.ok(active);
  const unconfigured = {
    ...active,
    accountId: null,
    maskedKey: null,
    lastVerifiedAt: null,
    status: "unconfigured" as const,
    verificationChecks: active.verificationChecks.map((check) => ({
      ...check,
      status: "pending" as const,
    })),
  };
  const failure = {
    action: "请等待服务恢复后重新提交。",
    category: "automation_internal_error",
    detail: "自动套利服务暂不可用。",
    requestId: "fixture-request",
    summary: "验证未通过，凭证未保存，账户仍未配置。",
  };

  const requirements = resolveCredentialVerificationPanel(unconfigured, false, undefined, "binance");
  assert.equal(requirements.mode, "requirements");
  assert.match(requirements.title, /尚未验证/);
  assert.match(requirements.description, /不代表已经通过/);

  const validating = resolveCredentialVerificationPanel(unconfigured, true, undefined, "binance");
  assert.equal(validating.mode, "validating");
  assert.match(validating.description, /返回成功前仍视为未配置/);

  const failed = resolveCredentialVerificationPanel(unconfigured, false, failure, "binance");
  assert.equal(failed.mode, "failed");
  assert.match(failed.description, /凭证未保存，账户仍未配置/);

  const restored = resolveCredentialVerificationPanel(active, false, undefined, "binance");
  assert.equal(restored.mode, "verified");
  assert.match(restored.title, /验证通过/);

  const incomplete = resolveCredentialVerificationPanel({
    ...active,
    verificationChecks: active.verificationChecks.map((check, index) => (
      index === 1 ? { ...check, status: "failed" as const } : check
    )),
  }, false, undefined, "binance");
  assert.equal(incomplete.mode, "incomplete");
  assert.match(incomplete.description, /不能视为已授权/);
});

test("snapshot refresh does not cancel TOTP while an actual account-scope change does", () => {
  const unchanged = "bybit:bybit-primary|binance:-";
  assert.equal(shouldCancelStepUpForAccountScope(unchanged, unchanged), false);
  assert.equal(
    shouldCancelStepUpForAccountScope(unchanged, "bybit:bybit-primary|binance:binance-primary"),
    true,
  );
});

test("step-up security surface stays task-focused and the QR fallback never embeds the setup URI", () => {
  const client: StepUpSecurityClient = {
    status: async () => ({ enrolled: false, pendingEnrollment: false, method: null, recoveryCodesRemaining: 0, enabledAt: null }),
    beginEnrollment: async () => ({ enrollmentId: "fixture-enrollment", otpauthUri: "otpauth://fixture", expiresAt: Date.now() + 60_000 }),
    confirmEnrollment: async () => ({ ok: true, recoveryCodes: ["fixture-recovery"] }),
    authorize: async () => ({ authorizationToken: "fixture-token", expiresAt: Date.now() + 60_000 }),
    regenerateRecoveryCodes: async () => ({ ok: true, recoveryCodes: ["fixture-recovery"] }),
    disable: async () => ({ ok: true }),
  };
  const security = renderToStaticMarkup(
    <AutomationStepUpSecurity client={client} onFeedback={() => undefined} />,
  );
  assert.match(security, /二次身份验证/);
  assert.match(security, /120 秒/);
  assert.match(security, /开始设置/);
  assert.doesNotMatch(security, /fixture-enrollment|fixture-recovery|fixture-token|otpauth:/);

  const uri = "otpauth://totp/Stella%20X:fixture?secret=FIXTURESECRET";
  const fallback = renderToStaticMarkup(<TotpQrCode value={uri} />);
  assert.match(fallback, /二维码暂不可用/);
  assert.match(fallback, /手动设置值/);
  assert.doesNotMatch(fallback, /otpauth:|FIXTURESECRET/);
});

test("step-up lifecycle status always has text in addition to color", () => {
  const base = {
    pendingEnrollment: false,
    method: null,
    recoveryCodesRemaining: 0,
    enabledAt: null,
  } as const;
  const states = [
    renderToStaticMarkup(<StepUpSecurityStatusTag status={null} unavailable />),
    renderToStaticMarkup(<StepUpSecurityStatusTag status={null} unavailable={false} />),
    renderToStaticMarkup(<StepUpSecurityStatusTag status={{ ...base, enrolled: false }} unavailable={false} />),
    renderToStaticMarkup(<StepUpSecurityStatusTag status={{ ...base, enrolled: false, pendingEnrollment: true }} unavailable={false} />),
    renderToStaticMarkup(<StepUpSecurityStatusTag status={{ ...base, enrolled: true, method: "totp" }} unavailable={false} />),
    renderToStaticMarkup(<StepUpSecurityStatusTag status={{ ...base, enrolled: true, method: "totp", recoveryCodesRemaining: 4 }} unavailable={false} />),
  ].join(" ");
  for (const label of ["不可用", "加载中", "未设置", "设置中", "需恢复", "已启用"]) {
    assert.match(states, new RegExp(label));
  }
});

test("all user-visible automation component markup avoids deprecated market-side wording", () => {
  const html = [
    renderToStaticMarkup(<AutomationCandidates candidates={snapshot.candidates} onPreflight={() => undefined} />),
    renderToStaticMarkup(<AutomationPositions groups={snapshot.positionGroups} onClose={async () => undefined} />),
    renderToStaticMarkup(
      <AutomationParameters
        controls={snapshot.venueControls}
        onValidate={async () => undefined}
        parameters={snapshot.parameters}
      />,
    ),
    renderToStaticMarkup(<AutomationSafety onAction={() => undefined} snapshot={snapshot} />),
  ].join("");
  assert.doesNotMatch(html, new RegExp(`\\u${"817f"}`, "u"));
});
