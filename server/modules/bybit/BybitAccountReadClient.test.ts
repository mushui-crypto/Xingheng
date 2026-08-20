import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { BybitAccountReadClient, BybitAccountReadError } from "./BybitAccountReadClient";

const now = 1_800_000_000_000;
const credentials = { apiKey: "bybit-key", apiSecret: "bybit-secret" };

test("reads unified balances without mapping transferBalance into available", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new BybitAccountReadClient(credentials, {
    baseUrl: "https://bybit.example.test",
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      return Response.json(bybitResponse(url));
    }) as typeof fetch,
  });

  const snapshot = await client.readAccountSnapshot();

  assert.equal(snapshot.uid, "91234567");
  assert.equal(snapshot.unifiedMarginStatus, 5);
  assert.equal(snapshot.marginMode, "REGULAR_MARGIN");
  assert.deepEqual(snapshot.balances, [
    { asset: "USDT", accountType: "unified", total: 120, available: null, locked: 20 },
    { asset: "BTC", accountType: "unified", total: 0.002, available: null, locked: 0.0005 },
  ]);
  assert.deepEqual(requests.map(({ url }) => url.pathname).sort(), [
    "/v5/account/info",
    "/v5/account/wallet-balance",
    "/v5/user/query-api",
  ]);
  for (const { url, init } of requests) {
    assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers);
    const query = url.searchParams.toString();
    assert.equal(headers.get("X-BAPI-API-KEY"), credentials.apiKey);
    assert.equal(headers.get("X-BAPI-TIMESTAMP"), String(now));
    assert.equal(headers.get("X-BAPI-RECV-WINDOW"), "5000");
    assert.equal(
      headers.get("X-BAPI-SIGN"),
      createHmac("sha256", credentials.apiSecret)
        .update(`${now}${credentials.apiKey}5000${query}`)
        .digest("hex"),
    );
  }
});

test("maps classic spot and contract balances without inventing locked amounts", async () => {
  const client = clientWithResponse((url) => bybitResponse(url, { unifiedMarginStatus: 1 }));
  const snapshot = await client.readAccountSnapshot();

  assert.deepEqual(snapshot.balances, [
    { asset: "USDT", accountType: "spot", total: 12, available: null, locked: null },
    { asset: "BTC", accountType: "derivatives", total: 0.002, available: null, locked: null },
  ]);
});

test("maps Bybit credential rejection to a stable validation failure", async () => {
  const client = clientWithResponse(() => ({ retCode: 10004, retMsg: "error sign", result: {} }));
  await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
    error instanceof BybitAccountReadError && error.category === "credential_validation_failed"
  ));
});

test("reads a Bybit linear position through GET-only authentication", async () => {
  let method: string | undefined;
  const client = new BybitAccountReadClient(credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      method = init?.method;
      assert.equal(url.pathname, "/v5/position/list");
      assert.equal(url.searchParams.get("category"), "linear");
      assert.equal(url.searchParams.get("symbol"), "BTCUSDT");
      return Response.json(success({ list: [{ symbol: "BTCUSDT", positionIdx: 0, side: "Sell", size: "0.5", updatedTime: String(now - 1) }] }));
    }) as typeof fetch,
  });

  assert.deepEqual(await client.readPerpetualPosition("BTCUSDT"), {
    symbol: "BTCUSDT", side: "short", baseQuantity: "0.5", positionIdx: 0, updatedAt: now - 1,
  });
  assert.equal(method, "GET");
});

test("maps target-symbol positionIdx into Bybit-specific mode facts", async (t) => {
  for (const [positionIdx, expectedMode] of [
    [0, "ONE_WAY"],
    [1, "HEDGE"],
    [2, "HEDGE"],
  ] as const) {
    await t.test(`positionIdx=${positionIdx}`, async () => {
      const client = linearPositionClient("BTCUSDT", [{
        symbol: "BTCUSDT", positionIdx, side: "", size: "0",
      }]);

      assert.deepEqual(await client.readLinearPositionMode("BTCUSDT"), {
        category: "linear",
        symbol: "BTCUSDT",
        positionMode: expectedMode,
        positions: [{ category: "linear", symbol: "BTCUSDT", positionIdx, side: "flat", size: "0" }],
      });
    });
  }
});

