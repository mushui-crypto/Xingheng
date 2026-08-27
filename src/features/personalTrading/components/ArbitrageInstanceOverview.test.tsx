import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { requireArbitrageInstanceList, type ArbitrageCloseSafety, type ArbitrageInstance, type InstanceHedgeDelta } from "../../../api/arbitrageInstances";
import {
  ArbitrageInstanceContent,
  ArbitrageInstanceSections,
  loadVerifications,
  maskAccountId,
  hedgeExitSummary,
  canonicalBaseAsset,
  InstanceDeltaPanel,
  instanceExitAvailability,
  canResumeOpeningWorkflow,
  legActionAvailability,
  managementEndMethodLabel,
  ManagementHistory,
  reconcileArbitrageHedge,
  statusLabel,
  updateInstanceSections,
  unresolvedClosingReference,
  verificationStatusLabel,
  type VerificationState,
} from "./ArbitrageInstanceOverview";
import { persistedExitProgress, remainingActiveManaged } from "./ArbitrageHedgeExitDialog";
import { compareUnsignedDecimals } from "./ArbitrageLegCloseDialog";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("current and history sections render every lifecycle status in Chinese", () => {
  const active = requireArbitrageInstanceList([
    arbitrageInstance("OPENING"),
    arbitrageInstance("HOLDING"),
    arbitrageInstance("RESIDUAL"),
    arbitrageInstance("CLOSING"),
  ]);
  const history = requireArbitrageInstanceList([
    arbitrageInstance("CLOSED"),
    arbitrageInstance("FAILED"),
  ]);
  const activeHtml = renderToStaticMarkup(
    <ArbitrageInstanceSections active={active} history={history} onPageChange={() => undefined} page={1} />,
  );
  const historyHtml = renderToStaticMarkup(
    <ArbitrageInstanceSections active={active} history={history} onPageChange={() => undefined} page={1} selectedSection="history" />,
  );
  const html = `${activeHtml}${historyHtml}`;

  for (const label of ["建仓中", "持有中", "存在残余", "退出中", "实例管理已结束", "失败"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /当前套利/);
  assert.match(html, /历史记录/);
  assert.match(html, /多头腿/);
  assert.match(html, /空头腿/);
  assert.doesNotMatch(html, /PERPETUAL_PERPETUAL|OPENING|HOLDING|RESIDUAL|CLOSING|CLOSED|FAILED/u);
  assert.doesNotMatch(html, /okx:private-account-1234|binance:private-account-5678/u);
  assert.doesNotMatch(html, /收益|APR|APY|当前价格/u);
  assert.equal((activeHtml.match(/继续开仓/gu) ?? []).length, 1);
  assert.match(activeHtml, /href="\/app\/arbitrage\?resumeArbitrageId=arbitrage-opening"/u);
  assert.doesNotMatch(historyHtml, /继续开仓/u);
});

test("only OPENING instances expose the resume action", () => {
  const active = requireArbitrageInstanceList([
    arbitrageInstance("HOLDING"),
    arbitrageInstance("RESIDUAL"),
    arbitrageInstance("CLOSING"),
  ]);
  const html = renderToStaticMarkup(<ArbitrageInstanceSections active={active} history={[]} onPageChange={() => undefined} page={1} />);
  assert.doesNotMatch(html, /继续开仓|resumeArbitrageId/u);
});

test("a RESIDUAL instance with only one terminal-partial opening remains reachable for explicit recovery", () => {
  const [base] = requireArbitrageInstanceList([arbitrageInstance("RESIDUAL")]);
  const partial = { ...base!, executionReferences: [{
    arbitrageId: base!.arbitrageId, legId: base!.legs[0].legId, phase: "OPENING" as const,
    quantityEffect: "INCREASE" as const, executionIntentId: "partial-first", executionRecordId: "partial-record",
    requestedQuantity: "100", confirmedQuantity: "40", status: "FAILED" as const, createdAt: 1, updatedAt: 2,
  }] };
  assert.equal(canResumeOpeningWorkflow(partial), true);
});

test("active legs render matched, mismatch, unknown and null quantities without mixing legs", () => {
  const [active] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const html = renderToStaticMarkup(
    <ArbitrageInstanceSections
      active={[active!]}
      history={[]}
      onPageChange={() => undefined}
      page={1}
      verifications={{
        [active!.arbitrageId]: {
          status: "success",
          verification: {
            arbitrageId: active!.arbitrageId,
            checkedAt: 1_800_000_004_000,
            legs: [
              { arbitrageId: active!.arbitrageId, legId: "short-leg", expectedManagedQuantity: "2", actualQuantity: null, verificationStatus: "UNKNOWN", checkedAt: 1_800_000_004_000 },
              { arbitrageId: active!.arbitrageId, legId: "long-leg", expectedManagedQuantity: "1", actualQuantity: "0.8", verificationStatus: "MISMATCH", checkedAt: 1_800_000_004_000 },
            ],
          },
        },
      }}
    />,
  );
  assert.match(html, /多头腿[\s\S]*系统管理数量[\s\S]*1[\s\S]*交易所真实数量[\s\S]*0.8[\s\S]*无法完整支持系统管理数量/u);
  assert.match(html, /空头腿[\s\S]*系统管理数量[\s\S]*2[\s\S]*交易所真实数量[\s\S]*暂无可靠数据[\s\S]*当前真实仓位暂无法可靠确认/u);
  assert.doesNotMatch(html, />0<\/dd>[\s\S]*当前真实仓位暂无法可靠确认/u);
});

test("Binance, OKX, Bybit and Bitget hide mutation entries until close safety is authoritative", () => {
  const venues = ["binance", "okx", "bybit", "bitget"] as const;
  const active = venues.map((venue) => {
    const [parsed] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
    return { ...parsed!, arbitrageId: `arbitrage-${venue}`, legs: parsed!.legs.map((leg) => ({ ...leg, venue })) as ArbitrageInstance["legs"] };
  });
  const verifications = Object.fromEntries(active.map((instance) => [instance.arbitrageId, matchedVerification(instance, "1", "1")]));
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={active}
    history={[]}
    onExitHedge={() => undefined}
    onPageChange={() => undefined}
    onReconcileHedge={() => undefined}
    page={1}
    verifications={verifications}
  />);

  assert.equal((html.match(/>完整退出</gu) ?? []).length, 0);
  assert.equal((html.match(/>重新核验</gu) ?? []).length, 4);
  assert.doesNotMatch(html, /退出该腿|重新核验退出/u);
});

