import assert from "node:assert/strict";
import test from "node:test";
import { BinanceClient } from "./BinanceClient";
import type { BinanceExecutionOrderRequest } from "./BinanceTypes";

test("production orders remain IOC while test orders use GTC", async () => {
  const timeInForce: string[] = [];
  let orderId = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v3/time") {
      return Response.json({ serverTime: Date.now() });
    }
    assert.equal(init?.method, "POST");
    timeInForce.push(url.searchParams.get("timeInForce") ?? "");
    orderId += 1;
    return Response.json({ orderId, clientOrderId: url.searchParams.get("newClientOrderId") });
  }) as typeof fetch;
  const client = new BinanceClient({ apiKey: "test-key", apiSecret: "test-secret" }, fetchFn, Date.now, ["203.0.113.10"]);
  const request: BinanceExecutionOrderRequest = {
    category: "spot", symbol: "XAUTUSDT", side: "Buy", quantity: "0.002",
    limitPrice: "4000", reduceOnly: false, orderLinkId: "ptmtestorder",
  };

  await client.placeOrder(request);
  await client.placeTestOrder({ ...request, orderLinkId: "ptmtestgtc" });

  assert.deepEqual(timeInForce, ["IOC", "GTC"]);
});

test("submit requires exact provider order identity without request fallback", async (t) => {
  const cases = [
    { name: "matching identity", response: { symbol: "BTCUSDT", orderId: 7, clientOrderId: "ptmidentity" }, error: null },
    { name: "missing orderId", response: { symbol: "BTCUSDT", clientOrderId: "ptmidentity" }, error: /orderId/u },
    { name: "missing clientOrderId", response: { symbol: "BTCUSDT", orderId: 7 }, error: /clientOrderId/u },
    { name: "wrong clientOrderId", response: { symbol: "BTCUSDT", orderId: 7, clientOrderId: "wrong-client" }, error: /clientOrderId/u },
    { name: "wrong symbol", response: { symbol: "ETHUSDT", orderId: 7, clientOrderId: "ptmidentity" }, error: /symbol/u },
    { name: "malformed orderId", response: { symbol: "BTCUSDT", orderId: "bad order", clientOrderId: "ptmidentity" }, error: /无效或不可解析/u },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const client = new BinanceClient(
        { apiKey: "test-key", apiSecret: "test-secret" },
        (async (input: string | URL | Request) => {
          const url = new URL(String(input));
          if (url.pathname === "/api/v3/time") return Response.json({ serverTime: Date.now() });
          return Response.json(fixture.response);
        }) as typeof fetch,
        Date.now,
        ["203.0.113.10"],
      );
      const operation = () => client.placeOrder({
        category: "spot", symbol: "BTCUSDT", side: "Buy", quantity: "0.001",
        limitPrice: "1000", reduceOnly: false, orderLinkId: "ptmidentity",
      });
      if (fixture.error) await assert.rejects(operation, fixture.error);
      else assert.deepEqual(await operation(), { orderId: "7", orderLinkId: "ptmidentity" });
    });
  }
});

test("lossless Binance parsing preserves raw numeric orderId boundaries through formal submit", async (t) => {
  for (const fixture of [
    { name: "zero", rawOrderId: "0", expected: "0" },
    { name: "safe integer", rawOrderId: "123456", expected: "123456" },
    { name: "MAX_SAFE_INTEGER", rawOrderId: "9007199254740991", expected: "9007199254740991" },
    { name: "MAX_SAFE_INTEGER plus one", rawOrderId: "9007199254740992", expected: "9007199254740992" },
    { name: "int64 max", rawOrderId: "9223372036854775807", expected: "9223372036854775807" },
  ]) {
    await t.test(fixture.name, async () => {
      const client = new BinanceClient(
        { apiKey: "test-key", apiSecret: "test-secret" },
        rawOrderFetch(fixture.rawOrderId),
        () => 1_800_000_000_000,
        ["203.0.113.10"],
      );

      assert.deepEqual(await client.placeOrder({
        category: "spot", symbol: "BTCUSDT", side: "Buy", quantity: "0.001",
        limitPrice: "1000", reduceOnly: false, orderLinkId: "ptmlossless",
      }), { orderId: fixture.expected, orderLinkId: "ptmlossless" });
    });
  }
});

