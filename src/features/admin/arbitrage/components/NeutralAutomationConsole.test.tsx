import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NeutralAutomationStatus } from "../model/types";
import { NeutralAutomationConsole } from "./NeutralAutomationConsole";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const unconfiguredReport: NeutralAutomationStatus = {
  network: "mainnet",
  phase: "phase_a_shadow",
  strategyId: "bybit-xaut-spot-perp-v1",
  ownerOnly: true,
  state: "disabled",
  status: "disabled",
  execution: { mode: "shadow", automaticOrdersEnabled: false, providerWriteCallCount: 0 },
  connector: {
    venue: "bybit",
    connected: false,
    accountMode: "unknown",
    readonly: true,
    permissions: { read: false, trade: false, withdraw: false },
    capabilities: ["connectivity", "balances", "orders", "positions"],
    checkedAt: 0,
    stale: true,
    errorCategory: null,
    message: "Bybit read-only connector is not configured.",
  },
  account: { mode: "unknown", balances: [], fees: [], instruments: [], orders: [], fills: [], positions: [] },
  shadow: {
    decisionId: "decision-1",
    idempotencyKey: "shadow-1",
    action: "observe",
    reason: "Strategy is disabled or kill switch is active; Phase A remains read-only.",
    wouldSendProviderWrite: false,
    target: { venue: "bybit", spotSymbol: "XAUTUSDT", perpetualSymbol: "XAUTUSDT", notionalUsd: 0 },
    gateChecks: [{ name: "global_execution_disabled", passed: true, message: "disabled" }],
    generatedAt: 0,
  },
  recovery: { source: "provider_snapshot", restoredFromSnapshot: true, lastSnapshotAt: null },
  audit: { latest: [] },
  warnings: ["Global real execution is disabled."],
};

test("unconfigured Phase A component is read-only, explicit, and fail-closed", () => {
  const html = renderToStaticMarkup(<NeutralAutomationConsole report={unconfiguredReport} />);
  assert.match(html, /Shadow/);
  assert.match(html, /真实交易/);
  assert.match(html, /Provider 写调用 0 次/);
  assert.match(html, /只读 Connector 未配置/);
  assert.match(html, /暂无余额快照/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /<input/);
});