test("the browser submits one instance command and renders persisted two-leg progress", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const source = readFileSync(new URL("./ArbitrageHedgeExitDialog.tsx", import.meta.url), "utf8");
  assert.deepEqual(persistedExitProgress(instance!), ["○ 空头永续腿等待退出", "○ 多头永续腿等待退出"]);
  assert.match(source, /exitArbitrageInstance/u);
  assert.match(source, /正在退出对冲/u);
  assert.match(source, /已退出/u);
  assert.match(source, /确认中/u);
  assert.match(source, /系统将关闭所有可交易数量/u);
  assert.match(source, /小额残余不会记为交易成交/u);
  assert.doesNotMatch(source, /closeArbitrageExecutionLeg|\.closeLeg\(|legId:|quantity:|UnifiedRealTradingTest|Provider/u);
  const polling = source.slice(source.indexOf("setInterval"), source.indexOf("const submit"));
  assert.match(polling, /fetchArbitrageInstanceById/u);
  assert.doesNotMatch(polling, /exitArbitrageInstance|closeArbitrageExecutionLeg|placeOrder/u);
  assert.match(source, /controller\.abort\(\);[\s\S]*clearInterval\(timer\)/u);
  const overview = readFileSync(new URL("./ArbitrageInstanceOverview.tsx", import.meta.url), "utf8");
  const legActions = overview.slice(overview.indexOf("function LegCloseActions"), overview.indexOf("export function legActionAvailability"));
  const instanceActions = overview.slice(overview.indexOf("function HedgeExitActions"), overview.indexOf("export function hedgeExitSummary"));
  assert.doesNotMatch(legActions, /完整退出/u);
  assert.match(instanceActions, /完整退出/u);
});

test("exit partial progress preserves and displays remaining Active Managed", () => {
  const [current] = requireArbitrageInstanceList([arbitrageInstance("CLOSING")]);
  const partial = { ...current!, legs: [
    { ...current!.legs[0], confirmedOpenedQuantity: "100", confirmedClosedQuantity: "70" },
    { ...current!.legs[1], confirmedOpenedQuantity: "100", confirmedClosedQuantity: "100" },
  ] as ArbitrageInstance["legs"] };
  assert.equal(remainingActiveManaged(partial), "30");
});

