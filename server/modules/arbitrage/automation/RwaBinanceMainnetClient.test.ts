import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { RwaBinanceMainnetClient, RwaBinanceProviderError } from "./RwaBinanceMainnetClient";
import { createUnmonitoredActivityContinuity } from "./RwaProviderActivityContinuity";
import {
  createNeutralExecutionRecord,
  RwaNeutralHedgeExecutionEngine,
} from "./RwaNeutralHedgeExecutionEngine";
import {
  defaultRwaExecutionConfig,
  RwaExecutionSafetyError,
} from "./RwaNeutralExecutionTypes";

test("Binance attribution performs private source reads and is fail-closed when any source is unavailable", async () => {
  let calls = 0;
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    (async () => {
      calls += 1;
      throw new Error("unexpected network call");
    }) as typeof fetch,
    () => 2_000,
    ["203.0.113.10"],
  );
  const result = await client.readPositionAttribution({
    strategyOrderPrefix: "rwa-scope",
    strategyOrderPrefixes: ["rwa-order"],
    since: 1_000,
    continuity: createUnmonitoredActivityContinuity(1_000),
  });
  assert.equal(result.coverage, "incomplete");
  assert.equal(result.externalPositionActivity, false);
  assert.equal(result.checkedFrom, 1_000);
  assert.equal(result.checkedThrough, 1_000);
  assert.equal(result.sources.length, 0);
  assert.ok(calls > 0);
});

test("Binance managed public risk reads only the XAUT perpetual mark without credentials", async () => {
  let calls = 0;
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    (async (input, init) => {
      calls += 1;
      const url = new URL(String(input));
      assert.equal(url.origin, "https://fapi.binance.com");
      assert.equal(url.pathname, "/fapi/v1/premiumIndex");
      assert.equal(url.searchParams.get("symbol"), "XAUTUSDT");
      assert.equal(url.searchParams.has("signature"), false);
      assert.equal(new Headers(init?.headers).has("X-MBX-APIKEY"), false);
      return json({ markPrice: "4128.5" });
    }) as typeof fetch,
    () => 2_000,
    ["203.0.113.10"],
  );
  assert.deepEqual(await client.readManagedAssetPublicMark(), {
    capturedAt: 2_000,
    perpetualMark: 4_128.5,
  });
  assert.equal(calls, 1);
});

test("Binance funding settlements use stable provider ids and reject duplicate pagination evidence", async () => {
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return json({ serverTime: 3_000 });
      if (url.pathname === "/fapi/v1/income") {
        return json([{
          symbol: "XAUTUSDT",
          incomeType: "FUNDING_FEE",
          time: 2_000,
          tranId: "funding-1",
          income: "-0.25",
        }]);
      }
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch,
    () => 3_000,
    ["203.0.113.10"],
  );
  const settlements = await client.readAssetFundingSettlements({ after: 1_000, through: 3_000 });
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]?.cycleId, "binance:XAUTUSDT:2000");
  assert.match(settlements[0]?.settlementId ?? "", /^[0-9a-f]{64}$/);
  assert.equal(settlements[0]?.settledAt, 2_000);
  assert.equal(settlements[0]?.netFundingUsd, -0.25);
  assert.equal(settlements[0]?.fundingRate, null);
});

test("Binance scans the frozen signed endpoints but cannot certify a non-atomic mutation window", async () => {
  const paths: string[] = [];
  const monitoredAccountId = `binance:${createHash("sha256").update("binance:123456").digest("hex").slice(0, 16)}`;
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    (async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/api/v3/time") return json({ serverTime: 2_000 });
      if (url.pathname === "/api/v3/account") return json({ uid: 123456 });
      if (["/sapi/v1/asset/transfer", "/sapi/v1/asset/assetDividend"].includes(url.pathname)) {
        return json({ rows: [], total: 0 });
      }
      if (url.pathname === "/sapi/v1/convert/tradeFlow") return json({ list: [] });
      if (url.pathname === "/sapi/v1/asset/dribblet") return json({ userAssetDribblets: [] });
      return json([]);
    }) as typeof fetch,
    () => 2_000,
    ["203.0.113.10"],
    [monitoredAccountId],
  );
  const result = await client.readPositionAttribution({
    strategyOrderPrefix: "rwa-scope",
    strategyOrderPrefixes: ["rwa-order"],
    since: 1_000,
    continuity: createUnmonitoredActivityContinuity(1_000),
  });
  assert.equal(result.coverage, "incomplete");
  assert.equal(result.checkedThrough, 1_000);
  assert.equal(paths.filter((path) => path === "/api/v3/time").length, 1);
  assert.ok(paths.includes("/api/v3/myTrades"));
  assert.ok(paths.includes("/fapi/v1/userTrades"));
  assert.ok(paths.includes("/sapi/v1/asset/transfer"));
  assert.ok(paths.includes("/sapi/v1/capital/deposit/hisrec"));
  assert.ok(paths.includes("/sapi/v1/capital/withdraw/history"));
});

