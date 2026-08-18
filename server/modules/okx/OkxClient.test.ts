import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createOkxSignature, mapOkxOrderStatus, OkxClient, OkxProviderError } from "./OkxClient";

const credentials = Object.freeze({
  apiKey: "okx-api-key",
  apiSecret: "okx-api-secret",
  passphrase: "okx-passphrase",
});
const now = 1_800_000_000_000;
const timestamp = new Date(now).toISOString();

test("signs the exact OKX REST payload", () => {
  assert.equal(
    createOkxSignature(
      credentials.apiSecret,
      timestamp,
      "POST",
      "/api/v5/trade/order",
      "{\"instId\":\"DOGE-USDT-SWAP\",\"tdMode\":\"cross\"}",
    ),
    "G+iUZ1XjxBWDeZmaRxveXU11KgRIxQQe2T7PMQ1IxeY=",
  );
});

test("place order maps request body and authentication headers", async () => {
  const calls: Array<{ body: any; headers: Headers; method: string; path: string }> = [];
  const client = new OkxClient(() => credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        path: url.pathname,
      });
      return Response.json({
        code: "0",
        data: [{ ordId: "12345", clOrdId: "clientA1", tag: "", ts: String(now), sCode: "0", sMsg: "" }],
      });
    }) as typeof fetch,
  });

  const result = await client.placeOrder({
    instId: "DOGE-USDT-SWAP",
    tdMode: "cross",
    side: "buy",
    ordType: "limit",
    quantity: "12.5",
    price: "0.12345",
    clOrdId: "clientA1",
    reduceOnly: false,
  });

  assert.deepEqual(result, { ordId: "12345", clOrdId: "clientA1", instId: "DOGE-USDT-SWAP" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.path, "/api/v5/trade/order");
  assert.deepEqual(calls[0]?.body, {
    instId: "DOGE-USDT-SWAP",
    tdMode: "cross",
    side: "buy",
    ordType: "limit",
    sz: "12.5",
    clOrdId: "clientA1",
    px: "0.12345",
    reduceOnly: "false",
  });
  assert.equal(calls[0]?.headers.get("OK-ACCESS-KEY"), credentials.apiKey);
  assert.equal(calls[0]?.headers.get("OK-ACCESS-PASSPHRASE"), credentials.passphrase);
  assert.equal(calls[0]?.headers.get("OK-ACCESS-TIMESTAMP"), timestamp);
  assert.equal(calls[0]?.headers.get("OK-ACCESS-SIGN"), createOkxSignature(
    credentials.apiSecret,
    timestamp,
    "POST",
    "/api/v5/trade/order",
    JSON.stringify(calls[0]?.body),
  ));
});

test("market reduce-only close order omits price and preserves reduceOnly=true", async () => {
  let body: any = null;
  const client = new OkxClient(() => credentials, {
    now: () => now,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ code: "0", data: [{ ordId: "12346", clOrdId: "closeA1", sCode: "0", sMsg: "" }] });
    }) as typeof fetch,
  });

  await client.placeOrder({
    instId: "DOGE-USDT-SWAP",
    tdMode: "cross",
    side: "sell",
    ordType: "market",
    quantity: "12.5",
    clOrdId: "closeA1",
    reduceOnly: true,
  });

  assert.deepEqual(body, {
    instId: "DOGE-USDT-SWAP",
    tdMode: "cross",
    side: "sell",
    ordType: "market",
    sz: "12.5",
    clOrdId: "closeA1",
    reduceOnly: "true",
  });
});

test("Spot market buy sends cash tdMode and base_ccy target currency", async () => {
  let body: unknown;
  const client = new OkxClient(() => credentials, {
    now: () => now,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ code: "0", data: [{ ordId: "12347", clOrdId: "spotA1", sCode: "0", sMsg: "" }] });
    }) as typeof fetch,
  });
  const result = await client.placeOrder({ instId: "DOGE-USDT", tdMode: "cash", side: "buy", ordType: "market", quantity: "100", clOrdId: "spotA1", targetCurrency: "base_ccy" });
  assert.deepEqual(body, { instId: "DOGE-USDT", tdMode: "cash", side: "buy", ordType: "market", sz: "100", clOrdId: "spotA1", tgtCcy: "base_ccy" });
  assert.deepEqual(result, { instId: "DOGE-USDT", ordId: "12347", clOrdId: "spotA1" });
});

