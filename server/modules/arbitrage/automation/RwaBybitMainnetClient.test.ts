import assert from "node:assert/strict";
import test from "node:test";
import { RwaBybitMainnetClient, RwaBybitProviderError } from "./RwaBybitMainnetClient";

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