test("Binance remains incomplete when a concurrent event is correctly excluded by endTime", async () => {
  const monitoredAccountId = `binance:${createHash("sha256").update("binance:123456").digest("hex").slice(0, 16)}`;
  let concurrentEventCreated = false;
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return json({ serverTime: 2_000 });
      if (url.pathname === "/api/v3/account") return json({ uid: 123456 });
      if (url.pathname === "/api/v3/allOrders") {
        concurrentEventCreated = true;
        return json([]);
      }
      if (url.pathname === "/api/v3/myTrades") {
        const event = { id: 9, orderId: 9009, symbol: "XAUTUSDT", time: 2_001 };
        return json(event.time <= Number(url.searchParams.get("endTime")) ? [event] : []);
      }
      if (["/sapi/v1/asset/transfer", "/sapi/v1/asset/assetDividend"].includes(url.pathname)) {
        return json({ rows: [], total: 0 });
      }
      if (url.pathname === "/sapi/v1/convert/tradeFlow") return json({ list: [] });
      if (url.pathname === "/sapi/v1/asset/dribblet") return json({ userAssetDribblets: [] });
      return json([]);
    }) as typeof fetch,
    () => 2_000,
    ["203.0.113.10"],
    [monitoredAccountId],
  );
  const result = await client.readPositionAttribution({
    strategyOrderPrefix: "rwa-scope",
    strategyOrderPrefixes: ["rwa-order"],
    since: 1_000,
    continuity: createUnmonitoredActivityContinuity(1_000),
  });
  assert.equal(concurrentEventCreated, true);
  assert.equal(result.coverage, "incomplete");
  assert.equal(result.externalPositionActivity, false);
  assert.equal(result.checkedThrough, 1_000);
});

test("a strict cutoff race reaches zero leverage or order mutations in the real Binance adapter", async () => {
  const monitoredAccountId = `binance:${createHash("sha256").update("binance:123456").digest("hex").slice(0, 16)}`;
  const mutationMethods: string[] = [];
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    (async (input, init) => {
      const url = new URL(String(input));
      if (init?.method && init.method !== "GET") mutationMethods.push(`${init.method}:${url.pathname}`);
      if (url.pathname === "/api/v3/time") return json({ serverTime: 2_000 });
      if (url.pathname === "/api/v3/account") return json({ uid: 123456 });
      if (url.pathname === "/api/v3/myTrades") {
        const event = { id: 9, orderId: 9009, symbol: "XAUTUSDT", time: 2_001 };
        return json(event.time <= Number(url.searchParams.get("endTime")) ? [event] : []);
      }
      if (["/sapi/v1/asset/transfer", "/sapi/v1/asset/assetDividend"].includes(url.pathname)) {
        return json({ rows: [], total: 0 });
      }
      if (url.pathname === "/sapi/v1/convert/tradeFlow") return json({ list: [] });
      if (url.pathname === "/sapi/v1/asset/dribblet") return json({ userAssetDribblets: [] });
      return json([]);
    }) as typeof fetch,
    () => 2_000,
    ["203.0.113.10"],
    [monitoredAccountId],
  );
  const execution = createNeutralExecutionRecord({
    userId: "user-a",
    accountId: monitoredAccountId,
    userOrderPrefix: "rwa-owner",
    idempotencyKey: "entry:strict-cutoff-race",
    challengeId: "challenge",
    now: 2_000,
  });
  const engine = new RwaNeutralHedgeExecutionEngine(() => 2_000);
  await assert.rejects(
    engine.open({
      client,
      execution,
      snapshot: {
        accountId: monitoredAccountId,
        accountFingerprint: monitoredAccountId.slice("binance:".length),
        fetchedAt: 2_000,
        accountMode: "single_asset_one_way",
        permissions: {
          read: true,
          spotTrade: true,
          contractTrade: true,
          withdraw: false,
          ipRestricted: true,
          spotAccount: true,
          futuresAccount: true,
          positionModeSupported: true,
        },
        availableUsdt: 25,
        existingSpotQuantityXaut: 0,
        existingPerpetualQuantityXaut: 0,
        spotAvailableQuantityXaut: 0,
        spotLockedQuantityXaut: 0,
        perpetualPositionSide: "flat",
        openSpotOrderCount: 0,
        openPerpetualOrderCount: 0,
        spot: {
          status: "Trading",
          minOrderQty: 0.0001,
          qtyStep: 0.0001,
          minNotionalUsd: 5,
          priceTick: 0.01,
          bid: 4_000,
          ask: 4_001,
        },
        perpetual: {
          status: "Trading",
          minOrderQty: 0.001,
          qtyStep: 0.001,
          minNotionalUsd: 5,
          priceTick: 0.1,
          bid: 4_000,
          ask: 4_001,
          mark: 4_000.5,
          fundingRate: 0.0001,
          fundingIntervalHours: 8,
          liquidationDistancePercent: null,
        },
        fees: { spotTakerBps: 10, perpetualTakerBps: 5 },
      },
      config: defaultRwaExecutionConfig,
      state: {} as never,
      quantityXaut: 0.002,
      persist: async () => undefined,
    }),
    (error: unknown) => error instanceof RwaExecutionSafetyError
      && error.category === "strategy_ownership_ambiguous",
  );
  assert.deepEqual(mutationMethods, []);
});