test("lossless Binance parsing rejects invalid orderId forms before formal identity mapping", async (t) => {
  for (const [name, rawOrderId] of [
    ["negative zero", "-0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["negative zero string", "\"-0\""],
    ["explicit positive zero string", "\"+0\""],
    ["leading zero string", "\"01\""],
    ["scientific notation string", "\"1e3\""],
    ["empty string", "\"\""],
    ["whitespace string", "\" 1\""],
    ["malformed string", "\"not-decimal\""],
    ["null", "null"],
  ] as const) {
    await t.test(name, async () => {
      const client = new BinanceClient(
        { apiKey: "test-key", apiSecret: "test-secret" },
        rawOrderFetch(rawOrderId),
        () => 1_800_000_000_000,
        ["203.0.113.10"],
      );

      await assert.rejects(() => client.placeOrder({
        category: "spot", symbol: "BTCUSDT", side: "Buy", quantity: "0.001",
        limitPrice: "1000", reduceOnly: false, orderLinkId: "ptmlossless",
      }), /无效或不可解析/u);
    });
  }
});

test("orderId normalization traverses nested objects without changing adjacent identity fields", async () => {
  const request = {
    category: "spot" as const, symbol: "BTCUSDT", side: "Buy" as const, quantity: "0.001",
    limitPrice: "1000", reduceOnly: false, orderLinkId: "ptmnested",
  };
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return rawJsonResponse('{"serverTime":1800000000000}');
      return rawJsonResponse('{"symbol":"BTCUSDT","orderId":123,"clientOrderId":"ptmnested","audit":{"orderId":9223372036854775807,"tradeId":77}}');
    }) as typeof fetch,
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );
  assert.equal((await client.placeOrder(request)).orderId, "123");

  const invalidNestedClient = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return rawJsonResponse('{"serverTime":1800000000000}');
      return rawJsonResponse('{"symbol":"BTCUSDT","orderId":123,"clientOrderId":"ptmnested","audit":{"orderId":"bad","tradeId":77}}');
    }) as typeof fetch,
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );
  await assert.rejects(() => invalidNestedClient.placeOrder(request), /无效或不可解析/u);
});

test("lossless parsing normalizes only orderId while preserving ordinary numbers and Decimal strings", async () => {
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    (() => { throw new Error("must not fetch"); }) as typeof fetch,
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );
  const parsed = await (client as unknown as {
    parseResponse(response: Response): Promise<Record<string, unknown>>;
  }).parseResponse(rawJsonResponse(`{
    "orderId":9223372036854775807,
    "tradeId":77,
    "updateId":88,
    "timestamp":1800000000000,
    "origQty":"0.123456789012345678901",
    "executedQty":"0.023456789012345678901",
    "nested":[{"orderId":9007199254740992}]
  }`));

  assert.equal(parsed.orderId, "9223372036854775807");
  assert.equal(parsed.tradeId, 77);
  assert.equal(parsed.updateId, 88);
  assert.equal(parsed.timestamp, 1_800_000_000_000);
  assert.equal(parsed.origQty, "0.123456789012345678901");
  assert.equal(parsed.executedQty, "0.023456789012345678901");
  assert.equal((parsed.nested as Array<{ orderId: string }>)[0]?.orderId, "9007199254740992");
});

test("formal query, partial fill, and cancel retain the exact int64 provider orderId", async () => {
  const requestedOrderIds: string[] = [];
  const methods: string[] = [];
  const rawOrderId = "9223372036854775807";
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return rawJsonResponse('{"serverTime":1800000000000}');
      methods.push(init?.method ?? "GET");
      const requested = url.searchParams.get("orderId");
      if (requested) requestedOrderIds.push(requested);
      if (init?.method === "DELETE") return rawJsonResponse("{}");
      return rawJsonResponse(`{"symbol":"BTCUSDT","orderId":${rawOrderId},"clientOrderId":"ptmlosslessquery","status":"PARTIALLY_FILLED","origQty":"0.100000000000000001","executedQty":"0.000000000000000001"}`);
    }) as typeof fetch,
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );

  const order = await client.findOrderByClientOrderId("spot", "BTCUSDT", "ptmlosslessquery");
  await client.cancelOrder("spot", "BTCUSDT", order!.orderId);

  assert.equal(order?.orderId, rawOrderId);
  assert.equal(order?.status, "PartiallyFilled");
  assert.equal(order?.filledBaseQuantity, "0.000000000000000001");
  assert.deepEqual(requestedOrderIds, [rawOrderId, rawOrderId]);
  assert.ok(!requestedOrderIds.includes("9223372036854776000"));
  assert.deepEqual(methods, ["GET", "GET", "DELETE"]);
});

