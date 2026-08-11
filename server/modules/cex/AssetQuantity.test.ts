import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAsset } from "./Asset";
import { createAssetQuantity, QuantityConverter } from "./AssetQuantity";
import { createTradingRules } from "./TradingRules";

test("creates BTC asset quantity and converts to venue quantity", () => {
  const quantity = createAssetQuantity({
    asset: digitalAsset("BTC"),
    quantity: "0.12345678",
  });
  const converted = new QuantityConverter().toVenueQuantity(quantity, createTradingRules({
    quantityStep: "0.001",
    minQuantity: "0.001",
    priceTick: "0.1",
    precision: { quantity: 3 },
  }));

  assert.deepEqual(quantity, {
    asset: digitalAsset("BTC"),
    quantity: "0.12345678",
  });
  assert.deepEqual(converted, { quantity: "0.123" });
});

test("converts XAUT RWA quantity as base asset quantity", () => {
  const quantity = createAssetQuantity({
    asset: createAsset({
      symbol: "XAUT",
      type: "RWA_ASSET",
      externalReference: {
        namespace: "issuer",
        identifier: "tether:xaut",
      },
    }),
    quantity: "1",
  });

  const converted = new QuantityConverter().toVenueQuantity(quantity, createTradingRules({
    quantityStep: "0.01",
    minQuantity: "0.01",
    priceTick: "0.1",
    contractSize: "0.01",
    precision: {},
  }));

  assert.equal(quantity.quantity, "1");
  assert.deepEqual(converted, { quantity: "1" });
});

test("converts base asset quantity to contract quantity when contractSize is required", () => {
  const quantity = createAssetQuantity({
    asset: createAsset({
      symbol: "XAUT",
      type: "RWA_ASSET",
      externalReference: {
        namespace: "issuer",
        identifier: "tether:xaut",
      },
    }),
    quantity: "0.002",
  });

  const converted = new QuantityConverter().toVenueContractQuantity(quantity, createTradingRules({
    quantityStep: "0.1",
    minQuantity: "0.01",
    priceTick: "0.1",
    contractSize: "0.01",
    precision: { quantity: 1 },
  }));

  assert.deepEqual(converted, { quantity: "0.2" });
});

test("isolates different venue quantity rules", () => {
  const quantity = createAssetQuantity({ asset: digitalAsset("BTC"), quantity: "0.123456" });
  const converter = new QuantityConverter();

  const binance = converter.toVenueQuantity(quantity, createTradingRules({
    quantityStep: "0.001",
    minQuantity: "0.001",
    priceTick: "0.1",
    precision: { quantity: 3 },
  }));
  const okx = converter.toVenueQuantity(quantity, createTradingRules({
    quantityStep: "0.01",
    minQuantity: "0.01",
    priceTick: "0.1",
    contractSize: "0.01",
    precision: {},
  }));

  assert.deepEqual(binance, { quantity: "0.123" });
  assert.deepEqual(okx, { quantity: "0.12" });
});

test("preserves decimal precision without float math", () => {
  const quantity = createAssetQuantity({ asset: digitalAsset("BTC"), quantity: "0.300000000000000000" });
  const converted = new QuantityConverter().toVenueQuantity(quantity, createTradingRules({
    quantityStep: "0.00000001",
    minQuantity: "0.00000001",
    priceTick: "0.01",
    precision: { quantity: 8 },
  }));

  assert.deepEqual(converted, { quantity: "0.3" });
  assert.notEqual(converted.quantity, "0.30000000000000004");
});

test("rejects number quantities and below-minimum converted quantities", () => {
  assert.throws(() => createAssetQuantity({
    asset: digitalAsset("BTC"),
    quantity: 0.1,
  }), /quantity must be a positive decimal string/u);

  assert.throws(() => new QuantityConverter().toVenueQuantity(
    createAssetQuantity({ asset: digitalAsset("BTC"), quantity: "0.0009" }),
    createTradingRules({
      quantityStep: "0.001",
      minQuantity: "0.001",
      priceTick: "0.1",
      precision: { quantity: 3 },
    }),
  ), /below venue minimum quantity/u);
});

test("quantity model and converter have no execution or strategy dependency", () => {
  const source = readFileSync(new URL("./AssetQuantity.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /ExecutionCapability|ExecutionCoordinator|OrderManager|RiskGuard|Strategy|funding|profit|placeOrder|cancelOrder|fetch\(/u);
});

function digitalAsset(symbol: string) {
  return createAsset({
    symbol,
    type: "DIGITAL_ASSET",
  });
}
