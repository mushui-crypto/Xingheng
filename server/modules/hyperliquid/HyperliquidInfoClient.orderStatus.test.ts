import assert from "node:assert/strict";
import test from "node:test";
import { HyperliquidInfoClient } from "./HyperliquidInfoClient";

const address = "0x1111111111111111111111111111111111111111";
const cloid = "0x00112233445566778899aabbccddeeff";

test("queries authoritative order status by cloid and normalizes a found order", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestBody: any;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      status: "order",
      order: {
        order: { cloid, coin: "BTC", limitPx: "60000", oid: 42, side: "B", sz: "0.01" },
        status: "open",
        statusTimestamp: 123,
      },
    }), { status: 200 });
  };

  const result = await new HyperliquidInfoClient("https://example.test").getOrderStatus(address, cloid);
  assert.deepEqual(requestBody, { type: "orderStatus", user: address, oid: cloid });
  assert.equal(result.status, "order");
  assert.equal(result.order?.oid, 42);
  assert.equal(result.order?.cloid, cloid);
  assert.equal(result.order?.status, "open");
});

test("keeps unknownOid authoritative without inferring a rejection", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "unknownOid" }), { status: 200 });

  const result = await new HyperliquidInfoClient("https://example.test").getOrderStatus(address, cloid);
  assert.equal(result.authoritative, true);
  assert.equal(result.status, "unknown");
  assert.equal(result.order, null);
});

test("rejects malformed cloids before contacting the provider", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };

  await assert.rejects(
    () => new HyperliquidInfoClient("https://example.test").getOrderStatus(address, "0x1234"),
    /cloid/,
  );
  assert.equal(called, false);
});
