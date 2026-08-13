import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountReadRequestError, type AccountReadSnapshot } from "../../../api/accountRead";
import type { ExchangeCredentialSummary } from "../../../api/exchangeCredentials";
import { AccountDetail, AccountReadCards, type VenueState } from "./AccountReadOverview";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("account overview renders all four venue cards and isolates a venue failure", () => {
  const states: Record<AccountReadSnapshot["venue"], VenueState> = {
    binance: { status: "success", snapshot: snapshot("binance") },
    okx: { status: "error", error: new AccountReadRequestError("provider_failed", "ignored") },
    bybit: { status: "loading" },
    bitget: { status: "success", snapshot: snapshot("bitget") },
  };
  const html = renderToStaticMarkup(<AccountReadCards onConfigure={() => undefined} onDelete={() => undefined} onOpen={() => undefined} states={states} summaries={summaries()} />);

  for (const label of ["Binance", "OKX", "Bybit", "Bitget"]) assert.match(html, new RegExp(label));
  assert.match(html, /账户读取失败/);
  assert.match(html, /Binance[\s\S]*已连接/);
  assert.match(html, /预估总资产/);
  assert.match(html, /Bitget[\s\S]*暂无估值/);
  assert.doesNotMatch(html, /凭证验证|账户模式/u);
});

test("unconfigured cards guide API setup while configured cards expose a more menu", () => {
  const states: Record<AccountReadSnapshot["venue"], VenueState> = {
    binance: { status: "success", snapshot: snapshot("binance") },
    okx: { status: "error", error: new AccountReadRequestError("unavailable", "ignored") },
    bybit: { status: "loading" },
    bitget: { status: "loading" },
  };
  const items = summaries().map((item) => item.venue === "okx" ? { ...item, configured: false } : item);
  const html = renderToStaticMarkup(<AccountReadCards onConfigure={() => undefined} onDelete={() => undefined} onOpen={() => undefined} states={states} summaries={items} />);
  assert.match(html, /OKX[\s\S]*未配置[\s\S]*配置 API[\s\S]*连接状态/u);
  assert.match(html, /Binance[\s\S]*更多账户操作/u);
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

test("account card actions use the more menu and shared modals", () => {
  const source = readFileSync(new URL("./AccountReadOverview.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-label="更多账户操作"/u);
  assert.match(source, /账户详情/u);
  assert.match(source, /删除 API 配置/u);
  assert.match(source, /配置 .* API/u);
  assert.match(source, /onClose=\{\(\) => setSelectedVenue\(null\)\}/u);
  assert.match(source, /open=\{Boolean\(selectedVenue && selectedConfigured\)\}/u);
  assert.match(source, /selectedVenue === "binance" \? <BinanceAccountDiagnostics \/>/u);
});

test("my arbitrage page uses the common account overview without stale provider messaging", () => {
  const source = readFileSync(new URL("../../../pages/app/PersonalTradingPage.tsx", import.meta.url), "utf8");
  assert.match(source, /<AccountReadOverview/u);
  assert.doesNotMatch(source, /ExchangeCredentialsPanel|CredentialOnlyVenueDetail|BinanceTradingWorkbench/u);
  assert.doesNotMatch(source, /账户读取[^\n]*尚未接入|不连接 .* 私有账户接口/u);
});

function summaries(): ExchangeCredentialSummary[] {
  return (["binance", "okx", "bybit", "bitget"] as const).map((venue) => ({
    venue, configured: true, implemented: true, accountId: `${venue}:account`, accountFingerprint: `${venue}:fingerprint`, maskedApiKey: "••••1234", permissions: {}, lastVerifiedAt: 1_800_000_000_000, message: null,
  }));
}

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