test("place order rejects incomplete or mismatched order identity without requiring response instId", async (t) => {
  for (const fixture of [
    { name: "mismatched clOrdId", row: { ordId: "12345", clOrdId: "differentA1", sCode: "0" } },
    { name: "missing ordId", row: { clOrdId: "clientA1", sCode: "0" } },
    { name: "missing clOrdId", row: { ordId: "12345", sCode: "0" } },
  ]) {
    await t.test(fixture.name, async () => {
      const client = new OkxClient(() => credentials, {
        now: () => now,
        fetchImpl: (async () => Response.json({ code: "0", data: [fixture.row] })) as typeof fetch,
      });
      await assert.rejects(
        () => client.placeOrder({
          instId: "DOGE-USDT-SWAP",
          tdMode: "cross",
          side: "buy",
          ordType: "market",
          quantity: "1",
          clOrdId: "clientA1",
        }),
        (error: unknown) => error instanceof OkxProviderError
          && error.category === "provider_response_invalid",
      );
    });
  }
});

test("place order requires an exact string zero item success code", async (t) => {
  const invalidCodes: Array<{ name: string; sCode?: unknown }> = [
    { name: "missing" },
    { name: "null", sCode: null },
    { name: "numeric zero", sCode: 0 },
    { name: "empty string", sCode: "" },
    { name: "non-string", sCode: {} },
  ];
  for (const fixture of invalidCodes) {
    await t.test(fixture.name, async () => {
      const row = {
        ordId: "12345",
        clOrdId: "clientA1",
        ...(fixture.sCode === undefined ? {} : { sCode: fixture.sCode }),
      };
      const client = new OkxClient(() => credentials, {
        now: () => now,
        fetchImpl: (async () => Response.json({ code: "0", data: [row] })) as typeof fetch,
      });
      await assert.rejects(
        () => client.placeOrder({
          instId: "DOGE-USDT-SWAP",
          tdMode: "cross",
          side: "buy",
          ordType: "market",
          quantity: "1",
          clOrdId: "clientA1",
        }),
        (error: unknown) => error instanceof OkxProviderError
          && error.category === "provider_response_invalid",
      );
    });
  }

  await t.test("non-zero string", async () => {
    const client = new OkxClient(() => credentials, {
      now: () => now,
      fetchImpl: (async () => Response.json({
        code: "0",
        data: [{ ordId: "12345", clOrdId: "clientA1", sCode: "51000" }],
      })) as typeof fetch,
    });
    await assert.rejects(
      () => client.placeOrder({
        instId: "DOGE-USDT-SWAP",
        tdMode: "cross",
        side: "buy",
        ordType: "market",
        quantity: "1",
        clOrdId: "clientA1",
      }),
      (error: unknown) => error instanceof OkxProviderError
        && error.category === "provider_request_rejected"
        && error.providerCode === "51000",
    );
  });
});

test("get order parses Decimal strings and status mapping", async () => {
  const client = new OkxClient(() => credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/v5/trade/order");
      assert.equal(url.searchParams.get("instId"), "DOGE-USDT-SWAP");
      assert.equal(url.searchParams.get("clOrdId"), "clientA1");
      return Response.json({ code: "0", data: [{
        instId: "DOGE-USDT-SWAP",
        ordId: "12345",
        clOrdId: "clientA1",
        state: "partially_filled",
        sz: "12.5",
        accFillSz: "1.25",
        avgPx: "0.12345",
        fee: "-0.001",
        feeCcy: "USDT",
        uTime: "1800000000123",
      }] });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.getOrder({ instId: "DOGE-USDT-SWAP", clOrdId: "clientA1" }), {
    instId: "DOGE-USDT-SWAP",
    ordId: "12345",
    clOrdId: "clientA1",
    status: "PENDING_CONFIRMATION",
    statusReason: null,
    rawState: "partially_filled",
    requestedQuantity: "12.5",
    filledQuantity: "1.25",
    averagePrice: "0.12345",
    fee: "-0.001",
    feeCcy: "USDT",
    updatedAt: 1_800_000_000_123,
  });
});

test("Spot order preserves malformed fee evidence for UNKNOWN reconciliation", async () => {
  const client = new OkxClient(() => credentials, {
    now: () => now,
    fetchImpl: (async () => Response.json({ code: "0", data: [{
      instId: "DOGE-USDT", ordId: "12346", clOrdId: "spotFeeA1", side: "buy",
      state: "filled", sz: "100", accFillSz: "100", avgPx: "0.1",
      fee: "not-a-decimal", feeCcy: "USDT", uTime: String(now),
    }] })) as typeof fetch,
  });

  const order = await client.getOrder({ instId: "DOGE-USDT", clOrdId: "spotFeeA1" });
  assert.equal(order.fee, "not-a-decimal");
  assert.equal(order.feeCcy, "USDT");
});