test("provider reads reject mismatched or malformed identity before applying order facts", async (t) => {
  const cases = [
    { name: "matching identity", response: orderResponse(), expected: "Filled" },
    { name: "wrong symbol", response: orderResponse({ symbol: "ETHUSDT" }), expected: /symbol/u },
    { name: "wrong clientOrderId", response: orderResponse({ clientOrderId: "wrong-client" }), expected: /clientOrderId/u },
    { name: "missing symbol", response: orderResponse({ symbol: undefined }), expected: /symbol/u },
    { name: "missing clientOrderId", response: orderResponse({ clientOrderId: undefined }), expected: /clientOrderId/u },
    { name: "missing orderId", response: orderResponse({ orderId: undefined }), expected: /orderId/u },
    { name: "negative executedQty", response: orderResponse({ executedQty: "-0.1" }), expected: /filled quantity/u },
    { name: "invalid executedQty", response: orderResponse({ executedQty: "not-decimal" }), expected: /filled quantity/u },
    { name: "unknown status", response: orderResponse({ status: "UNRECOGNIZED" }), expected: "Unknown" },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const client = new BinanceClient(
        { apiKey: "test-key", apiSecret: "test-secret" },
        (async (input: string | URL | Request) => {
          const url = new URL(String(input));
          if (url.pathname === "/api/v3/time") return Response.json({ serverTime: Date.now() });
          return Response.json(fixture.response);
        }) as typeof fetch,
        Date.now,
        ["203.0.113.10"],
      );
      const operation = () => client.findOrderByClientOrderId("spot", "BTCUSDT", "ptmidentity");
      if (fixture.expected instanceof RegExp) await assert.rejects(operation, fixture.expected);
      else assert.equal((await operation())?.status, fixture.expected);
    });
  }
});

test("market orders omit provider price and timeInForce", async () => {
  let submitted: URL | null = null;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v3/time") return Response.json({ serverTime: Date.now() });
    assert.equal(init?.method, "POST");
    submitted = url;
    return Response.json({ orderId: 1, clientOrderId: url.searchParams.get("newClientOrderId") });
  }) as typeof fetch;
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    fetchFn,
    Date.now,
    ["203.0.113.10"],
  );

  await client.placeOrder({
    category: "spot",
    symbol: "XAUTUSDT",
    side: "Buy",
    quantity: "0.002",
    executionPriceMode: "MARKET",
    reduceOnly: false,
    orderLinkId: "ptmmarketguard",
  });

  assert.equal((submitted as URL | null)?.searchParams.get("type"), "MARKET");
  assert.equal((submitted as URL | null)?.searchParams.has("price"), false);
  assert.equal((submitted as URL | null)?.searchParams.has("timeInForce"), false);
});

test("provider request validation requires Decimal price only for IOC limit orders", async () => {
  const writes: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v3/time") return Response.json({ serverTime: Date.now() });
    if (init?.method === "POST") writes.push(url.pathname);
    return Response.json({ orderId: 1, clientOrderId: url.searchParams.get("newClientOrderId") });
  }) as typeof fetch;
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    fetchFn,
    Date.now,
    ["203.0.113.10"],
  );
  const base = {
    category: "spot" as const,
    symbol: "BTCUSDT",
    side: "Buy" as const,
    quantity: "0.0001",
    reduceOnly: false,
    orderLinkId: "ptmpricevalidation",
  };

  await assert.rejects(
    () => client.placeOrder({ ...base, executionPriceMode: "IOC_LIMIT" } as never),
    /参数超出白名单/u,
  );
  await assert.rejects(
    () => client.placeOrder({ ...base, executionPriceMode: "MARKET", limitPrice: "100000" } as never),
    /参数超出白名单/u,
  );
  assert.equal(writes.length, 0);
});

test("generic place, query, and cancel keep the authoritative provider symbol and Decimal price", async () => {
  const requests: Array<{ method: string; path: string; symbol: string | null; price: string | null; reduceOnly: string | null }> = [];
  let cancelDispatches = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v3/time") return Response.json({ serverTime: Date.now() });
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      symbol: url.searchParams.get("symbol"),
      price: url.searchParams.get("price"),
      reduceOnly: url.searchParams.get("reduceOnly"),
    });
    if (init?.method === "POST") {
      return Response.json({ orderId: 7, clientOrderId: url.searchParams.get("newClientOrderId") });
    }
    if (init?.method === "DELETE") return Response.json({});
    return Response.json({
      symbol: url.searchParams.get("symbol"),
      orderId: 7,
      clientOrderId: url.searchParams.get("origClientOrderId") ?? "ptmbtc",
      status: "NEW",
      origQty: "0.000000010000000001",
      executedQty: "0",
    });
  }) as typeof fetch;
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    fetchFn,
    Date.now,
    ["203.0.113.10"],
  );

  await client.placeOrder({
    category: "spot",
    symbol: "BTCUSDT",
    side: "Sell",
    quantity: "0.000000010000000001",
    limitPrice: "100000.0000000000000001",
    reduceOnly: true,
    orderLinkId: "ptmbtc",
  });
  const queried = await client.findOrderByClientOrderId("spot", "BTCUSDT", "ptmbtc");
  await client.cancelOrder("spot", "BTCUSDT", "7", () => { cancelDispatches += 1; });

  assert.ok(requests.length >= 4);
  assert.ok(requests.every((request) => request.symbol === "BTCUSDT"));
  assert.equal(requests.find((request) => request.method === "POST")?.reduceOnly, null);
  assert.equal(requests.find((request) => request.method === "POST")?.path, "/api/v3/order");
  assert.equal(requests.find((request) => request.method === "DELETE")?.path, "/api/v3/order");
  assert.equal(requests.find((request) => request.method === "POST")?.symbol, "BTCUSDT");
  assert.equal(requests.find((request) => request.method === "POST")?.price, "100000.0000000000000001");
  assert.equal(requests.find((request) => request.method === "POST")?.method, "POST");
  assert.equal(queried?.requestedBaseQuantity, "0.000000010000000001");
  assert.equal(queried?.filledBaseQuantity, "0");
  assert.equal(cancelDispatches, 1);
});

