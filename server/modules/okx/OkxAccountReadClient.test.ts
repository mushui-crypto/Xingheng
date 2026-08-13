import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { OkxAccountReadClient, OkxAccountReadError } from "./OkxAccountReadClient";

const now = 1_800_000_000_000;
const credentials = { apiKey: "okx-key", apiSecret: "okx-secret", passphrase: "okx-passphrase" };

test("reads and signs only OKX account balance and config GET endpoints", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new OkxAccountReadClient(credentials, {
    baseUrl: "https://okx.example.test",
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      return Response.json(okxResponse(url.pathname));
    }) as typeof fetch,
  });

  const snapshot = await client.readAccountSnapshot();

  assert.equal(snapshot.uid, "44705892343619584");
  assert.equal(snapshot.accountLevel, "3");
  assert.equal(snapshot.permissions, "read_only,trade");
  assert.equal(snapshot.boundIps, "203.0.113.10");
  assert.deepEqual(snapshot.balances, [
    { asset: "USDT", total: 120, available: 100, locked: 20 },
    { asset: "BTC", total: 0.002, available: 0.0015, locked: 0.0005 },
  ]);
  assert.deepEqual(requests.map(({ url }) => url.pathname).sort(), [
    "/api/v5/account/balance",
    "/api/v5/account/config",
  ]);
  const timestamp = new Date(now).toISOString();
  for (const { url, init } of requests) {
    assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("OK-ACCESS-KEY"), credentials.apiKey);
    assert.equal(headers.get("OK-ACCESS-PASSPHRASE"), credentials.passphrase);
    assert.equal(headers.get("OK-ACCESS-TIMESTAMP"), timestamp);
    assert.equal(
      headers.get("OK-ACCESS-SIGN"),
      createHmac("sha256", credentials.apiSecret).update(`${timestamp}GET${url.pathname}`).digest("base64"),
    );
  }
});

test("maps OKX credential rejection to a stable validation failure", async () => {
  const client = clientWithResponse(() => ({ code: "50113", msg: "Invalid Sign", data: [] }));
  await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
    error instanceof OkxAccountReadError && error.category === "credential_validation_failed"
  ));
});

test("reads an OKX position with a signed GET query", async () => {
  let request: { url: URL; init?: RequestInit } | null = null;
  const client = new OkxAccountReadClient(credentials, {
    baseUrl: "https://okx.example.test",
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      request = { url, init };
      return Response.json({ code: "0", data: [{ instId: "XAUT-USDT-SWAP", pos: "-10", posSide: "net", uTime: String(now - 1) }] });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.readPerpetualPosition("XAUT-USDT-SWAP"), {
    instId: "XAUT-USDT-SWAP", side: "short", contractQuantity: "10", updatedAt: now - 1,
  });
  const captured = request as unknown as { url: URL; init?: RequestInit };
  assert.equal(captured.init?.method, "GET");
  assert.equal(captured.url.searchParams.get("instId"), "XAUT-USDT-SWAP");
  const requestPath = `${captured.url.pathname}?${captured.url.searchParams.toString()}`;
  assert.equal(
    new Headers(captured.init?.headers).get("OK-ACCESS-SIGN"),
    createHmac("sha256", credentials.apiSecret)
      .update(`${new Date(now).toISOString()}GET${requestPath}`)
      .digest("base64"),
  );
});

test("rejects OKX API failures and malformed balance responses", async (t) => {
  await t.test("HTTP failure", async () => {
    const client = new OkxAccountReadClient(credentials, {
      fetchImpl: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    });
    await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
      error instanceof OkxAccountReadError && error.category === "provider_read_failed"
    ));
  });

  await t.test("malformed balance", async () => {
    const client = clientWithResponse((path) => path.endsWith("/balance")
      ? { code: "0", data: [{ details: [{ ccy: "BTC", cashBal: "bad", availBal: "1", frozenBal: "0" }] }] }
      : okxResponse(path));
    await assert.rejects(client.readAccountSnapshot(), (error: unknown) => (
      error instanceof OkxAccountReadError && error.category === "provider_response_invalid"
    ));
  });
});

function clientWithResponse(payload: (path: string) => unknown) {
  return new OkxAccountReadClient(credentials, {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return Response.json(payload(path));
    }) as typeof fetch,
  });
}

function okxResponse(path: string) {
  if (path === "/api/v5/account/config") {
    return {
      code: "0",
      msg: "",
      data: [{
        uid: "44705892343619584",
        acctLv: "3",
        perm: "read_only,trade",
        ip: "203.0.113.10",
      }],
    };
  }
  if (path === "/api/v5/account/balance") {
    return {
      code: "0",
      msg: "",
      data: [{
        uTime: String(now),
        details: [
          { ccy: "USDT", cashBal: "120", availBal: "100", frozenBal: "20" },
          { ccy: "BTC", cashBal: "0.002", availBal: "0.0015", frozenBal: "0.0005" },
          { ccy: "ETH", cashBal: "0", availBal: "0", frozenBal: "0" },
        ],
      }],
    };
  }
  throw new Error(`Unexpected OKX test path: ${path}`);
}