test("Binance client signs private reads with server-time offset and keeps spot/futures balances isolated", async () => {
  const calls: Array<{ path: string; signed: boolean; timestamp: string | null }> = [];
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    fixtureFetch({ calls }),
    () => 1_000,
    ["203.0.113.10"],
  );

  const access = await client.validateAccess();
  assert.equal(access.accountId.startsWith("binance:"), true);
  assert.equal(access.accountMode, "single_asset_one_way");
  assert.deepEqual(access.permissions, {
    read: true,
    spotTrade: true,
    contractTrade: true,
    withdraw: false,
    ipRestricted: true,
    spotAccount: true,
    futuresAccount: true,
    positionModeSupported: true,
  });
  assert.equal(calls.filter((item) => item.signed).length, 4);
  assert.ok(calls.filter((item) => item.signed).every((item) => item.timestamp === "2000"));

  const snapshot = await client.readPreflightSnapshot();
  assert.equal(snapshot.productAvailability.available, true);
  assert.equal(snapshot.spotAvailableUsdt, 18);
  assert.equal(snapshot.futuresAvailableUsdt, 17);
  assert.equal(snapshot.spot.qtyStep, 0.0001);
  assert.equal(snapshot.spot.minNotionalUsd, 5);
  assert.equal(snapshot.perpetual.qtyStep, 0.001);
  assert.equal(snapshot.perpetual.minNotionalUsd, 5);
  assert.equal(snapshot.perpetual.fundingIntervalHours, 4);
  assert.equal(snapshot.spot.depthUsd > 8, true);
  assert.equal(snapshot.perpetual.depthUsd > 8, true);
});

test("Binance client reports missing real products without substituting another symbol", async () => {
  const calls: Array<{ path: string; signed: boolean; timestamp: string | null }> = [];
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    fixtureFetch({ missingSpot: true, calls }),
    () => 1_000,
    ["203.0.113.10"],
  );

  const availability = await client.readProductAvailability();
  await client.readProductAvailability();
  assert.deepEqual(availability, {
    available: false,
    status: "spot_unavailable",
    spotSymbol: "XAUTUSDT",
    perpetualSymbol: "XAUTUSDT",
    checkedAt: 1_000,
    message: "Binance Mainnet 当前没有可用的 XAUTUSDT 现货产品。",
  });
  assert.equal(calls.filter((item) => item.path === "/api/v3/exchangeInfo").length, 1);
  assert.equal(calls.filter((item) => item.path === "/fapi/v1/exchangeInfo").length, 1);
});

