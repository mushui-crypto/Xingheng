import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAsset } from "./Asset";

test("creates a digital asset", () => {
  const asset = createAsset({
    symbol: "BTC",
    type: "DIGITAL_ASSET",
    displayName: "Bitcoin",
  });

  assert.deepEqual(asset, {
    symbol: "BTC",
    type: "DIGITAL_ASSET",
    displayName: "Bitcoin",
  });
});

test("creates an RWA asset with an optional external reference", () => {
  const asset = createAsset({
    symbol: "XAUT",
    type: "RWA_ASSET",
    displayName: "Tether Gold",
    externalReference: {
      namespace: "issuer",
      identifier: "tether:xaut",
    },
  });

  assert.deepEqual(asset, {
    symbol: "XAUT",
    type: "RWA_ASSET",
    displayName: "Tether Gold",
    externalReference: {
      namespace: "issuer",
      identifier: "tether:xaut",
    },
  });
});

test("rejects unknown asset types", () => {
  assert.throws(() => createAsset({
    symbol: "BTC",
    type: "COMMODITY",
  }), /type must be DIGITAL_ASSET or RWA_ASSET/u);
});

test("does not accept exchange or execution fields", () => {
  assert.throws(() => createAsset({
    symbol: "BTC",
    type: "DIGITAL_ASSET",
    venue: "binance",
  }), /unsupported field: venue/u);
  assert.throws(() => createAsset({
    symbol: "BTC",
    type: "DIGITAL_ASSET",
    orderId: "order-1",
  }), /unsupported field: orderId/u);
});

test("asset model has no execution capability dependency", () => {
  const source = readFileSync(new URL("./Asset.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /ExecutionCapability|ExecutionCoordinator|OrderManager|RiskGuard|Strategy|placeOrder|cancelOrder/u);
});
