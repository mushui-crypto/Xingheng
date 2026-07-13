import assert from "node:assert/strict";
import { HyperliquidExchangeProxy } from "../server/modules/hyperliquid/HyperliquidExchangeProxy";

const proxy = new HyperliquidExchangeProxy("https://api.hyperliquid-testnet.xyz");
const originalFetch = globalThis.fetch;
const forwardedBodies: unknown[] = [];

const baseRequest = {
  masterAddress: "0x1111111111111111111111111111111111111111",
  network: "hyperliquid-testnet",
  nonce: 1_720_000_000_000,
  signature: {
    r: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    s: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    v: 27,
  },
};

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  forwardedBodies.push(JSON.parse(String(init?.body ?? "{}")));
  return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

try {
  await expectForwarded({ type: "updateLeverage", asset: 0, isCross: true, leverage: 1 });
  await expectForwarded({ type: "updateLeverage", asset: 7, isCross: false, leverage: 50 });

  await expectRejected({ type: "updateLeverage", asset: 0, isCross: "true", leverage: 5 }, /isCross/);
  await expectRejected({ type: "updateLeverage", asset: 0, leverage: 5 }, /isCross/);
  await expectRejected({ type: "updateLeverage", asset: 0, isCross: true, leverage: 0 }, /leverage/);
  await expectRejected({ type: "updateLeverage", asset: 0, isCross: true, leverage: 51 }, /leverage/);
  await expectRejected({ type: "updateLeverage", asset: 0, isCross: true, leverage: 2.5 }, /leverage/);
  await expectRejected({ type: "updateLeverage", asset: 0, isCross: true, leverage: "5" }, /leverage/);
  await expectRejected({ type: "updateLeverage", asset: -1, isCross: true, leverage: 5 }, /asset/);
  await expectRejected({ type: "updateLeverage", asset: 1.5, isCross: true, leverage: 5 }, /asset/);
  await expectRejected({ type: "updateLeverage", asset: "0", isCross: true, leverage: 5 }, /asset/);
} finally {
  globalThis.fetch = originalFetch;
}

async function expectForwarded(action: Record<string, unknown>) {
  const before = forwardedBodies.length;
  const response = await proxy.forward({ ...baseRequest, action });
  assert.equal(response.ok, true);
  assert.equal(forwardedBodies.length, before + 1);
  assert.deepEqual((forwardedBodies.at(-1) as { action?: unknown }).action, action);
}

async function expectRejected(action: Record<string, unknown>, message: RegExp) {
  const before = forwardedBodies.length;
  await assert.rejects(() => proxy.forward({ ...baseRequest, action }), message);
  assert.equal(forwardedBodies.length, before);
}

console.log("real trading exchange proxy smoke passed");