test("arbitrage records do not expose order cancellation controls", () => {
  const [parsed] = requireArbitrageInstanceList([arbitrageInstance("OPENING")]);
  const active = {
    ...parsed!,
    executionReferences: [{
      arbitrageId: parsed!.arbitrageId,
      legId: "long-leg",
      phase: "OPENING" as const,
      quantityEffect: "INCREASE" as const,
      executionIntentId: "intent-active",
      executionRecordId: "record-active",
      requestedQuantity: "1",
      confirmedQuantity: "0.25",
      status: "PENDING_CONFIRMATION" as const,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_100,
    }, {
      arbitrageId: parsed!.arbitrageId,
      legId: "short-leg",
      phase: "OPENING" as const,
      quantityEffect: "INCREASE" as const,
      executionIntentId: "intent-terminal",
      executionRecordId: "record-terminal",
      requestedQuantity: "1",
      confirmedQuantity: "1",
      status: "CONFIRMED" as const,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_100,
    }],
  };
  const current = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[active]}
    history={[]}
    onPageChange={() => undefined}
    page={1}
  />);
  const history = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[]}
    history={[{ ...active, status: "FAILED" as const }]}
    onPageChange={() => undefined}
    page={1}
    selectedSection="history"
  />);
  assert.doesNotMatch(current, /撤销订单/u);
  assert.doesNotMatch(history, /撤销订单/u);
});

test("reopening restores two-leg exit progress from persisted execution references", () => {
  const venues = ["binance", "okx", "bybit", "bitget"] as const;
  const active = venues.map((venue, index) => {
    const [parsed] = requireArbitrageInstanceList([arbitrageInstance("CLOSING")]);
    const legs: ArbitrageInstance["legs"] = [
      { ...parsed!.legs[0], venue },
      parsed!.legs[1],
    ];
    const instance: ArbitrageInstance = {
      ...parsed!,
      arbitrageId: `arbitrage-recovery-${venue}`,
      legs,
      executionReferences: [{
        arbitrageId: `arbitrage-recovery-${venue}`,
        legId: "long-leg",
        phase: "CLOSING" as const,
        quantityEffect: "DECREASE" as const,
        executionIntentId: `close-${venue}`,
        executionRecordId: `record-long-${venue}`,
        requestedQuantity: "0.9",
        confirmedQuantity: "0.9",
        status: "CONFIRMED" as const,
        createdAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_100,
      }, {
        arbitrageId: `arbitrage-recovery-${venue}`,
        legId: "short-leg",
        phase: "CLOSING" as const,
        quantityEffect: "DECREASE" as const,
        executionIntentId: `close-short-${venue}`,
        executionRecordId: index === 0 ? null : `record-short-${venue}`,
        requestedQuantity: "1",
        confirmedQuantity: "0",
        status: (["CLAIMED", "LINKED", "PENDING_CONFIRMATION", "UNKNOWN"] as const)[index]!,
        createdAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_200,
      }],
    };
    assert.equal(unresolvedClosingReference(instance, "short-leg")?.executionIntentId, `close-short-${venue}`);
    return instance;
  });
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={active}
    history={[]}
    onExitHedge={() => undefined}
    onPageChange={() => undefined}
    onReconcileHedge={() => undefined}
    page={1}
  />);

  assert.equal((html.match(/✓ 多头永续腿已退出/gu) ?? []).length, 4);
  assert.equal((html.match(/○ 空头永续腿确认中/gu) ?? []).length, 4);
  assert.equal((html.match(/>重新核验</gu) ?? []).length, 4);
  assert.doesNotMatch(html, /退出该腿|重新核验退出/u);
});

test("active managed lifecycle wins over flat Account Reality", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("CLOSING")]);
  const flatReality = {
    status: "success" as const,
    verification: {
      arbitrageId: instance!.arbitrageId,
      checkedAt: 1_800_000_004_000,
      legs: instance!.legs.map((leg) => ({
        arbitrageId: instance!.arbitrageId,
        legId: leg.legId,
        expectedManagedQuantity: "1",
        actualQuantity: "0",
        verificationStatus: "MISMATCH" as const,
        checkedAt: 1_800_000_004_000,
      })) as [{
        arbitrageId: string; legId: string; expectedManagedQuantity: string; actualQuantity: string;
        verificationStatus: "MISMATCH"; checkedAt: number;
      }, {
        arbitrageId: string; legId: string; expectedManagedQuantity: string; actualQuantity: string;
        verificationStatus: "MISMATCH"; checkedAt: number;
      }],
    },
  };
  const active = hedgeExitSummary(instance!, flatReality);
  const normal = hedgeExitSummary(instance!, matchedVerification(instance!, "1", "1"));
  const unknown = hedgeExitSummary(instance!, {
    status: "success",
    verification: {
      ...matchedVerification(instance!, "0", "0").verification,
      legs: [
        { ...matchedVerification(instance!, "0", "0").verification.legs[0], actualQuantity: null, verificationStatus: "UNKNOWN" },
        matchedVerification(instance!, "0", "0").verification.legs[1],
      ],
    },
  });

  assert.equal(active.kind, "remaining");
  assert.equal(active.label, "当前真实仓位已无法完整支持系统管理数量");
  assert.equal(active.details.every((detail) => detail.endsWith("交易所真实数量 0")), true);
  assert.doesNotMatch(`${active.label} ${active.details.join(" ")}`, /对冲已结束|剩余/u);
  assert.equal(normal.label, "实例仍在管理");
  assert.equal(unknown.label, "当前真实仓位暂无法可靠确认");
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[instance!]}
    history={[]}
    onExitHedge={() => undefined}
    onPageChange={() => undefined}
    onReconcileHedge={() => undefined}
    page={1}
    verifications={{ [instance!.arbitrageId]: flatReality }}
  />);
  assert.match(html, />重新核验</u);
  assert.doesNotMatch(html, />完整退出|>安全部分退出|>停止管理/u);
  assert.doesNotMatch(html, /对冲已结束/u);
  const overviewSource = readFileSync(new URL("./ArbitrageInstanceOverview.tsx", import.meta.url), "utf8");
  assert.match(overviewSource, /fetchArbitragePositionVerification/u);
  assert.match(overviewSource, /reconcileArbitrageInstance/u);
  assert.doesNotMatch(overviewSource, /reconcileArbitrageExecutionLeg/u);
  assert.doesNotMatch(overviewSource, /onReconcileLeg|重新核验退出/u);
});