test("cancel dispatch evidence is emitted only after the provider DELETE transport starts", async () => {
  const events: string[] = [];
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return Response.json({ serverTime: Date.now() });
      events.push(`transport:${init?.method ?? "GET"}`);
      throw new Error("response unavailable");
    }) as typeof fetch,
    Date.now,
    ["203.0.113.10"],
  );

  await assert.rejects(
    () => client.cancelOrder("spot", "BTCUSDT", "7", () => { events.push("dispatch-persisted"); }),
    /连接失败/u,
  );
  assert.deepEqual(events, ["transport:DELETE", "dispatch-persisted"]);
});

test("spot and USD-M order responses preserve full, partial, and cancelled Decimal executedQty", async (t) => {
  for (const fixture of [
    { category: "spot", status: "FILLED", executedQty: "0.000123456789012345" },
    { category: "spot", status: "PARTIALLY_FILLED", executedQty: "0.000023456789012345" },
    { category: "spot", status: "CANCELED", executedQty: "0.000003456789012345" },
    { category: "linear", status: "FILLED", executedQty: "1.234567890123456789" },
    { category: "linear", status: "PARTIALLY_FILLED", executedQty: "0.234567890123456789" },
    { category: "linear", status: "CANCELED", executedQty: "0.034567890123456789" },
  ] as const) {
    await t.test(`${fixture.category}-${fixture.status}`, async () => {
      const client = new BinanceClient(
        { apiKey: "test-key", apiSecret: "test-secret" },
        (async (input: string | URL | Request) => {
          const url = new URL(String(input));
          if (url.pathname === "/api/v3/time") return Response.json({ serverTime: Date.now() });
          return Response.json({
            symbol: fixture.category === "spot" ? "BTCUSDT" : "DOGEUSDT",
            orderId: 9,
            clientOrderId: "decimal-fill",
            status: fixture.status,
            origQty: "2.000000000000000001",
            executedQty: fixture.executedQty,
          });
        }) as typeof fetch,
        Date.now,
        ["203.0.113.10"],
      );
      const order = await client.findOrderByClientOrderId(
        fixture.category,
        fixture.category === "spot" ? "BTCUSDT" : "DOGEUSDT",
        "decimal-fill",
      );
      assert.equal(order?.requestedBaseQuantity, "2.000000000000000001");
      assert.equal(order?.filledBaseQuantity, fixture.executedQty);
    });
  }
});

test("linear orders pass reduceOnly and preserve DOGEUSDT Decimal quantity", async () => {
  let submitted: URL | null = null;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v3/time") return Response.json({ serverTime: Date.now() });
    assert.equal(init?.method, "POST");
    submitted = url;
    return Response.json({ orderId: 8, clientOrderId: url.searchParams.get("newClientOrderId") });
  }) as typeof fetch;
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    fetchFn,
    Date.now,
    ["203.0.113.10"],
  );

  await client.placeOrder({
    category: "linear",
    symbol: "DOGEUSDT",
    side: "Buy",
    quantity: "12.34567890123456789",
    limitPrice: "0.300000000000000001",
    reduceOnly: true,
    orderLinkId: "ptmdoge",
  });

  assert.equal((submitted as URL | null)?.searchParams.get("symbol"), "DOGEUSDT");
  assert.equal((submitted as URL | null)?.searchParams.get("quantity"), "12.34567890123456789");
  assert.equal((submitted as URL | null)?.searchParams.get("price"), "0.300000000000000001");
  assert.equal((submitted as URL | null)?.searchParams.get("reduceOnly"), "true");
});

