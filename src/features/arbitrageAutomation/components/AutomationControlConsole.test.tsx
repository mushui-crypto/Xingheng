import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFakeAutomationConsoleClient } from "../../../api/arbitrageAutomationConsole.fake";
import { createAutomationConsoleFixture } from "../model/controlConsoleFixture";
import { AutomationCandidates, canPreflightCandidate } from "./AutomationCandidates";
import { AutomationControlConsole, PreflightModeNotice, PreflightWarnings } from "./AutomationControlConsole";
import { AutomationCredentials } from "./AutomationCredentials";
import { AutomationParameters } from "./AutomationParameters";
import { AutomationPositions } from "./AutomationPositions";
import { AutomationSafety } from "./AutomationSafety";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const snapshot = createAutomationConsoleFixture();

test("console overview keeps the Mainnet boundary, shadow label and zero eligible opportunities explicit", () => {
  const html = renderToStaticMarkup(<AutomationControlConsole client={createFakeAutomationConsoleClient(snapshot)} onReload={async () => undefined} snapshot={snapshot} />);
  assert.match(html, /Mainnet 真实执行/);
  assert.match(html, /当前无自动策略候选/);
  assert.match(html, /策略级口径/);
  assert.match(html, /总览/);
  assert.match(html, /候选与执行/);
  assert.match(html, /安全操作/);
  assert.doesNotMatch(html, /fixture-secret/);
});

test("candidate table separates manual, safety-blocked and adapter-unavailable states", () => {
  const candidates = snapshot.candidates.map((candidate, index) => index === 0 ? { ...candidate, basisBps: null } : candidate);
  const html = renderToStaticMarkup(<AutomationCandidates candidates={candidates} onPreflight={() => undefined} />);
  assert.match(html, /可预检 2 个/);
  assert.match(html, /自动策略 0 个/);
  assert.match(html, /安全条件通过/);
  assert.match(html, /未达到自动策略条件/);
  assert.match(html, /手动风险预检/);
  assert.match(html, /只读条件检查/);
  assert.match(html, /只读 Shadow/);
  assert.match(html, /安全阻断/);
  assert.match(html, /Adapter 未接入/);
  assert.match(html, /disabled=""/);
  assert.match(html, /单腿盘口滑点超限/);
});

test("candidate preflight requires both venue capability and candidate adapter support", () => {
  const binanceXaut = snapshot.candidates.find((candidate) => candidate.id === "cand-xaut-binance-shadow-01");
  assert.ok(binanceXaut);
  const binanceUnsupported = {
    ...binanceXaut,
    id: "cand-paxg-binance-unavailable",
    asset: "PAXG",
    adapterImplemented: false,
    longLeg: { ...binanceXaut.longLeg, symbol: "PAXGUSDT" },
    shortLeg: { ...binanceXaut.shortLeg, symbol: "PAXGUSDT" },
  };

  assert.equal(canPreflightCandidate(binanceXaut), true);
  assert.equal(canPreflightCandidate(binanceUnsupported), false);
  const html = renderToStaticMarkup(<AutomationCandidates candidates={[binanceXaut, binanceUnsupported]} onPreflight={() => undefined} />);
  assert.match(html, /可预检 1 个/);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 1);
  assert.match(html, /Adapter 未接入/);
});

test("manual preflight notice keeps risk prompts separate from recommendations and safety gates", () => {
  const html = renderToStaticMarkup(<PreflightModeNotice mode="manual_entry" />);
  assert.match(html, /由用户手动决策/);
  assert.match(html, /不构成系统推荐/);
  assert.match(html, /不会绕过任何安全门槛/);
  assert.match(html, /收益、Funding、基差和持续性仅是风险提示/);
});
test("position surface keeps strategy PnL, live-shadow labels, legs and history separate", () => {
  const html = renderToStaticMarkup(<AutomationPositions groups={snapshot.positionGroups} onClose={async () => undefined} />);
  assert.match(html, /Shadow #024/);
  assert.match(html, /真实 #007/);
  assert.match(html, /订单、成交与 Funding 历史/);
  assert.match(html, /强平距离/);
  assert.match(html, /资金占用/);
});

test("Binance read-only positions never expose a platform close action", () => {
  const group = {
    ...snapshot.positionGroups[0],
    id: "binance-read-only-fixture",
    accountId: "binance-fixture",
    venue: "binance" as const,
    mode: "live" as const,
    label: "Binance 历史状态",
  };
  const html = renderToStaticMarkup(<AutomationPositions groups={[group]} onClose={async () => undefined} writableVenues={["bybit"]} />);
  assert.match(html, /当前阶段无平台代理退出/);
  assert.doesNotMatch(html, />退出持仓</);
});

test("preflight warnings render every server-provided risk without score language", () => {
  const html = renderToStaticMarkup(<PreflightWarnings warnings={["当前 Funding 不利", "当前净收益未达到自动策略条件", "基差超过自动策略范围"]} />);
  assert.match(html, /服务端实时风险提示/);
  assert.match(html, /当前 Funding 不利/);
  assert.match(html, /当前净收益未达到自动策略条件/);
  assert.match(html, /基差超过自动策略范围/);
  assert.doesNotMatch(html, /分数|评分/);
});
test("credential, parameter and safety surfaces expose required controls without secret values", () => {
  const credentials = renderToStaticMarkup(<AutomationCredentials credentials={snapshot.credentials} onDelete={async () => undefined} onFeedback={() => undefined} onGoToSafety={() => undefined} onValidate={async () => undefined} productionEgressIps={snapshot.productionEgressIps} />);
  const parameters = renderToStaticMarkup(<AutomationParameters onValidate={async () => undefined} parameters={snapshot.parameters} />);
  const safety = renderToStaticMarkup(<AutomationSafety onAction={() => undefined} snapshot={snapshot} />);
  assert.match(credentials, /withdraw=false/);
  assert.match(credentials, /Secret 不回显/);
  assert.match(credentials, /未配置/);
  assert.match(credentials, /已连接/);
  assert.match(credentials, /只读验证 \/ Shadow/);
  assert.match(credentials, /实盘执行未开放/);
  assert.match(credentials, /XAUTUSDT/);
  assert.doesNotMatch(credentials, /type="password"/);
  assert.match(parameters, /服务端范围/);
  assert.match(parameters, /新增 venue 默认 disabled/);
  assert.match(safety, /Kill switch/);
  assert.match(safety, /全部退出/);
  assert.match(safety, /Binance 第一阶段没有平台代理平仓/);
  assert.match(safety, /仅可授权与只读条件检查，无写动作/);
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
  const html = renderToStaticMarkup(<AutomationCredentials credentials={credentials} onDelete={async () => undefined} onFeedback={() => undefined} onGoToSafety={() => undefined} onValidate={async () => undefined} productionEgressIps={snapshot.productionEgressIps} />);
  for (const label of ["未配置", "校验中", "已连接", "权限不完整", "IP 未绑定", "已失效", "已撤销", "需轮换"]) assert.match(html, new RegExp(label));
  assert.match(html, /先退出仓位/);
  assert.match(html, /人工处理订单与仓位/);
});
