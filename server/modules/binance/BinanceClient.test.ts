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