test("preflight snapshot maps cross and isolated margin modes using GET-only requests", async (t) => {
  for (const marginType of ["cross", "isolated"] as const) {
    await t.test(marginType, async () => {
      const methods: string[] = [];
      const client = new BinanceClient(
        { apiKey: "test-key", apiSecret: "test-secret" },
        snapshotFetch(marginType, methods),
        () => 1_800_000_000_000,
        ["203.0.113.10"],
      );

      const snapshot = await client.readPreflightSnapshot();

      assert.equal(snapshot.perpetual.marginMode, marginType);
      assert.ok(methods.length > 0);
      assert.ok(methods.every((method) => method === "GET"));
    });
  }
});

test("read-only account snapshot returns non-zero raw balances using GET-only requests", async () => {
  const methods: string[] = [];
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    snapshotFetch("cross", methods),
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );

  const snapshot = await client.readAccountSnapshot();

  assert.equal(snapshot.accountMode, "single_asset_one_way");
  assert.deepEqual(snapshot.balances, [
    { asset: "USDT", accountType: "spot", total: 100, available: 100, locked: 0 },
    { asset: "BTC", accountType: "spot", total: 0.002, available: 0.0015, locked: 0.0005 },
    { asset: "USDT", accountType: "derivatives", total: 125, available: 100, locked: null },
  ]);
  assert.ok(methods.length > 0);
  assert.ok(methods.every((method) => method === "GET"));
});

test("all-symbol account read returns non-zero futures positions, open orders, and instrument settings as Decimal strings", async () => {
  const requests: Array<{ method: string; path: string; symbol: string | null }> = [];
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    accountReadExpansionFetch(requests),
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );

  const snapshot = await client.readAccountSnapshot();

  assert.deepEqual(snapshot.allSymbolReadStatus, {
    futuresPositions: { status: "success", fullScan: true },
    spotOpenOrders: { status: "success", fullScan: true },
    futuresOpenOrders: { status: "success", fullScan: true },
  });
  assert.deepEqual(snapshot.futuresPositions, [
    {
      symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0.000000000000000001",
      entryPrice: "100000.000000000000000001", leverage: "2.000", marginType: "cross",
    },
    {
      symbol: "DOGEUSDT", positionSide: "SHORT", positionAmt: "-12.345678901234567890",
      entryPrice: "0.300000000000000001", leverage: "3", marginType: "isolated",
    },
  ]);
  assert.deepEqual(snapshot.spotOpenOrders, [
    {
      symbol: "ETHUSDT", side: "BUY", orderId: "11", clientOrderId: "spot-all-symbol",
      status: "NEW", originalQuantity: "0.000000000000000001", executedQuantity: "0.000000000000000000",
    },
    {
      symbol: "BTCUSDT", side: "SELL", orderId: "13", clientOrderId: "spot-second-symbol",
      status: "NEW", originalQuantity: "0.100000000000000001", executedQuantity: "0",
    },
  ]);
  assert.deepEqual(snapshot.futuresOpenOrders, [
    {
      symbol: "DOGEUSDT", side: "SELL", orderId: "12", clientOrderId: "futures-all-symbol",
      status: "PARTIALLY_FILLED", originalQuantity: "12.345678901234567890",
      executedQuantity: "0.000000000000000001", reduceOnly: true,
    },
    {
      symbol: "XAUTUSDT", side: "BUY", orderId: "14", clientOrderId: "futures-second-symbol",
      status: "NEW", originalQuantity: "0.001000000000000001", executedQuantity: "0", reduceOnly: false,
    },
  ]);
  assert.deepEqual(snapshot.instrumentSettings, [
    { symbol: "BTCUSDT", status: "READABLE", leverage: "2.000", marginMode: "cross" },
    { symbol: "ETHUSDT", status: "READABLE", leverage: "4", marginMode: "cross" },
    { symbol: "DOGEUSDT", status: "READABLE", leverage: "3", marginMode: "isolated" },
    { symbol: "XAUTUSDT", status: "READABLE", leverage: "1", marginMode: "cross" },
  ]);
  assert.ok(requests.every(({ method }) => method === "GET"));
  assert.deepEqual(
    requests.filter(({ path }) => path === "/fapi/v2/positionRisk" || path.endsWith("/openOrders"))
      .map(({ path, symbol }) => ({ path, symbol })),
    [
      { path: "/fapi/v2/positionRisk", symbol: null },
      { path: "/api/v3/openOrders", symbol: null },
      { path: "/fapi/v1/openOrders", symbol: null },
    ],
  );
});

