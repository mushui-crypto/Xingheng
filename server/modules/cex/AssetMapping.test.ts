import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAsset } from "./Asset";
import {
  createAssetMapping,
  createCanonicalTradingProduct,
  createVenueAsset,
  tradingProductToInstrumentType,
} from "./AssetMapping";

test("maps BTC venue assets from multiple venues to the same canonical asset", () => {
  const btc = digitalAsset("BTC");
  const mappings = [
    createAssetMapping({
      venueAsset: createVenueAsset({ venue: "binance", symbol: "BTC" }),
      canonicalAsset: btc,
      confirmedBy: "manual-review",
    }),
    createAssetMapping({
      venueAsset: createVenueAsset({ venue: "okx", symbol: "BTC" }),
      canonicalAsset: btc,
      confirmedBy: "manual-review",
    }),
    createAssetMapping({
      venueAsset: createVenueAsset({ venue: "bybit", symbol: "BTC" }),
      canonicalAsset: btc,
      confirmedBy: "manual-review",
    }),
  ];

  assert.deepEqual(mappings.map((item) => item.canonicalAsset.symbol), ["BTC", "BTC", "BTC"]);
  assert.deepEqual(mappings.map((item) => item.venueAsset.venue), ["binance", "okx", "bybit"]);
});

test("supports manually confirmed RWA mapping with official reference identity", () => {
  const xaut = createAsset({
    symbol: "XAUT",
    type: "RWA_ASSET",
    externalReference: {
      namespace: "issuer",
      identifier: "tether:xaut",
    },
  });

  const mapping = createAssetMapping({
    venueAsset: {
      venue: "okx",
      symbol: "XAUT",
      reference: {
        namespace: "issuer",
        identifier: "tether:xaut",
      },
    },
    canonicalAsset: xaut,
    confirmedBy: "manual-rwa-review",
  });

  assert.equal(mapping.canonicalAsset.type, "RWA_ASSET");
  assert.equal(mapping.venueAsset.reference?.identifier, "tether:xaut");
  assert.equal(mapping.confirmedBy, "manual-rwa-review");
});

test("allows different venue symbols to map to the same canonical asset only with confirmation", () => {
  const microStrategy = createAsset({
    symbol: "MSTR",
    type: "RWA_ASSET",
    externalReference: {
      namespace: "equity",
      identifier: "nasdaq:mstr",
    },
  });

  const binance = createAssetMapping({
    venueAsset: { venue: "binance", symbol: "MSTR" },
    canonicalAsset: microStrategy,
    confirmedBy: "manual-equity-review",
  });
  const bitget = createAssetMapping({
    venueAsset: { venue: "bitget", symbol: "RMSTR" },
    canonicalAsset: microStrategy,
    confirmedBy: "manual-equity-review",
  });

  assert.equal(binance.canonicalAsset.symbol, bitget.canonicalAsset.symbol);
  assert.notEqual(binance.venueAsset.symbol, bitget.venueAsset.symbol);
});

test("distinguishes canonical spot and USDT perpetual trading products", () => {
  const btc = digitalAsset("BTC");
  const usdt = digitalAsset("USDT");
  const spot = createCanonicalTradingProduct({
    baseAsset: btc,
    quoteAsset: usdt,
    productType: "SPOT",
  });
  const perp = createCanonicalTradingProduct({
    baseAsset: btc,
    quoteAsset: usdt,
    productType: "PERPETUAL_USDT",
  });

  assert.equal(spot.productId, "BTC-USDT-SPOT");
  assert.equal(perp.productId, "BTC-USDT-PERP");
  assert.equal(tradingProductToInstrumentType(spot), "SPOT");
  assert.equal(tradingProductToInstrumentType(perp), "PERPETUAL");
});

test("rejects wrong references and unsupported product types instead of auto matching", () => {
  const xaut = createAsset({
    symbol: "XAUT",
    type: "RWA_ASSET",
    externalReference: {
      namespace: "issuer",
      identifier: "tether:xaut",
    },
  });

  assert.throws(() => createAssetMapping({
    venueAsset: {
      venue: "okx",
      symbol: "XAUT",
      reference: {
        namespace: "issuer",
        identifier: "different:xaut",
      },
    },
    canonicalAsset: xaut,
    confirmedBy: "manual-rwa-review",
  }), /does not match canonical asset reference/u);

  assert.throws(() => createAssetMapping({
    venueAsset: { venue: "okx", symbol: "XAUT" },
    canonicalAsset: xaut,
  }), /confirmedBy is invalid/u);

  assert.throws(() => createCanonicalTradingProduct({
    baseAsset: digitalAsset("BTC"),
    quoteAsset: digitalAsset("USDT"),
    productType: "FUTURE",
  }), /productType must be SPOT or PERPETUAL_USDT/u);
});

test("asset mapping has no execution, strategy, or provider dependency", () => {
  const source = readFileSync(new URL("./AssetMapping.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /ExecutionCapability|ExecutionCoordinator|OrderManager|RiskGuard|Strategy|placeOrder|cancelOrder|fetch\(/u);
});

function digitalAsset(symbol: string) {
  return createAsset({
    symbol,
    type: "DIGITAL_ASSET",
  });
}
