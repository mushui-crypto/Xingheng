import assert from "node:assert/strict";
import test from "node:test";
import { defaultIctLiquidityReversalConfig, resolveStopPrice } from "./IctLiquidityReversalStrategy";

test("price-fraction stop floor widens a close structural stop to 0.8333 percent", () => {
  const result = resolveStopPrice({
    side: "long",
    entryPrice: 60_000,
    structuralStopPrice: 59_800,
    atr: 100,
    config: {
      ...defaultIctLiquidityReversalConfig,
      stopDistanceMode: "price_fraction_floor",
      minimumStopPriceFraction: 1 / 120,
      maximumStructuralStopPriceFraction: 1 / 120,
    },
  });
  assert.equal(result?.riskDistance, 500);
  assert.equal(result?.stopPrice, 59_500);
});

test("price-fraction stop floor rejects structure already farther than 0.8333 percent", () => {
  const result = resolveStopPrice({
    side: "short",
    entryPrice: 60_000,
    structuralStopPrice: 60_501,
    atr: 100,
    config: {
      ...defaultIctLiquidityReversalConfig,
      stopDistanceMode: "price_fraction_floor",
      minimumStopPriceFraction: 1 / 120,
      maximumStructuralStopPriceFraction: 1 / 120,
    },
  });
  assert.equal(result, null);
});
