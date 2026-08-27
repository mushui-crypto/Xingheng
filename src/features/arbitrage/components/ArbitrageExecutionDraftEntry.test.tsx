import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArbitrageExecutionDraft, ArbitrageHedgeWorkflow } from "../../../api/arbitrageExecutionDraft";
import {
  ArbitrageExecutionDraftContent,
  ArbitrageExecutionDraftEntry,
  StartHedgeConfirmationContent,
  canExecuteLeg,
  canReconcileLeg,
  canConfirmDraft,
  loadResumeContext,
  resumeDraftMatchesInstance,
  submitStartOnce,
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

test("server execution-mode reason is rendered without a venue-specific UI rule", () => {
  const value = draft(true);
  const blocked: ArbitrageExecutionDraft = {
    ...value,
    executionMode: "PRICE_PRIORITY",
    legs: [
      value.legs[0],
      {
        ...value.legs[1],
        capability: { status: "UNAVAILABLE", reasonCode: "EXECUTION_MODE_NOT_SUPPORTED" },
        executionAvailable: false,
      },
    ],
    allLegsExecutable: false,
  };
  const html = renderToStaticMarkup(content(blocked));
  assert.match(html, /当前执行模式暂不支持/u);
  assert.match(html, /disabled=""/u);
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

test("SPOT_PERPETUAL exposes only Spot as the first leg and unlocks Perpetual after full confirmation", () => {
  const created = instance([]);
  assert.equal(canExecuteLeg(created, "long-leg"), true);
  assert.equal(canExecuteLeg(created, "short-leg"), false);
  assert.equal(canExecuteLeg(created, "foreign-leg"), false);

  const startHtml = renderToStaticMarkup(content(draft(true), created));
  assert.equal(startHtml.match(/以此腿开始对冲/gu)?.length, 1);
  assert.match(startHtml, /aria-haspopup="dialog"/u);
  assert.match(startHtml, /永续合约腿将在现货成交后自动执行/u);

  const unknown = instance([reference("long-leg", "UNKNOWN", "0")]);
  assert.equal(canExecuteLeg(unknown, "short-leg"), false);
  const partial = instance([reference("long-leg", "PENDING_CONFIRMATION", "0.0004")]);
  assert.equal(canExecuteLeg(partial, "short-leg"), false);
  assert.equal(canReconcileLeg(partial, "long-leg"), true);
  const confirmed = instance([reference("long-leg", "CONFIRMED", "0.001")]);
  assert.equal(canExecuteLeg(confirmed, "long-leg"), false);
  assert.equal(canExecuteLeg(confirmed, "short-leg"), true);
});

test("the initial Start click only opens final confirmation and does not call the Start API", () => {
  const source = readFileSync(new URL("./ArbitrageExecutionDraftEntry.tsx", import.meta.url), "utf8");
  const requestStart = source.slice(source.indexOf("function requestStartHedge"), source.indexOf("function cancelStartHedgeConfirmation"));
  assert.match(requestStart, /setPendingStartLegId\(firstLegId\)/u);
  assert.doesNotMatch(requestStart, /startHedge\(/u);
  assert.match(source, /instance\?\.executionReferences\.length \? executeLeg\(legId\) : requestStartHedge\(legId\)/u);
});

test("cancelling final confirmation only clears local state and does not call the Start API", () => {
  const source = readFileSync(new URL("./ArbitrageExecutionDraftEntry.tsx", import.meta.url), "utf8");
  const cancelStart = source.slice(source.indexOf("function cancelStartHedgeConfirmation"), source.indexOf("async function confirmStartHedge"));
  assert.match(cancelStart, /setPendingStartLegId\(null\)/u);
  assert.doesNotMatch(cancelStart, /startHedge\(|startArbitrageHedge\(/u);
});

test("final confirmation submits Start exactly once and rejects a concurrent double submit", async () => {
  const source = readFileSync(new URL("./ArbitrageExecutionDraftEntry.tsx", import.meta.url), "utf8");
  const confirmStart = source.slice(source.indexOf("async function confirmStartHedge"), source.indexOf("async function continuePartial"));
  assert.match(confirmStart, /submitStartOnce\(startSubmissionGuard, \(\) => startHedge\(firstLegId\)\)/u);

  const guard = { current: false };
  let startApiCalls = 0;
  let releaseStart!: () => void;
  const pendingStart = new Promise<void>((resolve) => { releaseStart = resolve; });
  const submit = async () => {
    startApiCalls += 1;
    await pendingStart;
  };

  const firstClick = submitStartOnce(guard, submit);
  const secondClick = submitStartOnce(guard, submit);
  assert.equal(startApiCalls, 1);
  assert.equal(await secondClick, false);
  releaseStart();
  assert.equal(await firstClick, true);
  assert.equal(startApiCalls, 1);
});

test("final confirmation displays execution facts, real-funds warning, and automatic second-leg warning", () => {
  const source = readFileSync(new URL("./ArbitrageExecutionDraftEntry.tsx", import.meta.url), "utf8");
  assert.match(source, /title="确认开始真实对冲"/u);
  const html = renderToStaticMarkup(
    <StartHedgeConfirmationContent
      draft={dogeDraft()}
      firstLegId="long-leg"
      instance={dogeInstance()}
      onCancel={() => undefined}
      onConfirm={() => undefined}
      submitting={false}
    />,
  );
  assert.match(html, /Binance（现货） \/ Binance（永续）/u);
  assert.match(html, /DOGE-USDT-SPOT/u);
  assert.match(html, /DOGE-USDT-PERP/u);
  assert.match(html, /买入（BUY）/u);
  assert.match(html, /卖出（SELL）/u);
  assert.match(html, /72 DOGE/u);
  assert.match(html, /第一腿/u);
  assert.match(html, /现货 · Binance · DOGE-USDT-SPOT/u);
  assert.match(html, /确认后将提交真实资金订单。/u);
  assert.match(html, /第一腿完整成交并通过安全检查后，系统将自动执行第二腿。/u);
  assert.match(html, /确认开始真实对冲/u);
  assert.match(html, /取消/u);
});

test("submitting final confirmation disables both actions", () => {
  const html = renderToStaticMarkup(
    <StartHedgeConfirmationContent
      draft={dogeDraft()}
      firstLegId="long-leg"
      instance={dogeInstance()}
      onCancel={() => undefined}
      onConfirm={() => undefined}
      submitting
    />,
  );
  assert.equal(html.match(/disabled=""/gu)?.length, 2);
  assert.match(html, /正在提交/u);
});

test("pending and unknown legs render a Chinese reconciliation action and latest checked time", () => {
  const pending = instance([reference("long-leg", "PENDING_CONFIRMATION", "0.0004")]);
  const html = renderToStaticMarkup(content(draft(true), pending));
  assert.match(html, /重新核验/u);
  assert.match(html, /最近核验时间/u);
  assert.doesNotMatch(html, /provider_response/u);
});

test("terminal first partial renders high-priority risk and explicit continuation only", () => {
  const current = instance([reference("long-leg", "FAILED", "0.0004")]);
  const html = renderToStaticMarkup(content(draft(true), current, false, false, workflow("FIRST_LEG_PARTIAL", {
    riskAction: "CONTINUE_PARTIAL_HEDGE",
    confirmedQuantity: "0.0004",
  })));
  assert.match(html, /Risk Action Required/u);
  assert.match(html, /继续对冲已成交部分/u);
  assert.match(html, /planned 0\.001 · confirmed 0\.0004/u);
  assert.doesNotMatch(html, /重新开始对冲/u);
});

test("UNKNOWN and live partial never render continuation, while FAILED0 renders restart", () => {
  const unknown = renderToStaticMarkup(content(draft(true), instance([reference("long-leg", "UNKNOWN", "0")]), false, false,
    workflow("FIRST_LEG_UNKNOWN", { riskAction: "RECONCILE", confirmedQuantity: "0" })));
  assert.match(unknown, /重新核验/u);
  assert.doesNotMatch(unknown, /继续对冲已成交部分|重新开始对冲/u);

  const pending = renderToStaticMarkup(content(draft(true), instance([reference("long-leg", "PENDING_CONFIRMATION", "0.0004")]), false, false,
    workflow("FIRST_LEG_PENDING", { confirmedQuantity: "0.0004" })));
  assert.doesNotMatch(pending, /继续对冲已成交部分/u);

  const failed = renderToStaticMarkup(content(draft(true), instance([reference("long-leg", "FAILED", "0")]), false, false,
    workflow("FIRST_LEG_FAILED_ZERO", { riskAction: "RESTART_HEDGE", confirmedQuantity: "0" })));
  assert.match(failed, /第一腿未成交，对冲未建立/u);
  assert.match(failed, /重新开始对冲/u);
});

test("Start workflow polling is serial, recursive, abort-aware, and cleans up its timer", () => {
  const source = readFileSync(new URL("./ArbitrageExecutionDraftEntry.tsx", import.meta.url), "utf8");
  const effectStart = source.indexOf("if (!open || !instance) return;");
  const effectEnd = source.indexOf("async function planQuantity", effectStart);
  const polling = source.slice(effectStart, effectEnd);
  const awaitedReads = polling.indexOf("await Promise.all");
  const successTimer = polling.indexOf("setTimeout(poll, 750)");

  assert.ok(effectStart >= 0 && effectEnd > effectStart);
  assert.match(polling, /const poll = async \(\) =>/u);
  assert.doesNotMatch(polling, /setInterval/u);
  assert.ok(awaitedReads >= 0 && successTimer > awaitedReads);
  assert.match(polling, /if \(controller\.signal\.aborted\) return;/u);
  assert.match(polling, /if \(!controller\.signal\.aborted && workflowPolling\) timer = setTimeout\(poll, 1000\);/u);
  assert.match(polling, /controller\.abort\(\);[\s\S]*clearTimeout\(timer\)/u);
});

function content(
  value: ArbitrageExecutionDraft,
  currentInstance: ArbitrageInstance | null = null,
  resumeMode = false,
  resumeValidated = false,
  currentWorkflow: ArbitrageHedgeWorkflow | null = null,
) {
  return <ArbitrageExecutionDraftContent
    amount="20"
    draft={value}
    error=""
    executionMode="PRICE_PRIORITY"
    loading={false}
    instance={currentInstance}
    workflow={currentWorkflow}
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

function workflow(
  phase: ArbitrageHedgeWorkflow["phase"],
  options: { riskAction?: ArbitrageHedgeWorkflow["riskAction"]; confirmedQuantity: string },
): ArbitrageHedgeWorkflow {
  return {
    arbitrageId: "arbitrage-1", phase, requiresUserAction: options.riskAction !== undefined,
    ...(options.riskAction ? { riskAction: options.riskAction } : {}), reason: null, derivedAt: 2,
    firstLeg: { legId: "long-leg", executionIntentId: "intent-long-leg", status: phase.includes("UNKNOWN") ? "UNKNOWN"
      : phase.includes("PENDING") ? "PENDING_CONFIRMATION" : "FAILED", requestedQuantity: "0.001",
      confirmedQuantity: options.confirmedQuantity, activeManagedQuantity: options.confirmedQuantity, updatedAt: 2 },
    secondLeg: null,
  };
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
    horizonDays: 90, executionMode: "EXECUTION_PRIORITY", strategyType: "SPOT_PERPETUAL", quantityInput: { mode: "ASSET_QUANTITY", quantity: "72" },
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
    executionMode: "EXECUTION_PRIORITY",
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
    managementReleases: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}

function reference(
  legId: string,
  status: "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN",
  confirmedQuantity: string,
) {
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
