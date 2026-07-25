import assert from "node:assert/strict";
import test from "node:test";
import { RwaBybitMainnetClient, RwaBybitProviderError } from "./RwaBybitMainnetClient";
import { createUnmonitoredActivityContinuity } from "./RwaProviderActivityContinuity";
import {
  createNeutralExecutionRecord,
  RwaNeutralHedgeExecutionEngine,
} from "./RwaNeutralHedgeExecutionEngine";
import {
  defaultRwaExecutionConfig,
  RwaExecutionSafetyError,
} from "./RwaNeutralExecutionTypes";

test("Bybit attribution performs private source reads and is fail-closed when any source is unavailable", async () => {
  let calls = 0;
  const client = new RwaBybitMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    (async () => {
      calls += 1;
      throw new Error("unexpected network call");
    }) as typeof fetch,
    () => 2_000,
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

test("Bybit scans cursor-capable V5 endpoints but cannot certify a non-atomic mutation window", async () => {
  const paths: string[] = [];
  const client = new RwaBybitMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    (async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/v5/user/query-api") {
        return jsonResponse({
          retCode: 0,
          retMsg: "OK",
          result: { uta: 1, isMaster: 0, parentUid: "123" },
        });
      }
      const result = url.pathname.includes("/deposit/") || url.pathname.includes("/withdraw/")
        ? { rows: [], nextPageCursor: "" }
        : url.pathname.includes("small-balance-history")
          ? { records: [], cursor: "" }
          : { list: [], nextPageCursor: "" };
      return jsonResponse({ retCode: 0, retMsg: "OK", result });
    }) as typeof fetch,
    () => 2_000,
  );
  const result = await client.readPositionAttribution({
    strategyOrderPrefix: "rwa-scope",
    strategyOrderPrefixes: ["rwa-order"],
    since: 1_000,
    continuity: createUnmonitoredActivityContinuity(1_000),
  });
  assert.equal(result.coverage, "incomplete");
  assert.equal(result.checkedThrough, 1_000);
  assert.ok(paths.includes("/v5/order/history"));
  assert.ok(paths.includes("/v5/execution/list"));
  assert.ok(paths.includes("/v5/account/transaction-log"));
  assert.ok(paths.includes("/v5/asset/transfer/query-universal-transfer-list"));
  assert.ok(paths.includes("/v5/asset/fundinghistory"));
});

test("Bybit remains incomplete when a concurrent event is correctly excluded by endTime", async () => {
  let concurrentEventCreated = false;
  const client = new RwaBybitMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v5/user/query-api") {
        return jsonResponse({
          retCode: 0,
          retMsg: "OK",
          result: { uta: 1, isMaster: 0, parentUid: "123" },
        });
      }
      if (url.pathname === "/v5/order/history" && url.searchParams.get("category") === "spot") {
        concurrentEventCreated = true;
      }
      if (url.pathname === "/v5/execution/list" && url.searchParams.get("category") === "spot") {
        const event = {
          execId: "manual-1",
          execTime: 2_001,
          orderId: "manual-order",
          orderLinkId: "",
          symbol: "XAUTUSDT",
        };
        const rows = event.execTime <= Number(url.searchParams.get("endTime")) ? [event] : [];
        return jsonResponse({ retCode: 0, retMsg: "OK", result: { list: rows, nextPageCursor: "" } });
      }
      const result = url.pathname.includes("/deposit/") || url.pathname.includes("/withdraw/")
        ? { rows: [], nextPageCursor: "" }
        : url.pathname.includes("small-balance-history")
          ? { records: [], cursor: "" }
          : { list: [], nextPageCursor: "" };
      return jsonResponse({ retCode: 0, retMsg: "OK", result });
    }) as typeof fetch,
    () => 2_000,
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

