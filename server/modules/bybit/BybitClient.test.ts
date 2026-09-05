import assert from "node:assert/strict";
import test from "node:test";
import { BybitClient, BybitProviderError } from "./BybitClient";
import { createBybitInstrumentQuantityRulesSource } from "./BybitInstrumentQuantityRulesSource";
import { BybitInstrumentMappingAdapter } from "./BybitInstrumentMapping";
import { bybitBaseQuantityToProvider, loadBybitQuantityRules } from "./BybitQuantitySemantics";

const now = 1_800_000_000_000;

test("Bybit private client preserves code/category without exposing Provider retMsg", async () => {
  const rawMessage = "signature=provider-secret arbitrary upstream details";
  const client = new BybitClient(() => ({ apiKey: "key", apiSecret: "secret" }), {
    now: () => now,
    fetchImpl: (async () => Response.json({ retCode: 10004, retMsg: rawMessage, result: {} })) as typeof fetch,
  });

  await assert.rejects(
    () => client.validateAccess(),
    (error: unknown) => error instanceof BybitProviderError
      && error.category === "credential_validation_failed"
      && error.providerCode === 10004
      && error.message === "Bybit credential validation failed."
      && !error.message.includes(rawMessage),
  );
});

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

test("Bybit classifies lagging execution evidence as transient without accepting Filled alone", async () => {
  let evidenceRead = 0;
  const client = new BybitClient(() => ({ apiKey: "key", apiSecret: "secret" }), {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v5/order/realtime") return Response.json({ retCode: 0, result: { list: [{
        symbol: "DOGEUSDT", orderId: "303", orderLinkId: "sxby-lag", side: "Buy", orderStatus: "Filled",
        qty: "60.1", cumExecQty: "60.1", avgPrice: "0.1", updatedTime: String(now),
      }] } });
      if (url.pathname === "/v5/execution/list") {
        evidenceRead += 1;
        return Response.json({ retCode: 0, result: { list: evidenceRead === 1 ? [] : [{
          symbol: "DOGEUSDT", orderId: "303", orderLinkId: "sxby-lag",
          execQty: "60.1", execFee: "0.0601", feeCurrency: "DOGE",
        }] } });
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    }) as typeof fetch,
  });

  await assert.rejects(
    () => client.getOrder({ category: "spot", symbol: "DOGEUSDT", orderId: "303", orderLinkId: "sxby-lag" }),
    (error: unknown) => error instanceof BybitProviderError
      && error.category === "execution_evidence_pending"
      && error.reconcileSubstage === "EXECUTION_EVIDENCE_COMPARE",
  );
  const confirmed = await client.getOrder({
    category: "spot", symbol: "DOGEUSDT", orderId: "303", orderLinkId: "sxby-lag",
  });
  assert.equal(confirmed.status, "CONFIRMED");
  assert.equal(confirmed.filledQuantity, "60.1");
  assert.equal(confirmed.feeCurrency, "DOGE");
});

test("Bybit treats execution evidence exceeding the order cumulative fill as invalid", async () => {
  const client = new BybitClient(() => ({ apiKey: "key", apiSecret: "secret" }), {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v5/order/realtime") return Response.json({ retCode: 0, result: { list: [{
        symbol: "DOGEUSDT", orderId: "304", orderLinkId: "sxby-conflict", side: "Sell", orderStatus: "Filled",
        qty: "10", cumExecQty: "10", avgPrice: "0.1", updatedTime: String(now),
      }] } });
      if (url.pathname === "/v5/execution/list") return Response.json({ retCode: 0, result: { list: [{
        symbol: "DOGEUSDT", orderId: "304", orderLinkId: "sxby-conflict",
        execQty: "11", execFee: "0.01", feeCurrency: "USDT",
      }] } });
      throw new Error(`Unexpected path ${url.pathname}`);
    }) as typeof fetch,
  });
  await assert.rejects(
    () => client.getOrder({ category: "linear", symbol: "DOGEUSDT", orderId: "304", orderLinkId: "sxby-conflict" }),
    (error: unknown) => error instanceof BybitProviderError
      && error.category === "provider_response_invalid"
      && error.reconcileSubstage === "EXECUTION_EVIDENCE_COMPARE",
  );
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

test("Bybit funding history paginates settlement transactions and preserves signed funding and position size", async () => {
  const calls: Array<{ method: string; path: string; cursor: string | null }> = [];
  const client = new BybitClient(() => ({ apiKey: "key", apiSecret: "secret" }), {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname, cursor: url.searchParams.get("cursor") });
      const cursor = url.searchParams.get("cursor");
      return Response.json({ retCode: 0, result: cursor === null ? {
        list: [{
          id: "funding-1", symbol: "DOGEUSDT", category: "linear", side: "Sell",
          transactionTime: String(now - 10), type: "SETTLEMENT", funding: "-0.003000",
          currency: "USDT", size: "-68.000",
        }, {
          id: "other", symbol: "BTCUSDT", category: "linear", side: "Buy",
          transactionTime: String(now - 10), type: "SETTLEMENT", funding: "0.01",
          currency: "USDT", size: "1",
        }],
        nextPageCursor: "next",
      } : {
        list: [{
          id: "funding-2", symbol: "DOGEUSDT", category: "linear", side: "Sell",
          transactionTime: String(now), type: "SETTLEMENT", funding: "0.001",
          currency: "USDT", size: "-68",
        }],
        nextPageCursor: "",
      } });
    }) as typeof fetch,
  });

  const rows = await client.readFundingTransactions({
    symbol: "DOGEUSDT", startTime: now - 60_000, endTime: now,
  });
  assert.deepEqual(rows, [{
    id: "funding-1", symbol: "DOGEUSDT", side: "Sell", transactionTime: now - 10,
    funding: "-0.003", currency: "USDT", size: "-68",
  }, {
    id: "funding-2", symbol: "DOGEUSDT", side: "Sell", transactionTime: now,
    funding: "0.001", currency: "USDT", size: "-68",
  }]);
  assert.deepEqual(calls, [
    { method: "GET", path: "/v5/account/transaction-log", cursor: null },
    { method: "GET", path: "/v5/account/transaction-log", cursor: "next" },
  ]);
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
