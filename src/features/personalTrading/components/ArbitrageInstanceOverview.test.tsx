import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { requireArbitrageInstanceList } from "../../../api/arbitrageInstances";
import {
  ArbitrageInstanceContent,
  ArbitrageInstanceSections,
  maskAccountId,
  statusLabel,
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
  const html = renderToStaticMarkup(
    <ArbitrageInstanceSections active={active} history={history} onPageChange={() => undefined} page={1} />,
  );

  for (const label of ["建仓中", "持有中", "存在残余", "退出中", "已关闭", "失败"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /当前套利/);
  assert.match(html, /历史套利/);
  assert.match(html, /LONG 腿/);
  assert.match(html, /SHORT 腿/);
  assert.doesNotMatch(html, /PERPETUAL_PERPETUAL|OPENING|HOLDING|RESIDUAL|CLOSING|CLOSED|FAILED/u);
  assert.doesNotMatch(html, /okx:private-account-1234|binance:private-account-5678/u);
  assert.doesNotMatch(html, /收益|APR|APY|当前价格/u);
});

test("empty and failed states use stable Chinese product messages", () => {
  const empty = renderToStaticMarkup(
    <ArbitrageInstanceSections active={[]} history={[]} onPageChange={() => undefined} page={1} />,
  );
  const failed = renderToStaticMarkup(
    <ArbitrageInstanceContent onPageChange={() => undefined} page={1} state={{ status: "error" }} />,
  );

  assert.match(empty, /暂无当前套利组合/);
  assert.match(empty, /暂无历史套利记录/);
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
  assert.match(source, /<AccountReadOverview \/>/u);
  assert.match(source, /<ArbitrageInstanceOverview \/>/u);
  assert.doesNotMatch(source, /Position|OrderHistory|FundingRate/u);
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