test("Binance preflight rejects malformed authoritative position quantities", async () => {
  for (const options of [
    { spotXautFree: "NaN" },
    { positionAmount: "Infinity" },
  ]) {
    const client = new RwaBinanceMainnetClient(
      { apiKey: "fake-key", apiSecret: "fake-secret" },
      fixtureFetch(options),
      () => 1_000,
      ["203.0.113.10"],
    );
    await assert.rejects(
      client.readPreflightSnapshot(),
      providerError("provider_snapshot_invalid"),
    );
  }
});

test("Binance permission and provider errors are fail-closed and never echo raw secrets", async () => {
  const withdrawalClient = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    fixtureFetch({ withdrawalsEnabled: true }),
    () => 1_000,
    ["203.0.113.10"],
  );
  assert.equal((await withdrawalClient.validateAccess()).permissions.withdraw, true);

  const failingClient = new RwaBinanceMainnetClient(
    { apiKey: "visible-key", apiSecret: "never-echo-this" },
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return json({ serverTime: 2_000 });
      return json({ code: -2015, msg: "never-echo-this https://private.invalid/path" }, 401);
    },
    () => 1_000,
    ["203.0.113.10"],
  );
  await assert.rejects(
    failingClient.validateAccess(),
    (error: unknown) => {
      assert.ok(error instanceof RwaBinanceProviderError);
      assert.equal(error.category, "provider_credential_invalid");
      assert.equal(error.message.includes("never-echo-this"), false);
      assert.equal(error.message.includes("private.invalid"), false);
      return true;
    },
  );
});

test("Binance client classifies provider credential, request, regional, timeout and non-json failures", async () => {
  const requestInvalid = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return json({ serverTime: 2_000 });
      return json({ code: -1130, msg: "bad parameter apiKey=fake-key" }, 400);
    },
    () => 1_000,
    ["203.0.113.10"],
  );
  await assert.rejects(requestInvalid.validateAccess(), (error: unknown) => {
    assert.ok(error instanceof RwaBinanceProviderError);
    assert.equal(error.category, "provider_request_invalid");
    assert.equal(error.providerCode, -1130);
    assert.doesNotMatch(error.message, /fake-key/);
    return true;
  });

  const invalidKey = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return json({ serverTime: 2_000 });
      return json({ code: -2008, msg: "Invalid Api-Key ID." }, 400);
    },
    () => 1_000,
    ["203.0.113.10"],
  );
  await assert.rejects(invalidKey.validateAccess(), providerError("provider_credential_invalid"));

  const regionBlocked = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return json({ serverTime: 2_000 });
      return new Response("<html>blocked</html>", { status: 451, headers: { "Content-Type": "text/html" } });
    },
    () => 1_000,
    ["203.0.113.10"],
  );
  await assert.rejects(regionBlocked.validateAccess(), providerError("provider_region_restricted"));

  const timedOut = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    async () => {
      const error = new Error("request timeout");
      error.name = "AbortError";
      throw error;
    },
    () => 1_000,
    ["203.0.113.10"],
  );
  await assert.rejects(timedOut.validateAccess(), providerError("provider_timeout"));

  const nonJson = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return json({ serverTime: 2_000 });
      return new Response("upstream unavailable", { status: 502, headers: { "Content-Type": "text/plain" } });
    },
    () => 1_000,
    ["203.0.113.10"],
  );
  await assert.rejects(nonJson.validateAccess(), providerError("provider_unavailable"));
});

test("Binance IP whitelist validation is fail-closed for missing, unrestricted, wildcard, failed, and mismatched data", async () => {
  const missingConfigCalls: Array<{ path: string; signed: boolean; timestamp: string | null }> = [];
  const missingConfig = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    fixtureFetch({ calls: missingConfigCalls }),
    () => 1_000,
    null,
  );
  await assert.rejects(
    missingConfig.validateAccess(),
    providerError("binance_egress_ip_config_missing"),
  );
  assert.equal(missingConfigCalls.length, 0);

  const missingProviderList = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    fixtureFetch({ omitIpList: true }),
    () => 1_000,
    ["203.0.113.10"],
  );
  const compatibleAccess = await missingProviderList.validateAccess();
  assert.equal(compatibleAccess.permissions.ipRestricted, true);
  assert.equal(compatibleAccess.ipWhitelistVerificationMode, "provider_restriction_only");

  for (const options of [
    { ipRestricted: false },
    { ipList: ["*"] },
    { ipList: [] },
  ]) {
    const client = new RwaBinanceMainnetClient(
      { apiKey: "fake-key", apiSecret: "fake-secret" },
      fixtureFetch(options),
      () => 1_000,
      ["203.0.113.10"],
    );
    await assert.rejects(client.validateAccess(), providerError("binance_ip_whitelist_unconfirmed"));
  }

  const mismatch = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    fixtureFetch({ ipList: ["203.0.113.11"] }),
    () => 1_000,
    ["203.0.113.10"],
  );
  await assert.rejects(mismatch.validateAccess(), providerError("binance_ip_whitelist_mismatch"));

  const failedQuery = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    fixtureFetch({ restrictionsFailure: true }),
    () => 1_000,
    ["203.0.113.10"],
  );
  await assert.rejects(failedQuery.validateAccess(), providerError("provider_unavailable"));
});