test("a strict cutoff race reaches zero leverage or order mutations in the real Bybit adapter", async () => {
  const mutationMethods: string[] = [];
  const client = new RwaBybitMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    (async (input, init) => {
      const url = new URL(String(input));
      if (init?.method && init.method !== "GET") mutationMethods.push(`${init.method}:${url.pathname}`);
      if (url.pathname === "/v5/user/query-api") {
        return jsonResponse({
          retCode: 0,
          retMsg: "OK",
          result: { uta: 1, isMaster: 0, parentUid: "123" },
        });
      }
      if (url.pathname === "/v5/execution/list" && url.searchParams.get("category") === "spot") {
        const event = {
          execId: "manual-1",
          execTime: 2_001,
          orderId: "manual-order",
          orderLinkId: "",
          symbol: "XAUTUSDT",
        };
        const rows = event.execTime <= Number(url.searchParams.get("endTime")) ? [event] : [];
        return jsonResponse({ retCode: 0, retMsg: "OK", result: { list: rows, nextPageCursor: "" } });
      }
      const result = url.pathname.includes("/deposit/") || url.pathname.includes("/withdraw/")
        ? { rows: [], nextPageCursor: "" }
        : url.pathname.includes("small-balance-history")
          ? { records: [], cursor: "" }
          : { list: [], nextPageCursor: "" };
      return jsonResponse({ retCode: 0, retMsg: "OK", result });
    }) as typeof fetch,
    () => 2_000,
  );
  const execution = createNeutralExecutionRecord({
    userId: "user-a",
    accountId: "bybit:test-account",
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
        accountId: "bybit:test-account",
        accountFingerprint: "test-account",
        fetchedAt: 2_000,
        accountMode: "uta",
        permissions: {
          read: true,
          spotTrade: true,
          contractTrade: true,
          withdraw: false,
          uta: true,
          ipRestricted: true,
          ownerSubaccount: true,
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

test("Bybit adapter derives account identity and reports writable permissions, UTA, IP and withdraw state", async () => {
  const requests: Request[] = [];
  const client = new RwaBybitMainnetClient(
    { apiKey: "api-key-value", apiSecret: "api-secret-value" },
    (async (input, init) => {
      requests.push(new Request(input, init));
      return jsonResponse({
        retCode: 0,
        result: {
          readOnly: 0,
          permissions: {
            ContractTrade: ["Order", "Position"],
            Spot: ["SpotTrade"],
            Wallet: ["AccountTransfer"],
          },
          ips: ["203.0.113.10"],
          uta: 1,
          isMaster: 0,
          parentUid: "10001",
          userID: "20002",
        },
      });
    }) as typeof fetch,
    () => 1_800_000_000_000,
  );

  const access = await client.validateAccess();
  assert.equal(access.accountMode, "uta");
  assert.match(access.accountId, /^bybit:[a-f0-9]{16}$/);
  assert.match(access.accountFingerprint, /^[a-f0-9]{16}$/);
  assert.deepEqual(access.permissions, {
      read: true,
      spotTrade: true,
      contractTrade: true,
      withdraw: false,
      uta: true,
      ipRestricted: true,
      ownerSubaccount: true,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.headers.get("x-bapi-api-key"), "api-key-value");
  assert.match(requests[0]?.headers.get("x-bapi-sign") ?? "", /^[a-f0-9]{64}$/);
});

test("Bybit adapter never exposes raw provider messages, URLs or credential-like content", async () => {
  const client = new RwaBybitMainnetClient(
    { apiKey: "api-key-value", apiSecret: "api-secret-value" },
    (async () => jsonResponse({
      retCode: 10005,
      retMsg: "permission denied secret=leak https://private.example/path",
      result: {},
    }, 403)) as typeof fetch,
  );
  await assert.rejects(client.validateAccess(), (error: unknown) => {
    assert.ok(error instanceof RwaBybitProviderError);
    assert.equal(error.category, "provider_permission_error");
    assert.doesNotMatch(error.message, /leak|secret|https|private\.example|api-key-value|api-secret-value/i);
    return true;
  });
});

test("Bybit adapter classifies expired and revoked credentials without exposing raw errors", async () => {
  for (const [retCode, expected] of [[33004, "provider_credential_expired"], [10003, "provider_credential_revoked"]] as const) {
    const client = new RwaBybitMainnetClient(
      { apiKey: "api-key-value", apiSecret: "api-secret-value" },
      (async () => jsonResponse({ retCode, retMsg: "raw secret=must-not-leak", result: {} }, 403)) as typeof fetch,
    );
    await assert.rejects(client.validateAccess(), (error: unknown) => {
      assert.ok(error instanceof RwaBybitProviderError);
      assert.equal(error.category, expected);
      assert.doesNotMatch(error.message, /must-not-leak|api-secret-value/);
      return true;
    });
  }
});

test("Bybit order creation is treated as acceptance only and authoritative order status is queried afterwards", async () => {
  const paths: string[] = [];
  const client = new RwaBybitMainnetClient(
    { apiKey: "api-key-value", apiSecret: "api-secret-value" },
    (async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      paths.push(url.pathname);
      if (url.pathname === "/v5/order/create") {
        return jsonResponse({ retCode: 0, result: { orderId: "order-1", orderLinkId: "rwaxaut-test" } });
      }
      return jsonResponse({
        retCode: 0,
        result: { list: [{
          orderId: "order-1",
          orderLinkId: "rwaxaut-test",
          orderStatus: "Filled",
          qty: "0.002",
          cumExecQty: "0.002",
          avgPrice: "4130",
          cumExecFee: "0.001",
          updatedTime: "1800000000000",
        }] },
      });
    }) as typeof fetch,
    () => 1_800_000_000_000,
  );
  const accepted = await client.placeOrder({
    category: "spot",
    symbol: "XAUTUSDT",
    side: "Buy",
    quantityXaut: 0.002,
    limitPrice: 4130,
    reduceOnly: false,
    orderLinkId: "rwaxaut-test",
  });
  assert.deepEqual(accepted, { orderId: "order-1", orderLinkId: "rwaxaut-test" });
  const final = await client.awaitOrder("spot", accepted.orderId, 1_800_000_000_100);
  assert.equal(final.status, "Filled");
  assert.deepEqual(paths, ["/v5/order/create", "/v5/order/realtime"]);
});

test("Bybit asset order preview follows every open-order cursor for both XAUT legs", async () => {
  const client = new RwaBybitMainnetClient(
    { apiKey: "api-key-value", apiSecret: "api-secret-value" },
    (async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/v5/order/realtime");
      assert.equal(url.searchParams.get("limit"), "50");
      const category = url.searchParams.get("category");
      const cursor = url.searchParams.get("cursor");
      const list = category === "spot"
        ? cursor === "spot-next"
          ? [{ symbol: "XAUTUSDT", orderId: "spot-2", orderLinkId: "manual-spot-2" }]
          : [{ symbol: "XAUTUSDT", orderId: "spot-1", orderLinkId: "manual-spot-1" }]
        : [{ symbol: "XAUTUSDT", orderId: "linear-1", orderLinkId: "manual-linear-1" }];
      return jsonResponse({
        retCode: 0,
        result: {
          list,
          nextPageCursor: category === "spot" && !cursor ? "spot-next" : "",
        },
      });
    }) as typeof fetch,
  );
  const orders = await client.listAssetOpenOrders();
  assert.deepEqual(orders.map(({ category, orderId }) => ({ category, orderId })), [
    { category: "spot", orderId: "spot-1" },
    { category: "spot", orderId: "spot-2" },
    { category: "linear", orderId: "linear-1" },
  ]);
});

test("Bybit asset order preview rejects duplicate cursors before claiming a complete preview", async () => {
  const client = new RwaBybitMainnetClient(
    { apiKey: "api-key-value", apiSecret: "api-secret-value" },
    (async (input) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get("cursor");
      return jsonResponse({
        retCode: 0,
        result: {
          list: [{
            symbol: "XAUTUSDT",
            orderId: `${url.searchParams.get("category")}-${cursor ?? "first"}`,
            orderLinkId: "",
          }],
          nextPageCursor: "same",
        },
      });
    }) as typeof fetch,
  );
  await assert.rejects(client.listAssetOpenOrders(), (error: unknown) =>
    error instanceof RwaBybitProviderError && error.category === "provider_snapshot_invalid");
});

test("Bybit preflight rejects malformed authoritative position quantities", async () => {
  for (const invalid of [
    { spot: "NaN", perpetual: "0" },
    { spot: "0", perpetual: "Infinity" },
  ]) {
    const client = new RwaBybitMainnetClient(
      { apiKey: "api-key-value", apiSecret: "api-secret-value" },
      bybitPreflightFetch(invalid),
      () => 1_800_000_000_000,
    );
    await assert.rejects(client.readPreflightSnapshot(), (error: unknown) =>
      error instanceof RwaBybitProviderError && error.category === "provider_snapshot_invalid");
  }
});

function bybitPreflightFetch(invalid: { spot: string; perpetual: string }): typeof fetch {
  return (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const category = url.searchParams.get("category");
    if (url.pathname === "/v5/user/query-api") {
      return jsonResponse({ retCode: 0, result: {
        readOnly: 0,
        permissions: { ContractTrade: ["Order", "Position"], Spot: ["SpotTrade"], Wallet: ["AccountTransfer"] },
        ips: ["203.0.113.10"],
        uta: 1,
        isMaster: 0,
        parentUid: "10001",
        userID: "20002",
      } });
    }
    if (url.pathname === "/v5/account/wallet-balance") {
      return jsonResponse({ retCode: 0, result: { list: [{
        totalAvailableBalance: "25",
        coin: [
          { coin: "USDT", availableToWithdraw: "25" },
          { coin: "XAUT", walletBalance: invalid.spot },
        ],
      }] } });
    }
    if (url.pathname === "/v5/account/fee-rate") {
      return jsonResponse({ retCode: 0, result: { list: [{ takerFeeRate: "0.001" }] } });
    }
    if (url.pathname === "/v5/market/instruments-info") {
      return jsonResponse({ retCode: 0, result: { list: [category === "spot" ? {
        status: "Trading",
        lotSizeFilter: { basePrecision: "0.0001", minOrderAmt: "5" },
        priceFilter: { tickSize: "0.01" },
      } : {
        status: "Trading",
        fundingInterval: "240",
        lotSizeFilter: { minOrderQty: "0.001", qtyStep: "0.001", minNotionalValue: "5" },
        priceFilter: { tickSize: "0.1" },
      }] } });
    }
    if (url.pathname === "/v5/market/tickers") {
      return jsonResponse({ retCode: 0, result: { list: [category === "spot"
        ? { bid1Price: "4129", ask1Price: "4130" }
        : { bid1Price: "4128", ask1Price: "4129", markPrice: "4128.5", fundingRate: "0.0001" }] } });
    }
    if (url.pathname === "/v5/position/list") {
      return jsonResponse({ retCode: 0, result: { list: [{
        symbol: "XAUTUSDT",
        size: invalid.perpetual,
        liqPrice: "0",
      }] } });
    }
    if (url.pathname === "/v5/order/realtime") {
      return jsonResponse({ retCode: 0, result: { list: [] } });
    }
    return jsonResponse({ retCode: 10001, result: {} }, 400);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