test("persisted CLOSED status wins over accepted residual and unrelated account dust", () => {
  const [parsed] = requireArbitrageInstanceList([arbitrageInstance("CLOSED")]);
  const instance = { ...parsed!, maxResidualBaseQuantity: "0.006" };
  const state = matchedVerification(instance, "0.011", "0");

  const summary = hedgeExitSummary(instance, state);
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[instance]}
    history={[]}
    onExitHedge={() => undefined}
    onPageChange={() => undefined}
    onReconcileHedge={() => undefined}
    page={1}
    verifications={{ [instance.arbitrageId]: state }}
  />);

  assert.equal(summary.kind, "ended");
  assert.equal(summary.label, "实例管理已结束");
  assert.match(html, /实例管理已结束/u);
  assert.doesNotMatch(html, />退出对冲<|>重新核验</u);
});

test("refresh recovery keeps the not-yet-started second leg visible in exit progress", () => {
  const [parsed] = requireArbitrageInstanceList([arbitrageInstance("CLOSING")]);
  const instance: ArbitrageInstance = {
    ...parsed!,
    executionReferences: [{
      arbitrageId: parsed!.arbitrageId,
      legId: "short-leg",
      phase: "CLOSING",
      quantityEffect: "DECREASE",
      executionIntentId: "close-short",
      executionRecordId: "record-short",
      requestedQuantity: "1",
      confirmedQuantity: "1",
      status: "CONFIRMED",
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_100,
    }],
  };

  assert.deepEqual(hedgeExitSummary(instance, matchedVerification(instance, "1", "0")).progress, [
    "○ 多头永续腿等待退出",
    "✓ 空头永续腿已退出",
  ]);
});

test("one reconciliation action restores persisted references and verifies both positions once", async () => {
  const [parsed] = requireArbitrageInstanceList([arbitrageInstance("CLOSING")]);
  const references = parsed!.legs.map((leg, index) => ({
    arbitrageId: parsed!.arbitrageId,
    legId: leg.legId,
    phase: "CLOSING" as const,
    quantityEffect: "DECREASE" as const,
    executionIntentId: `close-${leg.legId}`,
    executionRecordId: `record-${leg.legId}`,
    requestedQuantity: "1",
    confirmedQuantity: "0",
    status: (index === 0 ? "PENDING_CONFIRMATION" : "UNKNOWN") as "PENDING_CONFIRMATION" | "UNKNOWN",
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_100,
  }));
  const current: ArbitrageInstance = { ...parsed!, executionReferences: references };
  const calls: string[] = [];
  const result = await reconcileArbitrageHedge(
    current,
    async (arbitrageId) => {
      calls.push(arbitrageId);
      return { instance: current, verification: matchedVerification(current, "0", "0").verification };
    },
  );

  assert.deepEqual(calls, [current.arbitrageId]);
  assert.equal(result.verification.legs.every((leg) => leg.actualQuantity === "0"), true);
});

test("history renders confirmed quantities without live verification fields", () => {
  const [history] = requireArbitrageInstanceList([arbitrageInstance("CLOSED")]);
  const html = renderToStaticMarkup(<ArbitrageInstanceSections active={[]} history={[history!]} onPageChange={() => undefined} page={1} selectedSection="history" />);
  assert.match(html, /已确认开仓数量/);
  assert.match(html, /正常确认退出数量/);
  assert.match(html, /管理结束时间/u);
  assert.doesNotMatch(html, /关闭时间|交易所真实数量|仓位一致|暂无法确认/u);
});