test("fails closed when Bybit cannot confirm the target-symbol positionIdx", async (t) => {
  await t.test("positionIdx is missing", async () => {
    const client = linearPositionClient("BTCUSDT", [{ symbol: "BTCUSDT", side: "", size: "0" }]);
    assert.deepEqual(await client.readLinearPositionMode("BTCUSDT"), {
      category: "linear", symbol: "BTCUSDT", positionMode: "NOT_CONFIRMED", positions: [],
    });
  });

  await t.test("response mixes one-way and hedge rows", async () => {
    const client = linearPositionClient("BTCUSDT", [
      { symbol: "BTCUSDT", positionIdx: 0, side: "", size: "0" },
      { symbol: "BTCUSDT", positionIdx: 1, side: "", size: "0" },
    ]);
    assert.equal((await client.readLinearPositionMode("BTCUSDT")).positionMode, "NOT_CONFIRMED");
  });
});

test("reads Bybit position mode per symbol without account-global caching", async () => {
  const requestedSymbols: string[] = [];
  const client = new BybitAccountReadClient(credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const symbol = url.searchParams.get("symbol");
      requestedSymbols.push(symbol ?? "");
      const positionIdx = symbol === "BTCUSDT" ? 0 : 1;
      return Response.json(success({ list: [{ symbol, positionIdx, side: "", size: "0" }] }));
    }) as typeof fetch,
  });

  assert.equal((await client.readLinearPositionMode("BTCUSDT")).positionMode, "ONE_WAY");
  assert.equal((await client.readLinearPositionMode("DOGEUSDT")).positionMode, "HEDGE");
  assert.deepEqual(requestedSymbols, ["BTCUSDT", "DOGEUSDT"]);
});

test("rejects Bybit API failures and malformed balances", async (t) => {
  await t.test("HTTP failure", async () => {
    const client = new BybitAccountReadClient(credentials, {
      fetchImpl: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    });
    await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
      error instanceof BybitAccountReadError && error.category === "provider_read_failed"
    ));
  });

  await t.test("malformed wallet balance", async () => {
    const client = clientWithResponse((url) => url.pathname === "/v5/account/wallet-balance"
      ? success({ list: [{ coin: [{ coin: "BTC", walletBalance: "bad", locked: "0" }] }] })
      : bybitResponse(url));
    await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
      error instanceof BybitAccountReadError && error.category === "provider_response_invalid"
    ));
  });

});

function clientWithResponse(payload: (url: URL) => unknown) {
  return new BybitAccountReadClient(credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request) => Response.json(payload(new URL(String(input))))) as typeof fetch,
  });
}

function linearPositionClient(symbol: string, list: unknown[]) {
  return new BybitAccountReadClient(credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(init?.method, "GET");
      assert.equal(url.pathname, "/v5/position/list");
      assert.equal(url.searchParams.get("category"), "linear");
      assert.equal(url.searchParams.get("symbol"), symbol);
      return Response.json(success({ list }));
    }) as typeof fetch,
  });
}

function bybitResponse(url: URL, overrides: { unifiedMarginStatus?: number } = {}) {
  if (url.pathname === "/v5/user/query-api") {
    return success({
      userID: 91234567,
      readOnly: 1,
      ips: ["203.0.113.10"],
      permissions: {
        ContractTrade: ["Order", "Position"],
        Spot: ["SpotTrade"],
        Wallet: ["AccountTransfer"],
        Options: [],
        Derivatives: ["DerivativesTrade"],
      },
    });
  }
  if (url.pathname === "/v5/account/info") {
    return success({
      unifiedMarginStatus: overrides.unifiedMarginStatus ?? 5,
      marginMode: "REGULAR_MARGIN",
    });
  }
  if (url.pathname === "/v5/account/wallet-balance") {
    return success({
      list: [{
        accountType: "UNIFIED",
        coin: [
          { coin: "USDT", walletBalance: "120", locked: "20" },
          { coin: "BTC", walletBalance: "0.002", locked: "0.0005" },
          { coin: "ETH", walletBalance: "0", locked: "0" },
        ],
      }],
    });
  }
  if (url.pathname === "/v5/asset/transfer/query-account-coins-balance") {
    const accountType = url.searchParams.get("accountType");
    if (accountType === "SPOT") {
      return success({ accountType, balance: [
        { coin: "USDT", walletBalance: "12", transferBalance: "10" },
        { coin: "ETH", walletBalance: "0", transferBalance: "0" },
      ] });
    }
    if (accountType === "CONTRACT") {
      return success({ accountType, balance: [
        { coin: "BTC", walletBalance: "0.002", transferBalance: "0.0015" },
      ] });
    }
    return success({ accountType, balance: [
      { coin: "USDT", walletBalance: "120", transferBalance: "100" },
      { coin: "BTC", walletBalance: "0.002", transferBalance: "0.0015" },
    ] });
  }
  throw new Error(`Unexpected Bybit test path: ${url.pathname}`);
}

function success(result: unknown) {
  return { retCode: 0, retMsg: "OK", result };
}
