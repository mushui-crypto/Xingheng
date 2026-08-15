import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArbitrageExecutionDraft } from "../../../api/arbitrageExecutionDraft";
import {
  ArbitrageExecutionDraftContent,
  ArbitrageExecutionDraftEntry,
  canExecuteLeg,
  canReconcileLeg,
  canConfirmDraft,
  loadResumeContext,
  resumeDraftMatchesInstance,
} from "./ArbitrageExecutionDraftEntry";
import type { ArbitrageInstance } from "../../../api/arbitrageInstances";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("analysis execution entry is labelled 创建套利", () => {
  const html = renderToStaticMarkup(<ArbitrageExecutionDraftEntry horizonDays={90} opportunityId="op-1" />);
  assert.match(html, /创建套利/u);
});

test("resume content binds the existing instance and removes the create confirmation action", () => {
  const current = dogeInstance();
  const html = renderToStaticMarkup(content(dogeDraft(), current, true, true));
  assert.match(html, /72/u);
  assert.match(html, /DOGE/u);
  assert.match(html, /LONG · 多头腿/u);
  assert.match(html, /SHORT · 空头腿/u);
  assert.match(html, /继续使用现有实例/u);
  assert.doesNotMatch(html, /确认创建套利/u);
});

test("resume compatibility fails closed when opportunity legs or quantity no longer match", () => {
  const current = dogeInstance();
  assert.equal(resumeDraftMatchesInstance(dogeDraft(), current), true);
  const changed = dogeDraft();
  const mismatched = { ...changed, legs: [{ ...changed.legs[0], instrumentId: "BTC-USDT-SPOT" }, changed.legs[1]] } as ArbitrageExecutionDraft;
  assert.equal(resumeDraftMatchesInstance(mismatched, current), false);
});

test("resume loader uses instance GET and draft preview only, preserving the original arbitrage id", async () => {
  const current = dogeInstance();
  const payload = JSON.stringify({ opportunityId: "doge-op", horizonDays: 90, quantityInput: { mode: "ASSET_QUANTITY", quantity: "72" }, executionMode: "PRICE_PRIORITY" });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  current.sourcePlanId = `execution-confirmation:${Buffer.from(digest).toString("hex")}`;
  const calls: Array<{ url: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return Response.json(calls.length === 1 ? current : dogeDraft());
  };
  try {
    const resumed = await loadResumeContext(current.arbitrageId, "doge-op", 90);
    assert.equal(resumed.instance.arbitrageId, current.arbitrageId);
    assert.equal(resumed.quantity, "72");
    assert.equal(resumed.executionMode, "PRICE_PRIORITY");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, [
    { url: "/api/arbitrage-instances/arbitrage-existing", method: "GET" },
    { url: "/api/arbitrage-execution/draft/preview", method: "POST" },
  ]);
  assert.equal(calls.some((call) => call.url === "/api/arbitrage-execution/confirm"), false);
});

test("confirmation content renders both legs and disables confirmation when one venue is unavailable", () => {
  const html = renderToStaticMarkup(content(draft(false)));
  assert.match(html, /LONG · 多头腿/u);
  assert.match(html, /SHORT · 空头腿/u);
  assert.match(html, /执行能力尚未接入/u);
  assert.match(html, /USDT 名义金额/u);
  assert.match(html, /资产数量/u);
  assert.match(html, /确认创建套利/u);
  assert.match(html, /disabled=""/u);
  assert.match(html, /本阶段未创建套利实例/u);
});

test("confirmation content displays Planner minimum errors in Chinese", () => {
  const value = draft(false);
  const failed: ArbitrageExecutionDraft = {
    ...value,
    legs: [
      { ...value.legs[0], planning: { status: "ERROR", errorCode: "NOTIONAL_BELOW_MINIMUM", minimumRequiredNotionalUsdt: "25" } },
      value.legs[1],
    ],
  };
  const html = renderToStaticMarkup(content(failed));
  assert.match(html, /最低名义金额约为 25 USDT/u);
  assert.doesNotMatch(html, /provider_response|NOTIONAL_BELOW_MINIMUM/u);
});

