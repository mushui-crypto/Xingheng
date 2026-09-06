import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArbitrageMarketTable } from "./ArbitrageMarketTable";
import { ArbitrageOpportunityTable } from "./ArbitrageOpportunityTable";
import type { ArbitrageMarket, ArbitrageOpportunity } from "../model/types";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const market = (id: string, overrides: Partial<ArbitrageMarket> = {}) => ({ id, asset: "XAU", kind: "perpetual", venue: "binance", quoteAsset: "USDT", settlementAsset: "USDT", symbol: "XAUUSDT", status: "connected", indexPrice: 2500, markPrice: 9999, fundingRate: 0, fundingIntervalHours: 8, ...overrides }) as ArbitrageMarket;
const render = (markets: ArbitrageMarket[]) => renderToStaticMarkup(<ArbitrageMarketTable markets={markets} />);

test("background refresh has a separate neutral page status and does not add polling", () => {
  const page = readFileSync(new URL("../../../pages/app/ArbitragePage.tsx", import.meta.url), "utf8");
  assert.match(page, /snapshot\?\.refreshState === "REFRESHING" \? <span className="text-muted" role="status">后台更新中<\/span>/);
  const polling = readFileSync(new URL("../lib/visibilityPolling.ts", import.meta.url), "utf8");
  assert.match(polling, /ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS = 25_000/);
});

test("compares the same asset and product across four venue columns with logos", () => {
  const html = render([market("a"), market("b", { venue: "okx", indexPrice: null, fundingRate: -0.0001 }), market("c", { asset: "GOLD", venue: "tradexyz" })]);
  assert.equal((html.match(/scope="col"/g) ?? []).length, 6);
  assert.equal((html.match(/scope="row"/g) ?? []).length, 1);
  assert.equal((html.match(/<img /g) ?? []).length, 4);
  assert.match(html, /0\.0000%/);
  assert.match(html, /-0\.0100%/);
  assert.match(html, /9,999/);
  assert.doesNotMatch(html, /tradeXYZ|GOLD|指数价/);
});

test("keeps gold assets, products and quote currencies distinct", () => {
  const html = render([market("a"), market("b", { asset: "XAUT" }), market("c", { asset: "PAXG" }), market("d", { kind: "spot" }), market("e", { quoteAsset: "USDC", settlementAsset: "USDC" })]);
  assert.equal((html.match(/scope="row"/g) ?? []).length, 5);
  assert.match(html, /不适用/);
  assert.match(html, /USDC/);
});

test("scan stale quotes are visibly historical and unavailable quotes are hidden", () => {
  assert.match(render([market("stale", { freshness: "STALE", sourceUpdatedAt: 1800000000000 })]), /历史数据 · 更新未完成/);
  const html = render([market("missing", { freshness: "UNAVAILABLE", markPrice: 987654 })]);
  assert.match(html, /暂无可靠数据/);
  assert.doesNotMatch(html, /987,654/);
});

test("stale opportunity replaces live recommendation and entry badges with a historical label", () => {
  const stale = {
    id: "historical", freshness: "STALE", longLeg: market("long", { venueLabel: "Binance" }),
    shortLeg: market("short", { venue: "okx", venueLabel: "OKX" }),
    recommendation: "recommended", entryStatus: "favorable", netApr: 12,
    strategyType: "cross_venue_arbitrage", matchQuality: "exact", matchLabel: "精确匹配",
  } as unknown as ArbitrageOpportunity;
  const html = renderToStaticMarkup(<ArbitrageOpportunityTable opportunities={[stale]} holdingDays={90} yieldMetric="apr" onAnalyze={() => undefined} />);
  assert.match(html, /历史机会 · 更新未完成/);
  assert.doesNotMatch(html, />当前条件满足<|>综合质量高</);
});

test("uses existing spot prices and keeps missing or disconnected prices unavailable", () => {
  const html = render([market("a", { kind: "spot", markPrice: 12.34, indexPrice: 7777 }), market("b", { status: "disconnected", markPrice: 8888 }), market("d", { asset: "BTC", markPrice: null, indexPrice: 7777 })]);
  assert.match(html, /12\.34/);
  assert.doesNotMatch(html, /7777|7,777|8888|8,888/);
  assert.match(render([market("c", { venue: "tradexyz" })]), /没有符合筛选条件的市场/);
});