test("verification status labels are factual Chinese descriptions", () => {
  assert.deepEqual([
    verificationStatusLabel("MATCHED"),
    verificationStatusLabel("MISMATCH"),
    verificationStatusLabel("UNKNOWN"),
  ], [
    "当前仓位关系正常",
    "当前真实仓位已无法完整支持系统管理数量",
    "当前真实仓位暂无法可靠确认",
  ]);
});

test("a terminal update immediately moves an instance from active to history", () => {
  const [active] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const [closed] = requireArbitrageInstanceList([arbitrageInstance("CLOSED")]);
  const next = updateInstanceSections({ status: "success", active: [active!], history: [] }, {
    ...closed!,
    arbitrageId: active!.arbitrageId,
  });

  assert.deepEqual(next.active, []);
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0]?.status, "CLOSED");
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={next.active}
    history={next.history}
    onPageChange={() => undefined}
    page={1}
    selectedSection="history"
  />);
  assert.match(html, /实例管理已结束/u);
  assert.match(html, /管理结束时间/u);
});

test("leg close dialog uses the same verification and lifecycle wording", () => {
  const source = readFileSync(new URL("./ArbitrageLegCloseDialog.tsx", import.meta.url), "utf8");
  assert.match(source, /交易所真实数量/u);
  assert.match(source, /当前仓位关系正常/u);
  assert.match(source, /当前真实仓位已无法完整支持系统管理数量/u);
  assert.match(source, /当前真实仓位暂无法可靠确认/u);
  assert.match(source, /实例管理已结束/u);
  assert.doesNotMatch(source, /仓位一致|当前真实数量|CLOSED: "已关闭"/u);
});

test("verification requests only active ids and isolates a single failure", async () => {
  const active = requireArbitrageInstanceList([arbitrageInstance("OPENING"), arbitrageInstance("HOLDING")]);
  const requested: string[] = [];
  const states: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    if (String(input).includes("opening")) return new Response("unavailable", { status: 503 });
    return Response.json(verificationPayload("arbitrage-holding"));
  };
  try {
    await loadVerifications(active, new AbortController().signal, (id, state) => states.push(`${id}:${state.status}`));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requested.sort(), [
    "/api/arbitrage-instances/arbitrage-holding/verification",
    "/api/arbitrage-instances/arbitrage-opening/verification",
  ]);
  assert.deepEqual(states.sort(), ["arbitrage-holding:success", "arbitrage-opening:error"]);
});

test("empty and failed states use stable Chinese product messages", () => {
  const empty = renderToStaticMarkup(
    <ArbitrageInstanceSections active={[]} history={[]} onPageChange={() => undefined} page={1} />,
  );
  const emptyHistory = renderToStaticMarkup(
    <ArbitrageInstanceSections active={[]} history={[]} onPageChange={() => undefined} page={1} selectedSection="history" />,
  );
  const failed = renderToStaticMarkup(
    <ArbitrageInstanceContent onPageChange={() => undefined} page={1} state={{ status: "error" }} />,
  );

  assert.match(empty, /暂无当前套利组合/);
  assert.match(emptyHistory, /暂无历史套利记录/);
  assert.match(failed, /套利组合加载失败，请稍后重试/);
  assert.doesNotMatch(failed, /500|Internal Server|arbitrage_instance_query_failed/u);
});

test("status and account presentation do not expose internal enums or full account ids", () => {
  assert.deepEqual([
    statusLabel("OPENING"),
    statusLabel("HOLDING"),
    statusLabel("RESIDUAL"),
    statusLabel("CLOSING"),
    statusLabel("CLOSED"),
    statusLabel("FAILED"),
  ], ["建仓中", "持有中", "存在残余", "退出中", "实例管理已结束", "失败"]);
  assert.equal(maskAccountId("binance:private-account-5678"), "bina…5678");
  assert.equal(maskAccountId("short"), "••••");
});

test("my arbitrage page keeps the account area and adds the query-backed combination area", () => {
  const source = readFileSync(new URL("../../../pages/app/PersonalTradingPage.tsx", import.meta.url), "utf8");
  assert.match(source, /<AccountReadOverview/u);
  assert.match(source, /<ArbitrageInstanceOverview \/>/u);
  assert.match(source, /px-4 py-5 md:px-8 md:py-7/u);
  assert.doesNotMatch(source, /Position|OrderHistory|FundingRate|BinanceTradingWorkbench/u);
});