test("Binance takeover snapshot proves a complete provider window and rejects funding or depth gaps", async () => {
  const now = 1_800_000_000_000;
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    fixtureFetch({ spotXautFree: "0.1", positionAmount: "-0.1" }),
    () => now,
    ["203.0.113.10"],
  );
  const snapshot = await client.readAssetTakeoverSnapshot();
  assert.equal(snapshot.account.existingSpotQuantityXaut, 0.1);
  assert.equal(snapshot.account.existingPerpetualQuantityXaut, 0.1);
  assert.equal(snapshot.account.perpetualPositionSide, "short");
  assert.equal(snapshot.fundingRates30d.length, 181);
  assert.equal(snapshot.perpetualInitialMarginUsd, 200);
  assert.equal(snapshot.perpetualLeverage, 2);
  assert.deepEqual(snapshot.spotAskDepth[0], { price: 4_130, quantityBase: 0.5 });
  assert.deepEqual(snapshot.perpetualBidDepth[0], { price: 4_128, quantityBase: 0.5 });

  for (const options of [{ fundingGap: true }, { invalidTakeoverDepth: true }]) {
    const invalid = new RwaBinanceMainnetClient(
      { apiKey: "fake-key", apiSecret: "fake-secret" },
      fixtureFetch({ spotXautFree: "0.1", positionAmount: "-0.1", ...options }),
      () => now,
      ["203.0.113.10"],
    );
    await assert.rejects(
      invalid.readAssetTakeoverSnapshot(),
      providerError("provider_snapshot_invalid"),
    );
  }
});