test("Spot balance read returns affected cash balances as Decimal strings", async () => {
  const client = new OkxClient(() => credentials, {
    now: () => now,
    fetchImpl: (async () => Response.json({ code: "0", data: [{ details: [
      { ccy: "DOGE", cashBal: "12.3" },
      { ccy: "USDT", cashBal: "45.67" },
    ] }] })) as typeof fetch,
  });

  assert.deepEqual(await client.getSpotBalances("DOGE", "USDT"), {
    baseTotal: "12.3",
    quoteTotal: "45.67",
  });
});

test("Spot balance read treats omitted requested currencies as zero", async () => {
  for (const [details, expected] of [
    [
      [{ ccy: "DOGE", cashBal: "12.3" }],
      { baseTotal: "12.3", quoteTotal: "0" },
    ],
    [
      [{ ccy: "USDT", cashBal: "45.67" }],
      { baseTotal: "0", quoteTotal: "45.67" },
    ],
  ] as const) {
    const client = new OkxClient(() => credentials, {
      now: () => now,
      fetchImpl: (async () => Response.json({ code: "0", data: [{ details }] })) as typeof fetch,
    });
    assert.deepEqual(await client.getSpotBalances("DOGE", "USDT"), expected);
  }
});

test("Spot balance read rejects duplicate currencies and malformed balances", async () => {
  for (const details of [
    [
      { ccy: "DOGE", cashBal: "12.3" },
      { ccy: "DOGE", cashBal: "12.4" },
      { ccy: "USDT", cashBal: "45.67" },
    ],
    [
      { ccy: "DOGE", cashBal: "not-a-decimal" },
      { ccy: "USDT", cashBal: "45.67" },
    ],
  ]) {
    const client = new OkxClient(() => credentials, {
      now: () => now,
      fetchImpl: (async () => Response.json({ code: "0", data: [{ details }] })) as typeof fetch,
    });
    await assert.rejects(
      () => client.getSpotBalances("DOGE", "USDT"),
      (error: unknown) => error instanceof OkxProviderError && error.category === "provider_response_invalid",
    );
  }
});

test("cancel order maps request and response identity", async () => {
  const client = new OkxClient(() => credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/v5/trade/cancel-order");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        instId: "DOGE-USDT-SWAP",
        ordId: "12345",
      });
      return Response.json({ code: "0", data: [{ instId: "DOGE-USDT-SWAP", ordId: "12345", clOrdId: "clientA1", sCode: "0" }] });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.cancelOrder({ instId: "DOGE-USDT-SWAP", ordId: "12345" }), {
    instId: "DOGE-USDT-SWAP",
    ordId: "12345",
    clOrdId: "clientA1",
  });
});

test("get position parses perpetual position with Decimal strings", async () => {
  const client = new OkxClient(() => credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/v5/account/positions");
      assert.equal(url.searchParams.get("instId"), "DOGE-USDT-SWAP");
      return Response.json({ code: "0", data: [{
        instId: "DOGE-USDT-SWAP",
        posSide: "short",
        pos: "-12.5",
        avgPx: "0.123",
        markPx: "0.120",
        liqPx: "0.222",
        uTime: "1800000000999",
      }] });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.getPosition("DOGE-USDT-SWAP"), [{
    instId: "DOGE-USDT-SWAP",
    side: "short",
    quantity: "12.5",
    averagePrice: "0.123",
    markPrice: "0.120",
    liquidationPrice: "0.222",
    updatedAt: 1_800_000_000_999,
  }]);
});

test("readiness GET paths read account identity and open orders without mutation methods", async () => {
  const calls: Array<{ method: string; path: string; query: string; body: string | null }> = [];
  const client = new OkxClient(() => credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        query: url.search,
        body: init?.body === undefined ? null : String(init.body),
      });
      if (url.pathname === "/api/v5/account/config") {
        return Response.json({ code: "0", data: [{ uid: "123456789", acctLv: "3" }] });
      }
      if (url.pathname === "/api/v5/trade/orders-pending") {
        return Response.json({ code: "0", data: [{
          instId: "DOGE-USDT-SWAP",
          ordId: "12347",
          clOrdId: "openA1",
          state: "live",
          sz: "12.5",
          accFillSz: "0",
          avgPx: "",
          fee: "0",
          uTime: "1800000000999",
        }] });
      }
      throw new Error(`Unexpected path: ${url.pathname}`);
    }) as typeof fetch,
  });

  const identity = await client.getAccountIdentity();
  const openOrders = await client.getOpenOrders("DOGE-USDT-SWAP");

  assert.equal(identity.accountId, `okx:${identity.accountFingerprint}`);
  assert.equal(identity.accountLevel, "3");
  assert.deepEqual(openOrders, [{
    instId: "DOGE-USDT-SWAP",
    ordId: "12347",
    clOrdId: "openA1",
    status: "SUBMITTED",
    statusReason: null,
    rawState: "live",
    requestedQuantity: "12.5",
    filledQuantity: "0",
    averagePrice: null,
    fee: "0",
    feeCcy: null,
    updatedAt: 1_800_000_000_999,
  }]);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
  assert.equal(calls.every((call) => call.body === null), true);
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/v5/account/config",
    "/api/v5/trade/orders-pending",
  ]);
  assert.equal(calls[1]?.query, "?instId=DOGE-USDT-SWAP");
});

