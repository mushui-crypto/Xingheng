import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountReadRequestError, type AccountReadSnapshot } from "../../../api/accountRead";
import { AccountDetail, AccountReadCards, type VenueState } from "./AccountReadOverview";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("account overview renders all four venue cards and isolates a venue failure", () => {
  const states: Record<AccountReadSnapshot["venue"], VenueState> = {
    binance: { status: "success", snapshot: snapshot("binance") },
    okx: { status: "error", error: new AccountReadRequestError("provider_failed", "ignored") },
    bybit: { status: "loading" },
    bitget: { status: "success", snapshot: snapshot("bitget") },
  };
  const html = renderToStaticMarkup(<AccountReadCards onOpen={() => undefined} states={states} />);

  for (const label of ["Binance", "OKX", "Bybit", "Bitget"]) assert.match(html, new RegExp(label));
  assert.match(html, /交易所账户读取失败/);
  assert.match(html, /Binance[\s\S]*已连接/);
  assert.match(html, /Bitget[\s\S]*暂无估值/);
});

test("account detail shows Chinese permission states and null-safe balances", () => {
  const html = renderToStaticMarkup(<AccountDetail label="Bybit" snapshot={snapshot("bybit")} />);

  assert.match(html, /只读权限/);
  assert.match(html, /无法确认/);
  assert.match(html, /暂无可靠数据/);
  assert.match(html, /暂无估值/);
  assert.doesNotMatch(html, /ENABLED|DISABLED|UNKNOWN/u);
  assert.doesNotMatch(html, /raw-user-id|api-secret|api-key/u);
});

test("account cards open details and the shared modal closes them", () => {
  const source = readFileSync(new URL("./AccountReadOverview.tsx", import.meta.url), "utf8");
  assert.match(source, /onClick=\{onOpen\}/u);
  assert.match(source, /onClose=\{\(\) => setSelectedVenue\(null\)\}/u);
  assert.match(source, /open=\{Boolean\(selectedSnapshot\)\}/u);
});

test("my arbitrage page uses the common account overview without stale provider messaging", () => {
  const source = readFileSync(new URL("../../../pages/app/PersonalTradingPage.tsx", import.meta.url), "utf8");
  assert.match(source, /<AccountReadOverview \/>/u);
  assert.doesNotMatch(source, /账户读取[^\n]*尚未接入|不连接 .* 私有账户接口/u);
  assert.match(source, /持仓、订单与执行能力本阶段未接入/u);
});

function snapshot(venue: AccountReadSnapshot["venue"]): AccountReadSnapshot {
  return {
    venue,
    accountId: `${venue}:account-hash`,
    accountFingerprint: "fingerprint-hash",
    accountTypes: ["unified"],
    accountMode: "unified_2:regular_margin",
    connection: { status: "connected", checkedAt: 1_800_000_000_000 },
    credentialValidation: { status: "validated", checkedAt: 1_800_000_000_000 },
    balances: [{
      asset: "BTC",
      accountType: "unified",
      total: 0.002,
      available: null,
      locked: 0.001,
      estimatedValueUsdt: null,
      valuationStatus: "UNAVAILABLE",
    }],
    permissions: {
      read: "UNKNOWN",
      spotTrade: "UNKNOWN",
      derivativesTrade: "UNKNOWN",
      withdraw: "UNKNOWN",
      ipRestricted: "UNKNOWN",
    },
    latestSyncAt: 1_800_000_000_000,
    estimatedTotalValueUsdt: null,
    valuationCoverage: "UNAVAILABLE",
  };
}