test("Binance writes enforce the XAUT IOC whitelist and map authoritative orders", async () => {
  const calls: Array<{ path: string; method: string; params: URLSearchParams }> = [];
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    executionFetch(calls),
    () => 1_000,
    ["203.0.113.10"],
  );

  await assert.rejects(
    client.placeOrder({
      category: "spot",
      symbol: "BTCUSDT" as "XAUTUSDT",
      side: "Buy",
      quantityXaut: 0.002,
      limitPrice: 4_130,
      reduceOnly: false,
      orderLinkId: "rwa-test-bad",
    }),
    (error: unknown) => error instanceof RwaBinanceProviderError && error.category === "provider_order_rejected",
  );
  assert.equal(calls.length, 0);

  await client.setPerpetualLeverage(1);
  const spot = await client.placeOrder({
    category: "spot", symbol: "XAUTUSDT", side: "Buy", quantityXaut: 0.002,
    limitPrice: 4_130, reduceOnly: false, orderLinkId: "rwa-test-spot-1",
  });
  const perpetual = await client.placeOrder({
    category: "linear", symbol: "XAUTUSDT", side: "Sell", quantityXaut: 0.002,
    limitPrice: 4_128, reduceOnly: false, orderLinkId: "rwa-test-perp-1",
  });
  const largerThanLegacySmoke = await client.placeOrder({
    category: "spot", symbol: "XAUTUSDT", side: "Buy", quantityXaut: 0.2,
    limitPrice: 4_130, reduceOnly: false, orderLinkId: "rwa-test-spot-large",
  });
  assert.equal(largerThanLegacySmoke.orderId, "101");
  const beforeOverLimit = calls.length;
  await assert.rejects(client.placeOrder({
    category: "spot", symbol: "XAUTUSDT", side: "Buy", quantityXaut: 0.5,
    limitPrice: 4_130, reduceOnly: false, orderLinkId: "rwa-test-over-limit",
  }), providerError("provider_order_rejected"));
  assert.equal(calls.length, beforeOverLimit);
  const spotOrder = await client.awaitOrder("spot", spot.orderId, 1_001);
  assert.equal(spotOrder.status, "Filled");
  assert.equal(spotOrder.positionQuantityXaut, 0.001998);
  assert.equal((await client.awaitOrder("linear", perpetual.orderId, 1_001)).status, "Filled");
  const recovered = await client.findOrderByClientOrderId("linear", "rwa-test-perp-1");
  assert.equal(recovered?.orderLinkId, "rwa-test-perp-1");
  await client.cancelOrder("spot", spot.orderId);

  const leverage = calls.find((item) => item.path === "/fapi/v1/leverage");
  assert.equal(leverage?.method, "POST");
  assert.equal(leverage?.params.get("symbol"), "XAUTUSDT");
  assert.equal(leverage?.params.get("leverage"), "1");
  const spotCreate = calls.find((item) => item.path === "/api/v3/order" && item.method === "POST");
  assert.equal(spotCreate?.params.get("type"), "LIMIT");
  assert.equal(spotCreate?.params.get("timeInForce"), "IOC");
  assert.equal(spotCreate?.params.get("side"), "BUY");
  assert.equal(spotCreate?.params.get("newClientOrderId"), "rwa-test-spot-1");
  const perpetualCreate = calls.find((item) => item.path === "/fapi/v1/order" && item.method === "POST");
  assert.equal(perpetualCreate?.params.get("side"), "SELL");
  assert.equal(perpetualCreate?.params.get("reduceOnly"), "false");
  const recoveredPerpetual = calls.find((item) =>
    item.path === "/fapi/v1/order"
    && item.method === "GET"
    && item.params.get("origClientOrderId") === "rwa-test-perp-1");
  assert.equal(recoveredPerpetual?.params.get("symbol"), "XAUTUSDT");
  assert.equal(calls.some((item) => item.path === "/api/v3/order" && item.method === "DELETE"), true);
});

test("Binance strategy cancellation and PnL ignore non-strategy orders and fills", async () => {
  const calls: Array<{ path: string; method: string; params: URLSearchParams }> = [];
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    executionFetch(calls),
    () => 1_000,
    ["203.0.113.10"],
  );

  await client.cancelStrategyOrders("rwa-owned");
  const deletes = calls.filter((item) => item.method === "DELETE");
  assert.deepEqual(deletes.map((item) => item.params.get("orderId")).sort(), ["11", "21"]);

  const pnl = await client.readStrategyPnl("rwa-owned", 1);
  assert.equal(pnl.legs.spot.quantityXaut, 0.002);
  assert.equal(pnl.legs.perpetual.quantityXaut, 0.002);
  assert.equal(pnl.openOrders.length, 2);
  assert.ok(pnl.openOrders.every((order) => order.orderLinkId.startsWith("rwa-owned")));
  assert.equal(JSON.stringify(pnl).includes("manual-order"), false);
});