test("all-symbol account read reports successful full scans when positions and open orders are empty", async () => {
  const requests: Array<{ method: string; path: string; symbol: string | null }> = [];
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    accountReadExpansionFetch(requests, { allZeroPositions: true, noOpenOrders: true }),
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );

  const snapshot = await client.readAccountSnapshot();

  assert.deepEqual(snapshot.futuresPositions, []);
  assert.deepEqual(snapshot.spotOpenOrders, []);
  assert.deepEqual(snapshot.futuresOpenOrders, []);
  assert.ok(Object.values(snapshot.allSymbolReadStatus).every((result) => result.status === "success" && result.fullScan));
});

test("all-symbol Account Read preserves mixed safe and raw int64 order IDs with successful full scans", async () => {
  const requests: Array<{ method: string; path: string; symbol: string | null }> = [];
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    accountReadExpansionFetch(requests, { rawLargeOrderIds: true }),
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );

  const snapshot = await client.readAccountSnapshot();

  assert.deepEqual(snapshot.spotOpenOrders.map(({ orderId }) => orderId), ["123456", "9223372036854775807"]);
  assert.deepEqual(snapshot.futuresOpenOrders.map(({ orderId }) => orderId), [
    "9007199254740992", "9223372036854775807",
  ]);
  assert.ok(Object.values(snapshot.allSymbolReadStatus).every(({ status, fullScan }) => status === "success" && fullScan));
  assert.equal(JSON.stringify(snapshot).includes("9223372036854776000"), false);
});

test("Account Read fails closed before fullScan success when a nested open order identity is invalid", async () => {
  const requests: Array<{ method: string; path: string; symbol: string | null }> = [];
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    accountReadExpansionFetch(requests, { invalidRawOrderId: true }),
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );

  await assert.rejects(() => client.readAccountSnapshot(), /无效或不可解析/u);
});

test("all-symbol account read never maps a failed provider scan to empty results", async (t) => {
  for (const failedPath of ["/fapi/v2/positionRisk", "/api/v3/openOrders", "/fapi/v1/openOrders"]) {
    await t.test(failedPath, async () => {
      const requests: Array<{ method: string; path: string; symbol: string | null }> = [];
      const client = new BinanceClient(
        { apiKey: "test-key", apiSecret: "test-secret" },
        accountReadExpansionFetch(requests, { failedPath }),
        () => 1_800_000_000_000,
        ["203.0.113.10"],
      );

      await assert.rejects(
        () => client.readAccountSnapshot(),
        (error: unknown) => error instanceof Error
          && "category" in error
          && error.category === "provider_unavailable",
      );
    });
  }
});

test("reads a Binance perpetual position through the existing signed GET client", async () => {
  const methods: string[] = [];
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      methods.push(init?.method ?? "GET");
      if (url.pathname === "/api/v3/time") return Response.json({ serverTime: 1_800_000_000_000 });
      if (url.pathname === "/fapi/v2/positionRisk") {
        return Response.json([{ symbol: "XAUTUSDT", positionAmt: "-0.002" }]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as typeof fetch,
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );

  assert.deepEqual(await client.readPerpetualPosition("XAUTUSDT"), {
    symbol: "XAUTUSDT", side: "short", baseQuantity: "0.002", updatedAt: null,
  });
  assert.ok(methods.every((method) => method === "GET"));
});

test("generic risk snapshots read only the requested Spot and perpetual instrument with Decimal strings", async () => {
  const requests: Array<{ method: string; path: string; symbol: string | null }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ method: init?.method ?? "GET", path: url.pathname, symbol: url.searchParams.get("symbol") });
    if (url.pathname === "/fapi/v2/positionRisk") {
      return Response.json([{
        symbol: url.searchParams.get("symbol") ?? "BTCUSDT",
        positionAmt: "-0.001234567890123456",
        leverage: "1",
        marginType: "cross",
      }]);
    }
    const response = snapshotResponse(url.pathname, "cross");
    if (response === undefined) throw new Error(`Unhandled Binance fixture request: ${url.pathname}`);
    return Response.json(response);
  }) as typeof fetch;
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    fetchFn,
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );

  const spot = await client.readGenericRiskSnapshot({ category: "spot", symbol: "BTCUSDT", baseAsset: "BTC" });
  assert.equal(spot.availableUsdt, "100");
  assert.equal(spot.availableBaseAsset, "0.0015");
  assert.equal(spot.position, null);

  const perpetual = await client.readGenericRiskSnapshot({ category: "linear", symbol: "BTCUSDT", baseAsset: "BTC" });
  assert.equal(perpetual.availableUsdt, "100");
  assert.deepEqual(perpetual.position, {
    side: "short", quantity: "0.001234567890123456", leverage: "1", marginMode: "cross",
  });
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.ok(requests
    .filter((request) => request.path.endsWith("openOrders") || request.path.endsWith("positionRisk"))
    .every((request) => request.symbol === "BTCUSDT"));

  const dogeRequestStart = requests.length;
  await client.readGenericRiskSnapshot({ category: "linear", symbol: "DOGEUSDT", baseAsset: "DOGE" });
  assert.ok(requests.slice(dogeRequestStart)
    .filter((request) => request.path.endsWith("openOrders") || request.path.endsWith("positionRisk"))
    .every((request) => request.symbol === "DOGEUSDT"));
});

