import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArbitrageRawRefreshTiming, providerAndCategory } from "./ArbitrageDashboardTiming";

describe("ArbitrageDashboardTiming", () => {
  it("aggregates logical requests, retries, cumulative duration, and concurrent provider wall time", () => {
    let now = 0;
    const timing = createArbitrageRawRefreshTiming(() => now);

    const ticker = timing.startProviderRequest("binance", "ticker");
    now = 5;
    const orderbook = timing.startProviderRequest("binance", "orderbook");
    now = 10;
    ticker.success();
    now = 12;
    orderbook.retry();
    now = 20;
    orderbook.failure();

    const report = timing.report().providers.binance;
    assert.equal(report.requests, 2);
    assert.equal(report.successes, 1);
    assert.equal(report.failures, 1);
    assert.equal(report.retries, 1);
    assert.equal(report.cumulativeRequestMs, 25);
    assert.equal(report.slowestRequestMs, 15);
    assert.equal(report.wallMs, 20);
    assert.equal(report.categories.ticker, 1);
    assert.equal(report.categories.orderbook, 1);
  });

  it("keeps independent refresh contexts isolated", () => {
    let now = 0;
    const first = createArbitrageRawRefreshTiming(() => now);
    const second = createArbitrageRawRefreshTiming(() => now);

    first.orderbookHit();
    first.orderbookHit();
    second.orderbookMiss();
    second.orderbookProviderFetch();
    const request = second.startProviderRequest("bybit", "orderbook");
    now = 4;
    request.success();

    assert.deepEqual(first.report().orderbook, { hits: 2, misses: 0, forceBypasses: 0, providerFetches: 0 });
    assert.equal(first.report().providers.bybit.requests, 0);
    assert.deepEqual(second.report().orderbook, { hits: 0, misses: 1, forceBypasses: 0, providerFetches: 1 });
    assert.equal(second.report().providers.bybit.requests, 1);
  });

  it("classifies only normalized provider and request category facts", () => {
    assert.deepEqual(
      providerAndCategory("https://api.binance.com/api/v3/depth?symbol=BTCUSDT"),
      { provider: "binance", category: "orderbook" },
    );
    assert.deepEqual(
      providerAndCategory("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { Authorization: "sensitive" },
        body: JSON.stringify({ type: "fundingHistory", secret: "not-recorded" }),
      }),
      { provider: "hyperliquid", category: "fundingHistory" },
    );
  });
});
