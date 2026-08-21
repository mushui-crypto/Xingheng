import assert from "node:assert/strict";
import test from "node:test";
import { BybitClient } from "./BybitClient";
import { createBybitInstrumentQuantityRulesSource } from "./BybitInstrumentQuantityRulesSource";
import { BybitInstrumentMappingAdapter } from "./BybitInstrumentMapping";
import { bybitBaseQuantityToProvider, loadBybitQuantityRules } from "./BybitQuantitySemantics";

const now = 1_800_000_000_000;

test("Bybit private client performs place/query/cancel with exact orderLinkId identity and authoritative execution evidence", async () => {
  const calls: Array<{ path: string; method: string; query: URLSearchParams; body: Record<string, unknown> | null }> = [];
  const client = new BybitClient(() => ({ apiKey: "key", apiSecret: "secret" }), {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({ path: url.pathname, method: init?.method ?? "GET", query: url.searchParams, body });
      assert.equal(init?.headers && (init.headers as Record<string, string>)["X-BAPI-API-KEY"], "key");
      assert.match(String(init?.headers && (init.headers as Record<string, string>)["X-BAPI-SIGN"]), /^[a-f0-9]{64}$/u);
      if (url.pathname === "/v5/order/create") {
        return Response.json({ retCode: 0, result: { orderId: "101", orderLinkId: body?.orderLinkId } });
      }
      if (url.pathname === "/v5/order/realtime") {
        return Response.json({ retCode: 0, result: { list: [{
          symbol: "DOGEUSDT", orderId: "101", orderLinkId: "sxby-test", side: "Buy",
          orderStatus: "PartiallyFilled", qty: "100", cumExecQty: "40", avgPrice: "0.1",
          rejectReason: "", cancelType: "", positionIdx: 0, updatedTime: String(now),
        }] } });
      }
      if (url.pathname === "/v5/execution/list") {
        return Response.json({ retCode: 0, result: { list: [
          { symbol: "DOGEUSDT", orderId: "101", orderLinkId: "sxby-test", execQty: "25", execFee: "0.01", feeCurrency: "USDT" },
          { symbol: "DOGEUSDT", orderId: "101", orderLinkId: "sxby-test", execQty: "15", execFee: "0.02", feeCurrency: "USDT" },
        ] } });
      }
      if (url.pathname === "/v5/order/cancel") {
        return Response.json({ retCode: 0, result: { orderId: "101", orderLinkId: "sxby-test" } });
      }
      throw new Error(`Unexpected Bybit request: ${url.pathname}`);
    }) as typeof fetch,
  });

  const accepted = await client.placeOrder({
    category: "linear", symbol: "DOGEUSDT", side: "Buy", orderType: "Market", qty: "100",
    orderLinkId: "sxby-test", reduceOnly: false, positionIdx: 0,
  });
  assert.deepEqual(accepted, { category: "linear", symbol: "DOGEUSDT", orderId: "101", orderLinkId: "sxby-test" });
  const order = await client.getOrder({ category: "linear", symbol: "DOGEUSDT", orderId: "101", orderLinkId: "sxby-test" });
  assert.equal(order.status, "PENDING_CONFIRMATION");
  assert.equal(order.filledQuantity, "40");
  assert.equal(order.fee, "0.03");
  assert.equal(order.feeCurrency, "USDT");
  await client.cancelOrder({ category: "linear", symbol: "DOGEUSDT", orderId: "101", orderLinkId: "sxby-test" });
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [
    ["POST", "/v5/order/create"],
    ["GET", "/v5/order/realtime"],
    ["GET", "/v5/execution/list"],
    ["POST", "/v5/order/cancel"],
  ]);
});

test("Bybit order recovery falls back from realtime to history using deterministic orderLinkId", async () => {
  const paths: string[] = [];
  const client = new BybitClient(() => ({ apiKey: "key", apiSecret: "secret" }), {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/v5/order/realtime") return Response.json({ retCode: 0, result: { list: [] } });
      if (url.pathname === "/v5/order/history") return Response.json({ retCode: 0, result: { list: [{
        symbol: "DOGEUSDT", orderId: "202", orderLinkId: "sxby-recover", side: "Sell", orderStatus: "Filled",
        qty: "10", cumExecQty: "10", avgPrice: "0.1", rejectReason: "", cancelType: "", updatedTime: String(now),
      }] } });
      if (url.pathname === "/v5/execution/list") return Response.json({ retCode: 0, result: { list: [{
        symbol: "DOGEUSDT", orderId: "202", orderLinkId: "sxby-recover", execQty: "10", execFee: "0", feeCurrency: "USDT",
      }] } });
      throw new Error(`Unexpected path ${url.pathname}`);
    }) as typeof fetch,
  });
  const order = await client.getOrder({ category: "spot", symbol: "DOGEUSDT", orderLinkId: "sxby-recover" });
  assert.equal(order.orderId, "202");
  assert.equal(order.status, "CONFIRMED");
  assert.deepEqual(paths, ["/v5/order/realtime", "/v5/order/history", "/v5/execution/list"]);
});

test("Bybit historical evidence scans realtime, order history, executions, and active orders without mutation", async () => {
  const calls: Array<{ method: string; path: string; orderLinkId: string | null }> = [];
  const client = new BybitClient(() => ({ apiKey: "key", apiSecret: "secret" }), {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname, orderLinkId: url.searchParams.get("orderLinkId") });
      if (url.pathname === "/v5/order/realtime"
        || url.pathname === "/v5/order/history"
        || url.pathname === "/v5/execution/list") {
        return Response.json({ retCode: 0, result: { list: [] } });
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    }) as typeof fetch,
  });

  const result = await client.readHistoricalOrderEvidence({
    category: "spot", symbol: "DOGEUSDT", orderLinkId: "sxby-history", startedAt: now - 1_000,
  });
  assert.deepEqual(result, { exactOrderEvidence: "ABSENT", activeOrderCount: 0, checkedAt: now });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ method }) => method === "GET"));
  assert.deepEqual(new Set(calls.map(({ path }) => path)), new Set([
    "/v5/order/realtime", "/v5/order/history", "/v5/execution/list",
  ]));
});

test("Bybit dynamic instrument rules preserve base quantity for Spot and Linear without symbol allow-lists", async () => {
  const requested: string[] = [];
  const source = createBybitInstrumentQuantityRulesSource({
    clock: () => now,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const category = url.searchParams.get("category")!;
      const symbol = url.searchParams.get("symbol")!;
      requested.push(`${category}:${symbol}`);
      return Response.json({ retCode: 0, result: { list: [{
        symbol, status: "Trading", baseCoin: symbol.slice(0, -4), quoteCoin: "USDT",
        ...(category === "linear" ? { settleCoin: "USDT" } : {}),
        lotSizeFilter: { qtyStep: "0.1", minOrderQty: "1", minNotionalValue: "5" },
      }] } });
    }) as typeof fetch,
  });
  const mapping = new BybitInstrumentMappingAdapter();
  for (const instrumentId of ["DOGE-USDT-SPOT", "DOGE-USDT-PERP"] as const) {
    const instrument = mapping.resolve(instrumentId);
    const rules = await loadBybitQuantityRules(source, instrument, now);
    assert.equal(bybitBaseQuantityToProvider("10.5", rules), "10.5");
  }
  assert.deepEqual(requested, ["spot:DOGEUSDT", "linear:DOGEUSDT"]);
});
