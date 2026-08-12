import assert from "node:assert/strict";
import test from "node:test";
import { BinanceClient } from "./BinanceClient";
import type { BinanceOrderRequest } from "./BinanceTypes";

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
  const request: BinanceOrderRequest = {
    category: "spot", symbol: "XAUTUSDT", side: "Buy", quantityXaut: 0.002,
    limitPrice: 4_000, reduceOnly: false, orderLinkId: "ptmtestorder",
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
    quantityXaut: 0.002,
    limitPrice: 4_010,
    executionPriceMode: "MARKET",
    reduceOnly: false,
    orderLinkId: "ptmmarketguard",
  });

  assert.equal((submitted as URL | null)?.searchParams.get("type"), "MARKET");
  assert.equal((submitted as URL | null)?.searchParams.has("price"), false);
  assert.equal((submitted as URL | null)?.searchParams.has("timeInForce"), false);
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