test("authoritative close safety controls full close, partial close, release, and UNKNOWN fail-closed", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const matched = matchedVerification(instance!, "1", "1");
  const mismatch: VerificationState = {
    ...matched,
    verification: {
      ...matched.verification,
      legs: [
        { ...matched.verification.legs[0], verificationStatus: "MISMATCH" },
        { ...matched.verification.legs[1], verificationStatus: "MISMATCH" },
      ],
    },
  };
  const full = closeSafety({ fullManagedCloseAvailable: true, safeClosableQuantity: "1", releaseEligible: false });
  const partial = closeSafety({ safeClosableQuantity: "0.25", releaseEligible: true });
  const dust = closeSafety({ safeClosableQuantity: "0.94", reason: "QUANTITY_STEP_DUST", releaseEligible: true });
  const unavailable = closeSafety({ safeClosableQuantity: "0", releaseEligible: true });
  const unknown = closeSafety({ realityReliable: false, reason: "PROVIDER_REALITY_UNAVAILABLE", safeClosableQuantity: "0", releaseEligible: false });

  assert.equal(instanceExitAvailability(instance!, matched, { "long-leg": full, "short-leg": full }), true);
  assert.equal(instanceExitAvailability(instance!, matched, { "long-leg": partial, "short-leg": full }), false);
  assert.equal(instanceExitAvailability(instance!, matched, { "long-leg": dust, "short-leg": full }), true);
  assert.deepEqual(legActionAvailability("MISMATCH", partial), { partialClose: true, release: true });
  assert.deepEqual(legActionAvailability("MISMATCH", unavailable), { partialClose: false, release: true });
  assert.deepEqual(legActionAvailability("UNKNOWN", unknown), { partialClose: false, release: false });
  assert.equal(instanceExitAvailability({
    ...instance!,
    executionReferences: [{
      arbitrageId: instance!.arbitrageId,
      executionIntentId: "pending-opening",
      executionRecordId: "pending-record",
      legId: "long-leg",
      phase: "OPENING",
      quantityEffect: "INCREASE",
      requestedQuantity: "1",
      confirmedQuantity: "0",
      status: "UNKNOWN",
      createdAt: 1_800_000_000_021,
      updatedAt: 1_800_000_000_022,
    }],
  }, matched, { "long-leg": full, "short-leg": full }), false);
  assert.equal(instanceExitAvailability(instance!, mismatch, { "long-leg": full, "short-leg": full }), true);
  assert.equal(instanceExitAvailability(instance!, {
    ...matched,
    verification: { ...matched.verification, legs: [{ ...matched.verification.legs[0], verificationStatus: "UNKNOWN" }, matched.verification.legs[1]] },
  }, { "long-leg": full, "short-leg": full }), false);
});

test("partial close quantity comparison remains exact for decimal strings", () => {
  assert.equal(compareUnsignedDecimals("0.200000000000000001", "0.2"), 1);
  assert.equal(compareUnsignedDecimals("100000000000000000000", "99999999999999999999.9"), 1);
  assert.equal(compareUnsignedDecimals("0.100", "0.1"), 0);
  const source = readFileSync(new URL("./ArbitrageLegCloseDialog.tsx", import.meta.url), "utf8");
  assert.match(source, /safeClosableQuantity/u);
  assert.doesNotMatch(source, /parseFloat|Number\(/u);
});

test("management history distinguishes normal close, release, and mixed management endings", () => {
  const [closed] = requireArbitrageInstanceList([arbitrageInstance("CLOSED")]);
  const release = managementReleasePayload(closed!.arbitrageId, "long-leg", "0.4");
  const released = { ...closed!, managementReleases: [release], executionReferences: [] };
  const mixed = {
    ...released,
    executionReferences: [{
      arbitrageId: closed!.arbitrageId, legId: "long-leg", phase: "CLOSING" as const, quantityEffect: "DECREASE" as const,
      executionIntentId: "close-1", executionRecordId: "record-1", requestedQuantity: "0.6", confirmedQuantity: "0.6",
      status: "CONFIRMED" as const, createdAt: 1_800_000_002_000, updatedAt: 1_800_000_002_100,
    }],
  };
  const releasedHtml = renderToStaticMarkup(<ManagementHistory instance={released} />);
  const mixedHtml = renderToStaticMarkup(<ArbitrageInstanceSections active={[]} history={[mixed]} onPageChange={() => undefined} page={1} selectedSection="history" />);

  assert.equal(managementEndMethodLabel("NORMAL_CLOSE"), "正常退出完成");
  assert.equal(managementEndMethodLabel("MANAGEMENT_RELEASE"), "用户确认停止管理");
  assert.equal(managementEndMethodLabel("MIXED"), "部分正常退出 + 部分停止管理");
  assert.match(releasedHtml, /已停止管理数量[\s\S]*0.4[\s\S]*历史快照/u);
  assert.match(releasedHtml, /不代表 Xingheng 已执行平仓/u);
  assert.doesNotMatch(releasedHtml, /已清仓|全部仓位已平仓/u);
  assert.match(mixedHtml, /部分正常退出 \+ 部分停止管理[\s\S]*正常确认退出数量[\s\S]*已停止管理数量/u);
});

test("instance Delta UI keeps opening and active evidence independent and never turns residual into an order instruction", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const known = hedgeDelta(instance!, "KNOWN", "KNOWN");
  const activeUnknown = hedgeDelta(instance!, "KNOWN", "UNKNOWN");
  const knownHtml = renderToStaticMarkup(<InstanceDeltaPanel instance={instance!} state={{ status: "success", value: known }} />);
  const unknownHtml = renderToStaticMarkup(<InstanceDeltaPanel instance={instance!} state={{ status: "success", value: activeUnknown }} />);

  assert.equal(canonicalBaseAsset(instance!), "XAUT");
  assert.match(knownHtml, /本实例 Hedge Delta[\s\S]*本实例开仓 Delta[\s\S]*0.01 XAUT[\s\S]*当前管理 Delta[\s\S]*-0.02 XAUT/u);
  assert.match(knownHtml, /实际开仓残差[\s\S]*0.03 XAUT/u);
  assert.doesNotMatch(knownHtml, /还需下单|待补数量|一键/u);
  assert.match(unknownHtml, /本实例开仓 Delta[\s\S]*0.01 XAUT[\s\S]*当前管理 Delta[\s\S]*暂无法可靠计算/u);
  assert.doesNotMatch(unknownHtml, /当前管理 Delta[\s\S]*>0(?:\.0+)?</u);
});

