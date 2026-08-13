import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { BitgetAccountReadClient, BitgetAccountReadError } from "./BitgetAccountReadClient";

const now = 1_800_000_000_000;
const credentials = {
  apiKey: "bitget-key",
  apiSecret: "bitget-secret",
  passphrase: "bitget-passphrase",
};

test("reads and signs only Bitget UTA account GET endpoints", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new BitgetAccountReadClient(credentials, {
    baseUrl: "https://bitget.example.test",
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      return Response.json(bitgetResponse(url.pathname));
    }) as typeof fetch,
  });

  const snapshot = await client.readAccountSnapshot();

  assert.equal(snapshot.uid, "8123456789");
  assert.equal(snapshot.accountMode, "hybrid");
  assert.equal(snapshot.assetMode, "multi_assets");
  assert.equal(snapshot.accountLevel, "advanced");
  assert.equal(snapshot.permType, "read-and-write");
  assert.deepEqual(snapshot.permissions, ["uta_mgt", "uta_trade", "withdraw"]);
  assert.equal(snapshot.boundIps, "192.0.2.10,192.0.2.11");
  assert.deepEqual(snapshot.balances, [
    { asset: "USDT", total: 120, available: 100, locked: 20 },
    { asset: "BTC", total: 0.002, available: null, locked: 0.0005 },
  ]);
  assert.deepEqual(requests.map(({ url }) => url.pathname).sort(), [
    "/api/v3/account/assets",
    "/api/v3/account/info",
    "/api/v3/account/settings",
  ]);
  for (const { url, init } of requests) {
    assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("ACCESS-KEY"), credentials.apiKey);
    assert.equal(headers.get("ACCESS-TIMESTAMP"), String(now));
    assert.equal(headers.get("ACCESS-PASSPHRASE"), credentials.passphrase);
    assert.equal(
      headers.get("ACCESS-SIGN"),
      createHmac("sha256", credentials.apiSecret).update(`${now}GET${url.pathname}`).digest("base64"),
    );
  }
});

test("filters zero Bitget balances and preserves nullable official fields", async () => {
  const snapshot = await clientWithResponse(bitgetResponse).readAccountSnapshot();
  assert.equal(snapshot.balances.some(({ asset }) => asset === "ETH"), false);
  assert.deepEqual(snapshot.balances[1], {
    asset: "BTC",
    total: 0.002,
    available: null,
    locked: 0.0005,
  });
});

test("maps Bitget credential rejection to a stable validation failure", async () => {
  const client = clientWithResponse(() => ({ code: "40009", msg: "sign signature error", data: {} }));
  await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
    error instanceof BitgetAccountReadError && error.category === "credential_validation_failed"
  ));
});

test("maps production Classic-account and invalid-password responses without hiding them", async (t) => {
  await t.test("Classic account cannot use UTA endpoints", async () => {
    const client = clientWithResponse(() => ({
      code: "40084",
      msg: "You are in Classic Account mode, and the Unified Account API is not supported at this time",
      data: null,
    }), 400);
    await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
      error instanceof BitgetAccountReadError
      && error.category === "account_mode_unsupported"
      && error.providerCode === "40084"
    ));
  });

  await t.test("invalid API password is a credential validation failure", async () => {
    const client = clientWithResponse(() => ({
      code: "40012",
      msg: "apikey/password is incorrect",
      data: null,
    }), 400);
    await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
      error instanceof BitgetAccountReadError
      && error.category === "credential_validation_failed"
      && error.providerCode === "40012"
    ));
  });
});

test("reads a Bitget UTA position through the GET-only client", async () => {
  let method: string | undefined;
  const client = new BitgetAccountReadClient(credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      method = init?.method;
      assert.equal(url.pathname, "/api/v3/position/current-position");
      assert.equal(url.searchParams.get("category"), "USDT-FUTURES");
      assert.equal(url.searchParams.get("symbol"), "XAUTUSDT");
      return Response.json(success({ list: [{ symbol: "XAUTUSDT", posSide: "long", total: "0.5", updatedTime: String(now - 1) }] }));
    }) as typeof fetch,
  });

  assert.deepEqual(await client.readPerpetualPosition("XAUTUSDT"), {
    symbol: "XAUTUSDT", side: "long", baseQuantity: "0.5", updatedAt: now - 1,
  });
  assert.equal(method, "GET");
});

test("rejects Bitget API failures and malformed account responses", async (t) => {
  await t.test("HTTP failure", async () => {
    const client = new BitgetAccountReadClient(credentials, {
      fetchImpl: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    });
    await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
      error instanceof BitgetAccountReadError && error.category === "provider_read_failed"
    ));
  });

  await t.test("provider rejection", async () => {
    const client = clientWithResponse(() => ({ code: "25000", msg: "system error", data: {} }));
    await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
      error instanceof BitgetAccountReadError && error.category === "provider_read_failed"
    ));
  });

  await t.test("malformed asset", async () => {
    const client = clientWithResponse((path) => path.endsWith("/assets")
      ? success({ assets: [{ coin: "BTC", balance: "bad", available: "1", locked: "0" }] })
      : bitgetResponse(path));
    await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
      error instanceof BitgetAccountReadError && error.category === "provider_response_invalid"
    ));
  });
});

function clientWithResponse(payload: (path: string) => unknown, status = 200) {
  return new BitgetAccountReadClient(credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request) => {
      return Response.json(payload(new URL(String(input)).pathname), { status });
    }) as typeof fetch,
  });
}

function bitgetResponse(path: string) {
  if (path === "/api/v3/account/info") {
    return success({
      userId: "8123456789",
      ips: "192.0.2.10,192.0.2.11",
      permType: "read-and-write",
      permissions: ["uta_mgt", "uta_trade", "withdraw"],
    });
  }
  if (path === "/api/v3/account/settings") {
    return success({
      uid: "8123456789",
      accountMode: "hybrid",
      assetMode: "multi_assets",
      accountLevel: "advanced",
    });
  }
  if (path === "/api/v3/account/assets") {
    return success({
      assets: [
        { coin: "USDT", balance: "120", available: "100", locked: "20" },
        { coin: "BTC", balance: "0.002", available: "", locked: "0.0005" },
        { coin: "ETH", balance: "0", available: "0", locked: "0" },
      ],
    });
  }
  throw new Error(`Unexpected Bitget test path: ${path}`);
}

function success(data: unknown) {
  return { code: "00000", msg: "success", data };
}