function orderResponse(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "BTCUSDT",
    orderId: 7,
    clientOrderId: "ptmidentity",
    status: "FILLED",
    origQty: "0.001",
    executedQty: "0.001",
    ...overrides,
  };
}

function rawOrderFetch(rawOrderId: string) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v3/time") return rawJsonResponse('{"serverTime":1800000000000}');
    return rawJsonResponse(`{"symbol":"BTCUSDT","orderId":${rawOrderId},"clientOrderId":"ptmlossless"}`);
  }) as typeof fetch;
}

function rawJsonResponse(rawBody: string, status = 200) {
  return new Response(rawBody, { status, headers: { "Content-Type": "application/json" } });
}

function snapshotFetch(
  marginType: "cross" | "isolated",
  methods: string[],
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    methods.push(init?.method ?? "GET");
    const response = snapshotResponse(url.pathname, marginType);
    if (response === undefined) throw new Error(`Unhandled Binance fixture request: ${url.pathname}`);
    return Response.json(response);
  }) as typeof fetch;
}

function accountReadExpansionFetch(
  requests: Array<{ method: string; path: string; symbol: string | null }>,
  options: {
    allZeroPositions?: boolean;
    noOpenOrders?: boolean;
    failedPath?: string;
    rawLargeOrderIds?: boolean;
    invalidRawOrderId?: boolean;
  } = {},
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ method: init?.method ?? "GET", path: url.pathname, symbol: url.searchParams.get("symbol") });
    if (url.pathname === options.failedPath) {
      return Response.json({ code: -1000 }, { status: 500 });
    }
    if (url.pathname === "/fapi/v2/positionRisk") {
      return Response.json([
        {
          symbol: "BTCUSDT", positionSide: "BOTH",
          positionAmt: options.allZeroPositions ? "0.000000000000000000" : "0.000000000000000001",
          entryPrice: "100000.000000000000000001", leverage: "2.000", marginType: "cross",
        },
        {
          symbol: "ETHUSDT", positionSide: "BOTH", positionAmt: "0.000000000000000000",
          entryPrice: "0", leverage: "4", marginType: "cross",
        },
        {
          symbol: "DOGEUSDT", positionSide: "SHORT",
          positionAmt: options.allZeroPositions ? "-0.000000000000000000" : "-12.345678901234567890",
          entryPrice: "0.300000000000000001", leverage: "3", marginType: "isolated",
        },
        {
          symbol: "XAUTUSDT", positionSide: "BOTH", positionAmt: "0",
          entryPrice: "0", leverage: "1", marginType: "cross",
        },
      ]);
    }
    if (url.pathname === "/api/v3/openOrders") {
      if (options.invalidRawOrderId) return rawJsonResponse(`[
        {"symbol":"ETHUSDT","side":"BUY","orderId":"not-decimal","clientOrderId":"spot-invalid","status":"NEW","origQty":"0.1","executedQty":"0"}
      ]`);
      if (options.rawLargeOrderIds) return rawJsonResponse(`[
        {"symbol":"ETHUSDT","side":"BUY","orderId":123456,"clientOrderId":"spot-safe","status":"NEW","origQty":"0.000000000000000001","executedQty":"0"},
        {"symbol":"BTCUSDT","side":"SELL","orderId":9223372036854775807,"clientOrderId":"spot-int64","status":"NEW","origQty":"0.100000000000000001","executedQty":"0"}
      ]`);
      return Response.json(options.noOpenOrders ? [] : [
        {
          symbol: "ETHUSDT", side: "BUY", orderId: 11, clientOrderId: "spot-all-symbol", status: "NEW",
          origQty: "0.000000000000000001", executedQty: "0.000000000000000000",
        },
        {
          symbol: "BTCUSDT", side: "SELL", orderId: 13, clientOrderId: "spot-second-symbol", status: "NEW",
          origQty: "0.100000000000000001", executedQty: "0",
        },
      ]);
    }
    if (url.pathname === "/fapi/v1/openOrders") {
      if (options.rawLargeOrderIds) return rawJsonResponse(`[
        {"symbol":"DOGEUSDT","side":"SELL","orderId":9007199254740992,"clientOrderId":"futures-boundary","status":"NEW","origQty":"12.345678901234567890","executedQty":"0","reduceOnly":true},
        {"symbol":"XAUTUSDT","side":"BUY","orderId":"9223372036854775807","clientOrderId":"futures-string-int64","status":"NEW","origQty":"0.001000000000000001","executedQty":"0","reduceOnly":false}
      ]`);
      return Response.json(options.noOpenOrders ? [] : [
        {
          symbol: "DOGEUSDT", side: "SELL", orderId: 12, clientOrderId: "futures-all-symbol",
          status: "PARTIALLY_FILLED", origQty: "12.345678901234567890",
          executedQty: "0.000000000000000001", reduceOnly: true,
        },
        {
          symbol: "XAUTUSDT", side: "BUY", orderId: 14, clientOrderId: "futures-second-symbol",
          status: "NEW", origQty: "0.001000000000000001", executedQty: "0", reduceOnly: false,
        },
      ]);
    }
    const response = snapshotResponse(url.pathname, "cross");
    if (response === undefined) throw new Error(`Unhandled Binance fixture request: ${url.pathname}`);
    return Response.json(response);
  }) as typeof fetch;
}

