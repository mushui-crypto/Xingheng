import assert from "node:assert/strict";
import { HyperliquidInfoClient } from "../server/modules/hyperliquid/HyperliquidInfoClient";

const requests: unknown[] = [];

const okJson = (payload: unknown) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  requests.push(body);

  if (body.type === "metaAndAssetCtxs" && !body.dex) {
    return okJson([
      {
        universe: [
          { name: "BTC", szDecimals: 5, maxLeverage: 40 },
          { name: "MAIN_NO_QUOTE", szDecimals: 2, maxLeverage: 5 },
        ],
      },
      [
        { markPx: "65000", oraclePx: "65001", midPx: "65000.5", prevDayPx: "64000", dayNtlVlm: "123456", openInterest: "1000", funding: "0.0001" },
        { markPx: "1" },
      ],
    ]);
  }

  if (body.type === "perpDexs") {
    return okJson([
      { name: "ignored-trash", perpDexIndex: 1 },
      { name: "xyz", perpDexIndex: 7 },
    ]);
  }

  if (body.type === "perpCategories") {
    return okJson([
      ["BTC", "crypto"],
      ["xyz:GOLD", "metals"],
      ["xyz:AAPL", "us_equities"],
      ["xyz:SPX", "indices"],
      ["xyz:TESTOTHER", "other"],
    ]);
  }

  if (body.type === "perpConciseAnnotations") {
    return okJson([]);
  }

  if (body.type === "metaAndAssetCtxs" && body.dex === "xyz") {
    return okJson([
      {
        universe: [
          { name: "xyz:GOLD", szDecimals: 4, maxLeverage: 20 },
          { name: "xyz:AAPL", szDecimals: 3, maxLeverage: 10 },
          { name: "xyz:SPX", szDecimals: 2, maxLeverage: 10 },
          { name: "xyz:TESTOTHER", szDecimals: 2, maxLeverage: 3 },
          { name: "xyz:NOQUOTE", szDecimals: 2, maxLeverage: 3 },
          { name: "xyz:NOBB", szDecimals: 2, maxLeverage: 3 },
          { name: "xyz:DELISTED", szDecimals: 2, maxLeverage: 3, isDelisted: true },
        ],
      },
      [
        { markPx: "2000", oraclePx: "2001", midPx: "2000.5", dayNtlVlm: "100" },
        { markPx: "190", oraclePx: "190", midPx: "190.1", dayNtlVlm: "100" },
        { markPx: "5000", oraclePx: "5001", midPx: "5000.5", dayNtlVlm: "100" },
        { markPx: "9", oraclePx: "9.1", midPx: "9.05", dayNtlVlm: "100" },
        { markPx: "0", oraclePx: "0", midPx: "0" },
        { markPx: "5", oraclePx: "5", midPx: "5" },
        { markPx: "7", oraclePx: "7", midPx: "7" },
      ],
    ]);
  }

  if (body.type === "metaAndAssetCtxs" && body.dex === "ignored-trash") {
    throw new Error("untrusted dex should not be queried");
  }

  if (body.type === "l2Book") {
    if (body.coin === "xyz:NOBB") {
      return okJson({ levels: [[], []], time: 1 });
    }
    return okJson({
      levels: [
        [{ px: "1", sz: "2", n: 1 }],
        [{ px: "2", sz: "3", n: 1 }],
      ],
      time: 1,
    });
  }

  throw new Error(`unexpected Hyperliquid info request: ${JSON.stringify(body)}`);
}) as typeof fetch;

const client = new HyperliquidInfoClient("https://example.invalid");
const symbols = await client.getSymbols();

const bySymbol = new Map(symbols.map((symbol) => [symbol.symbol, symbol]));
assert.ok(bySymbol.has("BTCUSDT"), "main DEX crypto market should still be discoverable");
assert.equal(bySymbol.get("BTCUSDT")?.sourceType, "main");
assert.equal(bySymbol.get("BTCUSDT")?.category, "crypto");

assert.ok(bySymbol.has("XYZ-GOLDUSDT"), "allowlisted HIP-3 metals market should be discoverable");
assert.ok(bySymbol.has("XYZ-AAPLUSDT"), "allowlisted HIP-3 US equity market should be discoverable");
assert.ok(bySymbol.has("XYZ-SPXUSDT"), "allowlisted HIP-3 index market should be discoverable");
assert.ok(bySymbol.has("XYZ-TESTOTHERUSDT"), "allowlisted HIP-3 other market should be discoverable");

assert.equal(bySymbol.get("XYZ-GOLDUSDT")?.category, "metals");
assert.equal(bySymbol.get("XYZ-AAPLUSDT")?.category, "us_equities");
assert.equal(bySymbol.get("XYZ-SPXUSDT")?.category, "indices");
assert.equal(bySymbol.get("XYZ-TESTOTHERUSDT")?.category, "other");

assert.equal(bySymbol.get("XYZ-GOLDUSDT")?.assetId, 100_000 + 7 * 10_000 + 0);
assert.equal(bySymbol.get("XYZ-AAPLUSDT")?.assetId, 100_000 + 7 * 10_000 + 1);

assert.equal(bySymbol.has("XYZ-NOQUOTEUSDT"), false, "HIP-3 markets without reliable quotes should be filtered");
assert.equal(bySymbol.has("XYZ-NOBBUSDT"), false, "HIP-3 markets without two-sided orderbook should be filtered");
assert.equal(bySymbol.has("XYZ-DELISTEDUSDT"), false, "delisted HIP-3 markets should be filtered");
assert.equal(symbols.some((symbol) => symbol.sourceDex === "ignored-trash"), false, "untrusted HIP-3 DEX should be skipped");

const counts = symbols.reduce<Record<string, number>>((acc, symbol) => {
  acc[symbol.category] = (acc[symbol.category] ?? 0) + 1;
  return acc;
}, {});
assert.deepEqual(counts, {
  crypto: 1,
  metals: 1,
  us_equities: 1,
  indices: 1,
  other: 1,
});

assert.equal(requests.some((request) => (request as { dex?: string }).dex === "ignored-trash"), false);

console.log("real trading HIP-3 discovery smoke passed");