test("second-leg workflow is informational and management release has an explicit no-mutation confirmation", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("OPENING")]);
  const delta = { ...hedgeDelta(instance!, "KNOWN", "KNOWN"), openingWorkflow: {
    secondLegRequired: true, secondLegExecutionEligible: null, requiredSecondLegSignedExposure: "-1",
  } };
  const html = renderToStaticMarkup(<InstanceDeltaPanel instance={instance!} state={{ status: "success", value: delta }} />);
  const releaseSource = readFileSync(new URL("./ArbitrageManagementReleaseDialog.tsx", import.meta.url), "utf8");
  assert.match(html, /第二腿尚待执行[\s\S]*理论所需对冲暴露/u);
  assert.doesNotMatch(html, /执行第二腿|补单/u);
  assert.match(releaseSource, /不会向交易所提交平仓订单/u);
  assert.match(releaseSource, /历史 execution 记录不会修改/u);
  assert.match(releaseSource, /releaseEligible/u);
  assert.doesNotMatch(releaseSource, /releasedQuantity.*input|quantity.*input/u);
});

function arbitrageInstance(status: string) {
  const terminal = status === "CLOSED" || status === "FAILED";
  return {
    arbitrageId: `arbitrage-${status.toLowerCase()}`,
    userId: "user-a",
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0.001",
    status,
    createdAt: 1_800_000_000_000,
    openedAt: status === "OPENING" || status === "FAILED" ? null : 1_800_000_001_000,
    updatedAt: 1_800_000_002_000,
    closedAt: terminal ? 1_800_000_003_000 : null,
    legs: [
      {
        legId: "long-leg",
        role: "LONG",
        venue: "okx",
        accountId: "okx:private-account-1234",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
        confirmedOpenedQuantity: "1",
        confirmedClosedQuantity: terminal ? "1" : "0",
      },
      {
        legId: "short-leg",
        role: "SHORT",
        venue: "binance",
        accountId: "binance:private-account-5678",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
        confirmedOpenedQuantity: "1",
        confirmedClosedQuantity: terminal ? "1" : "0",
      },
    ],
    executionReferences: [],
    pnl: {
      asset: null,
      cumulativeFundingPnl: null,
      realizedTradingPnl: null,
      feesCosts: null,
      cumulativeNetPnl: null,
      updatedAt: null,
    },
  };
}

function verificationPayload(arbitrageId: string) {
  return {
    arbitrageId,
    checkedAt: 1_800_000_004_000,
    legs: [
      { arbitrageId, legId: "long-leg", expectedManagedQuantity: "1", actualQuantity: "1", verificationStatus: "MATCHED", checkedAt: 1_800_000_004_000 },
      { arbitrageId, legId: "short-leg", expectedManagedQuantity: "1", actualQuantity: "1", verificationStatus: "MATCHED", checkedAt: 1_800_000_004_000 },
    ],
  };
}