function snapshotResponse(path: string, marginType: "cross" | "isolated"): unknown {
  switch (path) {
    case "/api/v3/time":
      return { serverTime: 1_800_000_000_000 };
    case "/api/v3/exchangeInfo":
      return {
        symbols: [{
          symbol: "XAUTUSDT",
          baseAsset: "XAUT",
          quoteAsset: "USDT",
          status: "TRADING",
          isSpotTradingAllowed: true,
          baseAssetPrecision: 8,
          filters: [
            { filterType: "LOT_SIZE", minQty: "0.0001", stepSize: "0.0001" },
            { filterType: "NOTIONAL", minNotional: "5" },
            { filterType: "PRICE_FILTER", tickSize: "0.01" },
          ],
        }],
      };
    case "/fapi/v1/exchangeInfo":
      return {
        symbols: [{
          symbol: "XAUTUSDT",
          baseAsset: "XAUT",
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
          status: "TRADING",
          quantityPrecision: 3,
          filters: [
            { filterType: "LOT_SIZE", minQty: "0.001", stepSize: "0.001" },
            { filterType: "MIN_NOTIONAL", notional: "5" },
            { filterType: "PRICE_FILTER", tickSize: "0.01" },
          ],
        }],
      };
    case "/sapi/v1/account/apiRestrictions":
      return {
        enableReading: true,
        enableSpotAndMarginTrading: true,
        enableFutures: true,
        enableWithdrawals: false,
        ipRestrict: true,
        ipList: ["203.0.113.10"],
      };
    case "/api/v3/account":
      return {
        uid: "fixture-account",
        canTrade: true,
        balances: [
          { asset: "USDT", free: "100", locked: "0" },
          { asset: "BTC", free: "0.0015", locked: "0.0005" },
          { asset: "XAUT", free: "0", locked: "0" },
        ],
      };
    case "/fapi/v2/account":
      return {
        canTrade: true,
        multiAssetsMargin: false,
        availableBalance: "100",
        assets: [
          { asset: "USDT", walletBalance: "125", availableBalance: "100" },
          { asset: "BNB", walletBalance: "0", availableBalance: "0" },
        ],
      };
    case "/fapi/v1/positionSide/dual":
      return { dualSidePosition: false };
    case "/sapi/v1/asset/tradeFee":
      return [{ symbol: "XAUTUSDT", takerCommission: "0.001" }];
    case "/fapi/v1/commissionRate":
      return { symbol: "XAUTUSDT", takerCommissionRate: "0.0005" };
    case "/fapi/v2/positionRisk":
      return [{
        symbol: "XAUTUSDT",
        positionAmt: "0",
        leverage: "1",
        marginType,
        liquidationPrice: "0",
      }];
    case "/api/v3/openOrders":
    case "/fapi/v1/openOrders":
      return [];
    case "/api/v3/ticker/bookTicker":
    case "/fapi/v1/ticker/bookTicker":
      return { symbol: "XAUTUSDT", bidPrice: "4339.99", askPrice: "4340" };
    case "/fapi/v1/premiumIndex":
      return {
        symbol: "XAUTUSDT",
        markPrice: "4339.50",
        lastFundingRate: "0.0001",
        nextFundingTime: 1_800_000_028_800,
      };
    case "/fapi/v1/fundingInfo":
      return [{ symbol: "XAUTUSDT", fundingIntervalHours: 8 }];
    case "/api/v3/depth":
    case "/fapi/v1/depth":
      return { bids: [["4339.99", "1"]], asks: [["4340", "1"]] };
    default:
      return undefined;
  }
}