test("final confirmation is enabled only after both legs have planned and available execution capability", () => {
  assert.equal(canConfirmDraft(draft(false)), false);
  assert.equal(canConfirmDraft(draft(true)), true);
});

test("leg selection remains manual and second leg unlocks only after a complete confirmed first leg", () => {
  const created = instance([]);
  assert.equal(canExecuteLeg(created, "long-leg"), true);
  assert.equal(canExecuteLeg(created, "short-leg"), true);
  assert.equal(canExecuteLeg(created, "foreign-leg"), false);

  const unknown = instance([reference("long-leg", "UNKNOWN", "0")]);
  assert.equal(canExecuteLeg(unknown, "short-leg"), false);
  const partial = instance([reference("long-leg", "PENDING_CONFIRMATION", "0.0004")]);
  assert.equal(canExecuteLeg(partial, "short-leg"), false);
  assert.equal(canReconcileLeg(partial, "long-leg"), true);
  const confirmed = instance([reference("long-leg", "CONFIRMED", "0.001")]);
  assert.equal(canExecuteLeg(confirmed, "long-leg"), false);
  assert.equal(canExecuteLeg(confirmed, "short-leg"), true);
});

test("pending and unknown legs render a Chinese reconciliation action and latest checked time", () => {
  const pending = instance([reference("long-leg", "PENDING_CONFIRMATION", "0.0004")]);
  const html = renderToStaticMarkup(content(draft(true), pending));
  assert.match(html, /重新核验/u);
  assert.match(html, /最近核验时间/u);
  assert.doesNotMatch(html, /provider_response/u);
});

function content(value: ArbitrageExecutionDraft, currentInstance: ArbitrageInstance | null = null, resumeMode = false, resumeValidated = false) {
  return <ArbitrageExecutionDraftContent
    amount="20"
    draft={value}
    error=""
    executionMode="PRICE_PRIORITY"
    loading={false}
    instance={currentInstance}
    mode="NOTIONAL_USDT"
    resumeMode={resumeMode}
    resumeValidated={resumeValidated}
    onAmountChange={() => undefined}
    onCancel={() => undefined}
    onConfirm={() => undefined}
    onExecutionModeChange={() => undefined}
    onModeChange={() => undefined}
    onPlan={() => undefined}
    onReconcileLeg={() => undefined}
    validationNotice="本阶段未创建套利实例，也未提交任何订单。"
  />;
}

function dogeDraft(): ArbitrageExecutionDraft {
  const makeLeg = (role: "LONG" | "SHORT", instrumentId: string) => ({
    legId: `${role.toLowerCase()}-leg`, role, venue: "binance" as const, instrumentId,
    providerSymbol: "DOGEUSDT", side: role === "LONG" ? "buy" as const : "sell" as const,
    marketType: role === "LONG" ? "spot" as const : "perpetual" as const,
    quote: { bid: "0.2", ask: "0.21", updatedAt: 1 },
    tradingRules: { quantityStep: "1", minQuantity: "1", priceTick: "0.0001", minNotional: "5" },
    capability: { status: "AVAILABLE" as const, reasonCode: "AVAILABLE" as const },
    planning: { status: "PLANNED" as const, plan: { sizingPrice: "0.21", plannedAssetQuantity: { asset: { symbol: "DOGE" }, quantity: "72" }, estimatedNotionalUsdt: "15.12" } },
    executionAvailable: true,
  });
  return {
    opportunityId: "doge-op", sourceIdentity: "dashboard:doge-op:1", sourceSnapshotGeneratedAt: 1,
    horizonDays: 90, strategyType: "SPOT_PERPETUAL", quantityInput: { mode: "ASSET_QUANTITY", quantity: "72" },
    legs: [makeLeg("LONG", "DOGE-USDT-SPOT"), makeLeg("SHORT", "DOGE-USDT-PERP")], allLegsExecutable: true, generatedAt: 1,
  };
}