function matchedVerification(instance: ArbitrageInstance, longQuantity: string, shortQuantity: string) {
  return {
    status: "success" as const,
    verification: {
      arbitrageId: instance.arbitrageId,
      checkedAt: 1_800_000_004_000,
      legs: [
        { arbitrageId: instance.arbitrageId, legId: instance.legs[0].legId, expectedManagedQuantity: longQuantity, actualQuantity: longQuantity, verificationStatus: "MATCHED" as const, checkedAt: 1_800_000_004_000 },
        { arbitrageId: instance.arbitrageId, legId: instance.legs[1].legId, expectedManagedQuantity: shortQuantity, actualQuantity: shortQuantity, verificationStatus: "MATCHED" as const, checkedAt: 1_800_000_004_000 },
      ] as [
        { arbitrageId: string; legId: string; expectedManagedQuantity: string; actualQuantity: string; verificationStatus: "MATCHED"; checkedAt: number },
        { arbitrageId: string; legId: string; expectedManagedQuantity: string; actualQuantity: string; verificationStatus: "MATCHED"; checkedAt: number },
      ],
    },
  };
}

function closeSafety(overrides: Partial<ArbitrageCloseSafety> = {}): ArbitrageCloseSafety {
  return {
    activeManagedQuantity: "1",
    safeClosableQuantity: "0",
    fullManagedCloseAvailable: false,
    reason: "ONE_WAY_REALITY_INSUFFICIENT",
    checkedAt: 1_800_000_004_000,
    realityReliable: true,
    releaseEligible: false,
    hasUnresolvedExecution: false,
    releaseEligibilityReason: "RELEASE_ELIGIBLE",
    positionMode: "ONE_WAY",
    actualQuantity: "0.25",
    actualSignedNetQuantity: "0.25",
    actualLongQuantity: "0.25",
    actualShortQuantity: "0",
    availableQuantity: null,
    ...overrides,
  };
}

function managementReleasePayload(
  arbitrageId: string,
  legId: string,
  releasedQuantity: string,
): ArbitrageInstance["managementReleases"][number] {
  return {
    releaseId: "release-1",
    arbitrageId,
    legId,
    releasedQuantity,
    reason: "USER_CONFIRMED_STOP_MANAGEMENT",
    source: "AUTHENTICATED_API",
    requestedByUserId: "user-a",
    requestedAt: 1_800_000_002_500,
    confirmedAt: 1_800_000_003_000,
    venue: "okx",
    accountId: "okx:private-account-1234",
    instrumentId: "XAUT-USDT-PERP",
    positionMode: "ONE_WAY",
    actualQuantity: "0.4",
    actualSignedNetQuantity: "0.4",
    actualLongQuantity: "0.4",
    actualShortQuantity: "0",
    availableQuantity: null,
    realityCheckedAt: 1_800_000_002_900,
  };
}

function hedgeDelta(
  instance: ArbitrageInstance,
  openingStatus: "KNOWN" | "UNKNOWN",
  activeStatus: "KNOWN" | "UNKNOWN",
): InstanceHedgeDelta {
  const view = (status: "KNOWN" | "UNKNOWN", quantity: string) => ({
    status,
    signedDeltaBaseQuantity: status === "KNOWN" ? quantity : null,
    absoluteDeltaBaseQuantity: status === "KNOWN" ? quantity.replace("-", "") : null,
    reason: status === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" as const : null,
  });
  return {
    arbitrageId: instance.arbitrageId,
    status: instance.status,
    openingDelta: view(openingStatus, "0.01"),
    activeManagedDelta: view(activeStatus, "-0.02"),
    openingWorkflow: { secondLegRequired: false, secondLegExecutionEligible: null, requiredSecondLegSignedExposure: null },
    legContributions: instance.legs.map((leg) => ({
      legId: leg.legId,
      role: leg.role,
      marketType: "PERPETUAL" as const,
      signedContribution: activeStatus === "KNOWN" ? (leg.role === "LONG" ? "1" : "-1.02") : null,
      openingSignedContribution: openingStatus === "KNOWN" ? (leg.role === "LONG" ? "1" : "-0.99") : null,
      activeManagedQuantity: "1",
      source: "PERPETUAL_CONFIRMED_EXECUTION" as const,
      openingStatus,
      openingReason: openingStatus === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" as const : null,
      activeStatus,
      activeReason: activeStatus === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" as const : null,
      status: activeStatus,
      reason: activeStatus === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" as const : null,
    })) as InstanceHedgeDelta["legContributions"],
    plannedResidualDelta: "0.02",
    actualResidualDelta: "0.03",
    derivedAt: 1_800_000_004_000,
    deltaStatus: activeStatus,
    signedDeltaBaseQuantity: activeStatus === "KNOWN" ? "-0.02" : null,
    absoluteDeltaBaseQuantity: activeStatus === "KNOWN" ? "0.02" : null,
    currentOpeningDelta: openingStatus === "KNOWN" ? "0.01" : null,
    openingDeltaStatus: openingStatus,
    requiredSecondLegSignedExposure: null,
    deltaKnown: activeStatus === "KNOWN",
    reason: activeStatus === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" : null,
  };
}
