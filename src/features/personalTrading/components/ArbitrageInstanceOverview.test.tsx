import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { requireArbitrageInstanceList, type ArbitrageInstance } from "../../../api/arbitrageInstances";
import {
  ArbitrageInstanceContent,
  ArbitrageInstanceSections,
  loadVerifications,
  maskAccountId,
  hedgeExitSummary,
  reconcileArbitrageHedge,
  statusLabel,
  unresolvedClosingReference,
  verificationStatusLabel,
} from "./ArbitrageInstanceOverview";
import { persistedExitProgress } from "./ArbitrageHedgeExitDialog";

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

  for (const label of ["建仓中", "持有中", "存在残余", "退出中", "已关闭", "失败"]) {
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
  assert.match(html, /多头腿[\s\S]*系统管理数量[\s\S]*1[\s\S]*当前真实数量[\s\S]*0.8[\s\S]*管理记录存在差异/u);
  assert.match(html, /空头腿[\s\S]*系统管理数量[\s\S]*2[\s\S]*当前真实数量[\s\S]*暂无可靠数据[\s\S]*当前仓位暂无法可靠确认/u);
  assert.doesNotMatch(html, />0<\/dd>[\s\S]*当前仓位暂无法可靠确认/u);
});

test("Binance, OKX, Bybit and Bitget share one instance-level exit and reconciliation entry", () => {
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

  assert.equal((html.match(/>退出对冲</gu) ?? []).length, 4);
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
  assert.doesNotMatch(source, /closeArbitrageExecutionLeg|\.closeLeg\(|legId:|quantity:|UnifiedRealTradingTest|Provider/u);
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

test("verification maps both flat, one-sided residual and unknown states at instance level", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("CLOSING")]);
  const ended = hedgeExitSummary(instance!, matchedVerification(instance!, "0", "0"));
  const remaining = hedgeExitSummary(instance!, matchedVerification(instance!, "0.006", "0"));
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

  assert.equal(ended.label, "对冲已结束");
  assert.equal(remaining.label, "对冲尚未完全退出");
  assert.deepEqual(remaining.details, ["多头永续腿剩余 0.006"]);
  assert.equal(unknown.label, "仓位状态待确认");
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
  assert.equal(summary.label, "对冲已结束");
  assert.match(html, /对冲已结束/u);
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
  assert.match(html, /已确认关闭数量/);
  assert.doesNotMatch(html, /当前真实数量|仓位一致|暂无法确认/u);
});

test("verification status labels are factual Chinese descriptions", () => {
  assert.deepEqual([
    verificationStatusLabel("MATCHED"),
    verificationStatusLabel("MISMATCH"),
    verificationStatusLabel("UNKNOWN"),
  ], ["仓位一致", "仓位存在差异", "暂无法确认"]);
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
  ], ["建仓中", "持有中", "存在残余", "退出中", "已关闭", "失败"]);
  assert.equal(maskAccountId("binance:private-account-5678"), "bina…5678");
  assert.equal(maskAccountId("short"), "••••");
});

test("my arbitrage page keeps the account area and adds the query-backed combination area", () => {
  const source = readFileSync(new URL("../../../pages/app/PersonalTradingPage.tsx", import.meta.url), "utf8");
  assert.match(source, /<AccountReadOverview/u);
  assert.match(source, /<ArbitrageInstanceOverview \/>/u);
  assert.doesNotMatch(source, /Position|OrderHistory|FundingRate|BinanceTradingWorkbench/u);
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