test("validates Provider-derived OKX identity and perpetual execution permissions with one signed GET", async () => {
  let providerReads = 0;
  const client = new OkxClient(() => credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      providerReads += 1;
      assert.equal(new URL(String(input)).pathname, "/api/v5/account/config");
      assert.equal(init?.method, "GET");
      return Response.json({ code: "0", data: [{
        uid: "123456789",
        acctLv: "3",
        posMode: "net_mode",
        perm: "read_only,trade",
        ip: "203.0.113.10",
      }] });
    }) as typeof fetch,
  });

  const access = await client.validateAccess();
  const uidHash = createHash("sha256").update("okx:123456789").digest("hex");

  assert.equal(access.accountId, `okx:${uidHash.slice(0, 16)}`);
  assert.equal(access.accountFingerprint, uidHash.slice(0, 16));
  assert.equal(access.uidHash, uidHash);
  assert.deepEqual(access.permissions, {
    read: true,
    spotTrade: true,
    contractTrade: true,
    withdraw: false,
    ipRestricted: true,
    accountLevelSupported: true,
    positionModeSupported: true,
    providerVerified: true,
    executionEnabled: true,
  });
  assert.equal(providerReads, 1);
});

test("reports insufficient OKX permission and account settings without enabling execution", async () => {
  const client = new OkxClient(() => credentials, {
    fetchImpl: (async () => Response.json({ code: "0", data: [{
      uid: "987654321",
      acctLv: "1",
      posMode: "long_short_mode",
      perm: "read_only,withdraw",
      ip: "",
    }] })) as typeof fetch,
  });

  assert.deepEqual((await client.validateAccess()).permissions, {
    read: true,
    spotTrade: false,
    contractTrade: false,
    withdraw: true,
    ipRestricted: false,
    accountLevelSupported: false,
    positionModeSupported: false,
    providerVerified: true,
    executionEnabled: false,
  });
});

test("status mapping preserves UNKNOWN reason", () => {
  assert.deepEqual(mapOkxOrderStatus("filled"), { status: "CONFIRMED", reason: null });
  assert.deepEqual(mapOkxOrderStatus("live"), { status: "SUBMITTED", reason: null });
  assert.deepEqual(mapOkxOrderStatus("partially_filled"), { status: "PENDING_CONFIRMATION", reason: null });
  assert.deepEqual(mapOkxOrderStatus("canceled"), { status: "FAILED", reason: null });
  assert.deepEqual(mapOkxOrderStatus("cancelled"), { status: "FAILED", reason: null });
  assert.deepEqual(mapOkxOrderStatus("rejected"), { status: "FAILED", reason: null });
  assert.deepEqual(mapOkxOrderStatus("mystery"), { status: "UNKNOWN", reason: "unmapped OKX order state: mystery" });
});

test("provider and item errors are mapped without swallowing reasons", async () => {
  const providerRejected = new OkxClient(() => credentials, {
    fetchImpl: (async () => Response.json({ code: "50101", msg: "bad key", data: [] }, { status: 401 })) as typeof fetch,
  });
  await assert.rejects(
    () => providerRejected.getOrder({ instId: "DOGE-USDT-SWAP", clOrdId: "clientA1" }),
    (error: unknown) => error instanceof OkxProviderError
      && error.category === "credential_validation_failed"
      && error.providerCode === "50101",
  );

  const itemRejected = new OkxClient(() => credentials, {
    fetchImpl: (async () => Response.json({ code: "0", data: [{ sCode: "51008", sMsg: "insufficient balance" }] })) as typeof fetch,
  });
  await assert.rejects(
    () => itemRejected.placeOrder({
      instId: "DOGE-USDT-SWAP",
      tdMode: "cross",
      side: "buy",
      ordType: "market",
      quantity: "1",
      clOrdId: "clientA1",
    }),
    (error: unknown) => error instanceof OkxProviderError
      && error.category === "provider_request_rejected"
      && error.providerCode === "51008",
  );
});
