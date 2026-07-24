import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFakeAutomationConsoleClient } from "../../../api/arbitrageAutomationConsole.fake";
import { createAutomationConsoleFixture } from "../model/controlConsoleFixture";
import { AutomationCandidates, canPreflightCandidate } from "./AutomationCandidates";
import {
  AutomationControlConsole,
  PreflightModeNotice,
  PreflightWarnings,
} from "./AutomationControlConsole";
import { AutomationCredentials } from "./AutomationCredentials";
import { AutomationParameters } from "./AutomationParameters";
import { AutomationPositions } from "./AutomationPositions";
import { AutomationSafety } from "./AutomationSafety";
import { AutomationStepUpSecurity, StepUpSecurityStatusTag } from "./AutomationStepUpSecurity";
import { TotpQrCode } from "./TotpQrCode";
import type { StepUpSecurityClient } from "../model/stepUpTypes";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const snapshot = createAutomationConsoleFixture();

test("console overview exposes controlled Mainnet boundaries without sensitive values", () => {
  const html = renderToStaticMarkup(
    <AutomationControlConsole
      client={createFakeAutomationConsoleClient(snapshot)}
      onReload={async () => undefined}
      snapshot={snapshot}
    />,
  );
  assert.match(html, /Mainnet 能力边界/);
  assert.match(html, /Binance 与 Bybit/);
  assert.match(html, /受控真实执行/);
  assert.match(html, /当前无自动策略候选/);
  assert.match(html, /策略级口径/);
  assert.match(html, /候选与执行/);
  assert.match(html, /安全操作/);
  assert.doesNotMatch(html, /fixture-secret|apiSecret/);
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
  assert.match(parameters, /服务端范围/);
  assert.match(parameters, /Binance 策略参数/);
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
