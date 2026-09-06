import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArbitrageMarketTable } from "./ArbitrageMarketTable";
import type { ArbitrageMarket } from "../model/types";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const market = (id: string, overrides: Partial<ArbitrageMarket> = {}) => ({ id, asset: "XAU", kind: "perpetual", venue: "binance", quoteAsset: "USDT", settlementAsset: "USDT", symbol: "XAUUSDT", status: "connected", indexPrice: 2500, markPrice: 9999, fundingRate: 0, fundingIntervalHours: 8, ...overrides }) as ArbitrageMarket;
const render = (markets: ArbitrageMarket[]) => renderToStaticMarkup(<ArbitrageMarketTable markets={markets} />);

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

test("uses existing spot prices and keeps missing or disconnected prices unavailable", () => {
  const html = render([market("a", { kind: "spot", markPrice: 12.34, indexPrice: 7777 }), market("b", { status: "disconnected", markPrice: 8888 }), market("d", { asset: "BTC", markPrice: null, indexPrice: 7777 })]);
  assert.match(html, /12\.34/);
  assert.doesNotMatch(html, /7777|7,777|8888|8,888/);
  assert.match(render([market("c", { venue: "tradexyz" })]), /没有符合筛选条件的市场/);
});