function dogeInstance(): ArbitrageInstance {
  return {
    ...instance([]), arbitrageId: "arbitrage-existing", sourcePlanId: "source-pending", status: "OPENING",
    legs: [
      { ...instance([]).legs[0], instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "72" },
      { ...instance([]).legs[1], instrumentId: "DOGE-USDT-PERP", plannedQuantity: "72" },
    ],
  };
}

function draft(allAvailable: boolean): ArbitrageExecutionDraft {
  const leg = (role: "LONG" | "SHORT", venue: "binance" | "okx") => ({
    legId: `${role.toLowerCase()}-leg`,
    role,
    venue,
    instrumentId: `BTC-USDT-${role === "LONG" ? "SPOT" : "PERP"}`,
    providerSymbol: venue === "okx" ? "BTC-USDT-SWAP" : "BTCUSDT",
    side: role === "LONG" ? "buy" as const : "sell" as const,
    marketType: role === "LONG" ? "spot" as const : "perpetual" as const,
    quote: { bid: "99999.1", ask: "100000.1", updatedAt: Date.now() },
    tradingRules: { quantityStep: "0.001", minQuantity: "0.001", priceTick: "0.1", minNotional: "5" },
    capability: venue === "binance" || allAvailable
      ? { status: "AVAILABLE" as const, reasonCode: "AVAILABLE" as const }
      : { status: "UNAVAILABLE" as const, reasonCode: "EXECUTION_CAPABILITY_NOT_IMPLEMENTED" as const },
    planning: {
      status: "PLANNED" as const,
      plan: {
        sizingPrice: role === "LONG" ? "100000.1" : "99999.1",
        plannedAssetQuantity: { asset: { symbol: "BTC" }, quantity: "0.001" },
        estimatedNotionalUsdt: "99.9991",
      },
    },
    executionAvailable: venue === "binance" || allAvailable,
  });
  return {
    opportunityId: "op-1",
    sourceIdentity: "dashboard:op-1:1",
    sourceSnapshotGeneratedAt: Date.now(),
    horizonDays: 90,
    strategyType: "SPOT_PERPETUAL",
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "20" },
    legs: [leg("LONG", "binance"), leg("SHORT", "okx")],
    allLegsExecutable: allAvailable,
    generatedAt: Date.now(),
  };
}

function instance(executionReferences: ArbitrageInstance["executionReferences"]): ArbitrageInstance {
  return {
    arbitrageId: "arbitrage-1",
    userId: "user-a",
    strategyType: "SPOT_PERPETUAL",
    sourcePlanId: "source-1",
    maxResidualBaseQuantity: "0",
    status: executionReferences.length ? "RESIDUAL" : "OPENING",
    createdAt: 1,
    openedAt: null,
    updatedAt: 1,
    closedAt: null,
    legs: [
      { legId: "long-leg", role: "LONG", venue: "binance", accountId: "account-a", instrumentId: "BTC-USDT-SPOT", plannedQuantity: "0.001", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" },
      { legId: "short-leg", role: "SHORT", venue: "binance", accountId: "account-a", instrumentId: "BTC-USDT-PERP", plannedQuantity: "0.001", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" },
    ],
    executionReferences,
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}

function reference(legId: string, status: "PENDING_CONFIRMATION" | "CONFIRMED" | "UNKNOWN", confirmedQuantity: string) {
  return {
    arbitrageId: "arbitrage-1",
    legId,
    phase: "OPENING" as const,
    quantityEffect: "INCREASE" as const,
    executionIntentId: `intent-${legId}`,
    executionRecordId: `record-${legId}`,
    requestedQuantity: "0.001",
    confirmedQuantity,
    status,
    createdAt: 1,
    updatedAt: 1,
  };
}