function executionFetch(calls: Array<{ path: string; method: string; params: URLSearchParams }>): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method, params: new URLSearchParams(url.searchParams) });
    if (url.pathname === "/api/v3/time") return json({ serverTime: 2_000 });
    if (url.pathname === "/sapi/v1/account/apiRestrictions") return json({
      enableReading: true, enableSpotAndMarginTrading: true, enableFutures: true, enableWithdrawals: false,
      ipRestrict: true, ipList: ["203.0.113.10"],
    });
    if (url.pathname === "/api/v3/account") return json({ uid: 42, canTrade: true, balances: [] });
    if (url.pathname === "/fapi/v2/account") return json({ canTrade: true, multiAssetsMargin: false, assets: [] });
    if (url.pathname === "/fapi/v1/positionSide/dual") return json({ dualSidePosition: false });
    if (url.pathname === "/fapi/v1/leverage") return json({ leverage: 1, symbol: "XAUTUSDT" });
    if (url.pathname === "/api/v3/order" && method === "POST") {
      return json({ orderId: 101, clientOrderId: url.searchParams.get("newClientOrderId") });
    }
    if (url.pathname === "/fapi/v1/order" && method === "POST") {
      return json({ orderId: 201, clientOrderId: url.searchParams.get("newClientOrderId") });
    }
    if ((url.pathname === "/api/v3/order" || url.pathname === "/fapi/v1/order") && method === "DELETE") {
      return json({ orderId: Number(url.searchParams.get("orderId")), status: "CANCELED" });
    }
    if (url.pathname === "/api/v3/order") return json({
      orderId: 101, clientOrderId: "rwa-test-spot-1", status: "FILLED", origQty: "0.002", executedQty: "0.002",
      cummulativeQuoteQty: "8.26", side: "BUY", updateTime: 1_000,
    });
    if (url.pathname === "/fapi/v1/order") return json({
      orderId: 201, clientOrderId: "rwa-test-perp-1", status: "FILLED", origQty: "0.002", executedQty: "0.002",
      avgPrice: "4128", updateTime: 1_000,
    });
    if (url.pathname === "/api/v3/openOrders") return json([
      orderRow(11, "rwa-owned-spot"),
      orderRow(12, "manual-order-spot"),
    ]);
    if (url.pathname === "/fapi/v1/openOrders") return json([
      orderRow(21, "rwa-owned-perp"),
      orderRow(22, "manual-order-perp"),
    ]);
    if (url.pathname === "/api/v3/allOrders") return json([
      orderRow(11, "rwa-owned-spot", "FILLED"),
      orderRow(12, "manual-order-spot", "FILLED"),
    ]);
    if (url.pathname === "/fapi/v1/allOrders") return json([
      orderRow(21, "rwa-owned-perp", "FILLED"),
      orderRow(22, "manual-order-perp", "FILLED"),
    ]);
    if (url.pathname === "/api/v3/myTrades" && url.searchParams.get("orderId") === "101") return json([
      { orderId: 101, isBuyer: true, qty: "0.002", price: "4130", commission: "0.000002", commissionAsset: "XAUT", time: 10 },
    ]);
    if (url.pathname === "/api/v3/myTrades") return json([
      { orderId: 11, isBuyer: true, qty: "0.002", price: "4130", commission: "0.001", commissionAsset: "USDT", time: 10 },
      { orderId: 12, isBuyer: true, qty: "9", price: "4130", commission: "9", commissionAsset: "USDT", time: 11 },
    ]);
    if (url.pathname === "/fapi/v1/userTrades") return json([
      { orderId: 21, side: "SELL", qty: "0.002", price: "4128", commission: "0.001", time: 10 },
      { orderId: 22, side: "SELL", qty: "9", price: "4128", commission: "9", time: 11 },
    ]);
    if (url.pathname === "/fapi/v1/income") return json([{ income: "0.01" }]);
    if (url.pathname === "/api/v3/ticker/bookTicker") return json({ bidPrice: "4131", askPrice: "4132" });
    if (url.pathname === "/fapi/v1/premiumIndex") return json({ markPrice: "4127" });
    return json({ code: -1 }, 404);
  };
}

function orderRow(orderId: number, clientOrderId: string, status = "NEW") {
  return {
    orderId,
    clientOrderId,
    symbol: "XAUTUSDT",
    status,
    origQty: "0.002",
    executedQty: status === "FILLED" ? "0.002" : "0",
    updateTime: 1_000,
  };
}

