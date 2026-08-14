import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { requireArbitrageInstanceList } from "../../../api/arbitrageInstances";
import {
  ArbitrageInstanceContent,
  ArbitrageInstanceSections,
  loadVerifications,
  maskAccountId,
  statusLabel,
  verificationStatusLabel,
} from "./ArbitrageInstanceOverview";

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

test("matched Binance perpetual leg exposes the minimal controlled close entry while Spot/other venues stay unavailable", () => {
  const [active] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const html = renderToStaticMarkup(
    <ArbitrageInstanceSections
      active={[active!]}
      history={[]}
      onCloseLeg={() => undefined}
      onPageChange={() => undefined}
      page={1}
      verifications={{
        [active!.arbitrageId]: {
          status: "success",
          verification: {
            arbitrageId: active!.arbitrageId,
            checkedAt: 1_800_000_004_000,
            legs: [
              { arbitrageId: active!.arbitrageId, legId: "long-leg", expectedManagedQuantity: "1", actualQuantity: "1", verificationStatus: "MATCHED", checkedAt: 1_800_000_004_000 },
              { arbitrageId: active!.arbitrageId, legId: "short-leg", expectedManagedQuantity: "1", actualQuantity: "1", verificationStatus: "MATCHED", checkedAt: 1_800_000_004_000 },
            ],
          },
        },
      }}
    />,
  );
  assert.match(html, /OKX[\s\S]*退出该腿/u);
  assert.equal((html.match(/退出该腿/gu) ?? []).length, 1);
});

test("matched Binance Spot LONG with reliable available balance exposes the same close entry", () => {
  const [parsed] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const active = {
    ...parsed!,
    strategyType: "SPOT_PERPETUAL" as const,
    legs: [
      { ...parsed!.legs[0], venue: "binance" as const, instrumentId: "BTC-USDT-SPOT" },
      parsed!.legs[1],
    ] as typeof parsed.legs,
  };
  const html = renderToStaticMarkup(
    <ArbitrageInstanceSections
      active={[active]}
      history={[]}
      onCloseLeg={() => undefined}
      onPageChange={() => undefined}
      page={1}
      verifications={{
        [active.arbitrageId]: {
          status: "success",
          verification: {
            arbitrageId: active.arbitrageId,
            checkedAt: 1_800_000_004_000,
            legs: [
              { arbitrageId: active.arbitrageId, legId: "long-leg", expectedManagedQuantity: "1", actualQuantity: "1", availableQuantity: "1", verificationStatus: "MATCHED", checkedAt: 1_800_000_004_000 },
              { arbitrageId: active.arbitrageId, legId: "short-leg", expectedManagedQuantity: "1", actualQuantity: "1", availableQuantity: null, verificationStatus: "MATCHED", checkedAt: 1_800_000_004_000 },
            ],
          },
        },
      }}
    />,
  );
  assert.equal((html.match(/退出该腿/gu) ?? []).length, 2);
  assert.doesNotMatch(html, /现货退出尚未接入/u);
  const dialogSource = readFileSync(new URL("./ArbitrageLegCloseDialog.tsx", import.meta.url), "utf8");
  assert.match(dialogSource, /当前实际可用数量/u);
  assert.match(dialogSource, /verification\.availableQuantity/u);
  assert.match(dialogSource, /现货不使用只减仓参数/u);
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
