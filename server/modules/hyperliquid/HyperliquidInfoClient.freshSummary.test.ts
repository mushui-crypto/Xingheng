import assert from "node:assert/strict";
import test from "node:test";
import { HyperliquidInfoClient } from "./HyperliquidInfoClient";

test("market catalog cache never refreshes the timestamp of a stale quote without a fresh info read", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let metaReads = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.type === "metaAndAssetCtxs") {
      metaReads += 1;
      const mark = String(59_000 + metaReads * 1_000);
      return json([{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] }, [{ midPx: mark, markPx: mark }]]);
    }
    if (body.type === "perpDexs" || body.type === "perpCategories" || body.type === "perpConciseAnnotations") return json([]);
    throw new Error(`unexpected info request: ${body.type}`);
  };
  const client = new HyperliquidInfoClient("https://example.test");
  const first = await client.getSummary("BTCUSDT");
  const second = await client.getSummary("BTCUSDT");
  assert.equal(first.markPrice, 61_000);
  assert.equal(second.markPrice, 62_000);
  assert.equal(metaReads, 3, "one metadata read plus one fresh context read per summary");
});

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