function fixtureFetch(options: {
  calls?: Array<{ path: string; signed: boolean; timestamp: string | null }>;
  missingSpot?: boolean;
  withdrawalsEnabled?: boolean;
  ipRestricted?: boolean;
  ipList?: string[];
  omitIpList?: boolean;
  restrictionsFailure?: boolean;
  spotXautFree?: string;
  positionAmount?: string;
  fundingGap?: boolean;
  invalidTakeoverDepth?: boolean;
} = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method ?? "GET", "GET");
    const signed = Boolean(init?.headers && new Headers(init.headers).get("X-MBX-APIKEY"));
    options.calls?.push({ path: url.pathname, signed, timestamp: url.searchParams.get("timestamp") });
    if (signed) {
      assert.equal(new Headers(init?.headers).get("X-MBX-APIKEY"), "fake-key");
      const signature = url.searchParams.get("signature");
      assert.ok(signature);
      url.searchParams.delete("signature");
      assert.equal(signature, createHmac("sha256", "fake-secret").update(url.searchParams.toString()).digest("hex"));
    }
    switch (url.pathname) {
      case "/api/v3/time":
        return json({ serverTime: 2_000 });
      case "/sapi/v1/account/apiRestrictions":
        if (options.restrictionsFailure) return json({ code: -1000 }, 503);
        return json({
          enableReading: true,
          enableSpotAndMarginTrading: true,
          enableFutures: true,
          enableWithdrawals: Boolean(options.withdrawalsEnabled),
          ipRestrict: options.ipRestricted ?? true,
          ...(options.omitIpList ? {} : { ipList: options.ipList ?? ["203.0.113.10"] }),
        });
      case "/api/v3/account":
        return json({
          uid: 42,
          canTrade: true,
          balances: [
            { asset: "USDT", free: "18", locked: "0" },
            { asset: "XAUT", free: options.spotXautFree ?? "0", locked: "0" },
          ],
        });
      case "/fapi/v2/account":
        return json({
          canTrade: true,
          multiAssetsMargin: false,
          availableBalance: "17",
          assets: [{ asset: "USDT", availableBalance: "17" }],
        });
      case "/fapi/v1/positionSide/dual":
        return json({ dualSidePosition: false });
      case "/api/v3/exchangeInfo":
        return json({
          symbols: options.missingSpot ? [] : [{
            symbol: "XAUTUSDT",
            status: "TRADING",
            baseAsset: "XAUT",
            quoteAsset: "USDT",
            isSpotTradingAllowed: true,
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.01" },
              { filterType: "LOT_SIZE", minQty: "0.0001", stepSize: "0.0001" },
              { filterType: "NOTIONAL", minNotional: "5" },
            ],
          }],
        });
      case "/fapi/v1/exchangeInfo":
        return json({
          symbols: [{
            symbol: "XAUTUSDT",
            status: "TRADING",
            contractType: "PERPETUAL",
            baseAsset: "XAUT",
            quoteAsset: "USDT",
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.01" },
              { filterType: "LOT_SIZE", minQty: "0.001", stepSize: "0.001" },
              { filterType: "MIN_NOTIONAL", notional: "5" },
            ],
          }],
        });
      case "/sapi/v1/asset/tradeFee":
        return json([{ symbol: "XAUTUSDT", takerCommission: "0.001" }]);
      case "/fapi/v1/commissionRate":
        return json({ symbol: "XAUTUSDT", takerCommissionRate: "0.0005" });
      case "/fapi/v2/positionRisk":
        return json(options.positionAmount === undefined ? [] : [{
          symbol: "XAUTUSDT",
          positionAmt: options.positionAmount,
          liquidationPrice: "6000",
          initialMargin: "200",
          leverage: "2",
        }]);
      case "/api/v3/openOrders":
      case "/fapi/v1/openOrders":
        return json([]);
      case "/api/v3/ticker/bookTicker":
        return json({ bidPrice: "4129", askPrice: "4130" });
      case "/fapi/v1/ticker/bookTicker":
        return json({ bidPrice: "4128", askPrice: "4129" });
      case "/fapi/v1/premiumIndex":
        return json({ markPrice: "4128.5", lastFundingRate: "0.0001", nextFundingTime: 5_000 });
      case "/fapi/v1/fundingInfo":
        return json([{ symbol: "XAUTUSDT", fundingIntervalHours: 4 }]);
      case "/api/v3/depth":
        if (options.invalidTakeoverDepth && url.searchParams.get("limit") === "500") {
          return json({ bids: [], asks: [] });
        }
        return json({ bids: [["4129", "0.5"]], asks: [["4130", "0.5"]] });
      case "/fapi/v1/depth":
        return json({ bids: [["4128", "0.5"]], asks: [["4129", "0.5"]] });
      case "/fapi/v1/fundingRate": {
        const start = Number(url.searchParams.get("startTime"));
        const end = Number(url.searchParams.get("endTime"));
        const interval = 4 * 60 * 60_000;
        const rows = Array.from(
          { length: Math.floor((end - start) / interval) + 1 },
          (_, index) => ({
            fundingTime: start + index * interval,
            fundingRate: "0.0001",
          }),
        );
        return json(options.fundingGap ? rows.filter((_, index) => index !== 80) : rows);
      }
      default:
        return json({ code: -1 }, 404);
    }
  };
}

function providerError(category: string) {
  return (error: unknown) => error instanceof RwaBinanceProviderError && error.category === category;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
