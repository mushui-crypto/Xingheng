import assert from "node:assert/strict";
import { formatPrice } from "@nktkas/hyperliquid/utils";
import { HyperliquidInfoClient } from "../server/modules/hyperliquid/HyperliquidInfoClient";
import { hyperliquidTestnetBaseUrl } from "../server/modules/hyperliquid/hyperliquidConfig";
import { getHyperliquidPerpDisplayPriceDecimals } from "../server/modules/hyperliquid/hyperliquidPrecision";

type RawUniverseItem = {
  name?: unknown;
  szDecimals?: unknown;
};

type RawAssetContext = {
  markPx?: unknown;
  oraclePx?: unknown;
  midPx?: unknown;
};

type MetaAndContexts = {
  universe: RawUniverseItem[];
  contexts: RawAssetContext[];
};

const expectedSamples = [
  { providerMarketId: "DOGE", symbol: "DOGEUSDT", dex: undefined, szDecimals: 0, pxDecimals: 6 },
  { providerMarketId: "BTC", symbol: "BTCUSDT", dex: undefined, szDecimals: 5, pxDecimals: 1 },
  { providerMarketId: "ETH", symbol: "ETHUSDT", dex: undefined, szDecimals: 4, pxDecimals: 2 },
  { providerMarketId: "xyz:GOLD", symbol: "XYZ-GOLDUSDT", dex: "xyz", szDecimals: 4, pxDecimals: 2 },
] as const;

async function postInfo(body: unknown) {
  const response = await fetch(new URL("/info", hyperliquidTestnetBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.ok, true, `Testnet info request failed with HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

function parseMetaAndContexts(payload: unknown, label: string): MetaAndContexts {
  assert.ok(Array.isArray(payload) && payload.length >= 2, `${label} returned an invalid tuple`);
  const metadata = payload[0] as { universe?: unknown };
  assert.ok(Array.isArray(metadata?.universe), `${label} metadata did not include a universe`);
  assert.ok(Array.isArray(payload[1]), `${label} did not include asset contexts`);
  return {
    universe: metadata.universe as RawUniverseItem[],
    contexts: payload[1] as RawAssetContext[],
  };
}

function getRawSample(marketData: MetaAndContexts, providerMarketId: string) {
  const universeIndex = marketData.universe.findIndex((item) => item?.name === providerMarketId);
  assert.notEqual(universeIndex, -1, `${providerMarketId} is missing from current Testnet metadata`);
  return {
    universeIndex,
    item: marketData.universe[universeIndex],
    context: marketData.contexts[universeIndex],
  };
}

const [mainMarketData, xyzMarketData] = await Promise.all([
  postInfo({ type: "metaAndAssetCtxs" }).then((payload) => parseMetaAndContexts(payload, "main metaAndAssetCtxs")),
  postInfo({ type: "metaAndAssetCtxs", dex: "xyz" }).then((payload) => parseMetaAndContexts(payload, "xyz metaAndAssetCtxs")),
]);

const rawResults = expectedSamples.map((expected) => {
  const marketData = expected.dex === "xyz" ? xyzMarketData : mainMarketData;
  const sample = getRawSample(marketData, expected.providerMarketId);
  assert.equal(sample.item.szDecimals, expected.szDecimals, `${expected.providerMarketId} Testnet szDecimals changed`);
  assert.equal(
    getHyperliquidPerpDisplayPriceDecimals(expected.szDecimals),
    expected.pxDecimals,
    `${expected.providerMarketId} display precision contract changed`,
  );
  return {
    providerMarketId: expected.providerMarketId,
    universeIndex: sample.universeIndex,
    szDecimals: sample.item.szDecimals,
    pxDecimals: expected.pxDecimals,
    markPx: sample.context?.markPx ?? null,
    oraclePx: sample.context?.oraclePx ?? null,
    midPx: sample.context?.midPx ?? null,
  };
});

const symbols = await new HyperliquidInfoClient(hyperliquidTestnetBaseUrl).getSymbols();
const bySymbol = new Map(symbols.map((symbol) => [symbol.symbol, symbol]));

for (const expected of expectedSamples) {
  const symbol = bySymbol.get(expected.symbol);
  assert.ok(symbol, `${expected.symbol} is not currently discoverable through the symbols contract`);
  assert.equal(symbol.providerMarketId, expected.providerMarketId);
  assert.equal(symbol.szDecimals, expected.szDecimals);
  assert.equal(symbol.pxDecimals, expected.pxDecimals);
}

assert.equal(formatPrice("1.23456789", 5, "perp"), "1.2");
assert.equal(formatPrice("123456", 5, "perp"), "123456");

console.log("Hyperliquid Testnet precision verification passed");
console.table(rawResults);
