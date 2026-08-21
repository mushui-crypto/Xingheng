import assert from "node:assert/strict";
import test from "node:test";
import { DefaultArbitrageExecutionPlanningContextSource } from "./ArbitrageExecutionPlanningContext";

test("loads Decimal read-only planning contexts for OKX, Bybit, and Bitget", async () => {
  const calls: Array<{ method: string; url: URL }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ method: String(init?.method ?? "GET"), url });
    if (url.hostname === "www.okx.com" && url.pathname === "/api/v5/public/instruments") {
      return Response.json({ code: "0", data: [{ instId: "BTC-USDT-SWAP", lotSz: "1", minSz: "1", tickSz: "0.1", ctVal: "0.01" }] });
    }
    if (url.hostname === "www.okx.com" && url.pathname === "/api/v5/market/ticker") {
      return Response.json({ code: "0", data: [{ instId: "BTC-USDT-SWAP", bidPx: "99999.123456789", askPx: "100000.123456789" }] });
    }
    if (url.hostname === "api.bybit.com" && url.pathname === "/v5/market/instruments-info") {
      return Response.json({ retCode: 0, result: { list: [{ symbol: "BTCUSDT", lotSizeFilter: { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5" }, priceFilter: { tickSize: "0.1" } }] } });
    }
    if (url.hostname === "api.bybit.com" && url.pathname === "/v5/market/tickers") {
      return Response.json({ retCode: 0, result: { list: [{ symbol: "BTCUSDT", bid1Price: "99998.123456789", ask1Price: "100001.123456789" }] } });
    }
    if (url.hostname === "api.bitget.com" && url.pathname === "/api/v3/market/instruments") {
      return Response.json({ code: "00000", data: [{ symbol: "BTCUSDT", quantityPrecision: "3", pricePrecision: "1", minTradeNum: "0.001", minTradeUSDT: "5" }] });
    }
    if (url.hostname === "api.bitget.com" && url.pathname === "/api/v3/market/tickers") {
      const category = url.searchParams.get("category");
      assert.ok(category === "SPOT" || category === "USDT-FUTURES");
      return Response.json({ code: "00000", data: [{ symbol: "BTCUSDT", bid1Price: "99997.123456789", ask1Price: "100002.123456789" }] });
    }
    return new Response(null, { status: 404 });
  };
  const source = new DefaultArbitrageExecutionPlanningContextSource(fetchFn, undefined, () => 1_800_000_000_000);

  const okx = await source.load("okx", "BTC-USDT-PERP");
  const bybit = await source.load("bybit", "BTC-USDT-PERP");
  const bitget = await source.load("bitget", "BTC-USDT-PERP");
  const bitgetSpot = await source.load("bitget", "BTC-USDT-SPOT");

  assert.equal(okx.instrument.quantityUnit, "contract");
  assert.equal(okx.tradingRules.contractSize, "0.01");
  assert.equal(okx.quote.bid, "99999.123456789");
  assert.equal(bybit.instrument.quantityUnit, "base");
  assert.equal(bybit.quote.ask, "100001.123456789");
  assert.equal(bitget.instrument.providerSymbol, "BTCUSDT");
  assert.equal(bitget.quote.bid, "99997.123456789");
  assert.equal(bitgetSpot.instrument.contractType, "spot");
  assert.equal(bitgetSpot.quote.ask, "100002.123456789");
  assert.equal(calls.length, 8);
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("fails closed when quote identity or Decimal shape is invalid", async () => {
  const source = new DefaultArbitrageExecutionPlanningContextSource(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v5/public/instruments") {
      return Response.json({ code: "0", data: [{ instId: "BTC-USDT-SWAP", lotSz: "1", minSz: "1", tickSz: "0.1", ctVal: "0.01" }] });
    }
    return Response.json({ code: "0", data: [{ instId: "ETH-USDT-SWAP", bidPx: "99999", askPx: "not-decimal" }] });
  });
  await assert.rejects(() => source.load("okx", "BTC-USDT-PERP"), /identity is invalid/u);
});
