import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateMinimumCommonBaseQuantity,
  RwaAutomationMinimumOrderError,
} from "./RwaAutomationMinimumOrder";

test("minimum quantity satisfies both venues using the least common quantity step", () => {
  assert.deepEqual(calculateMinimumCommonBaseQuantity({
    spot: instrument({ qtyStep: 0.002, minOrderQty: 0.002, ask: 4_000 }),
    perpetual: instrument({ qtyStep: 0.003, minOrderQty: 0.003, bid: 4_000 }),
  }), { quantity: 0.006, commonStep: 0.006 });
});

test("minimum notional and current prices can raise the common quantity", () => {
  const first = calculateMinimumCommonBaseQuantity({
    spot: instrument({ qtyStep: 0.0001, minOrderQty: 0.0001, minNotionalUsd: 5, ask: 4_130 }),
    perpetual: instrument({ qtyStep: 0.001, minOrderQty: 0.001, minNotionalUsd: 5, bid: 4_128 }),
  });
  const lowerPrice = calculateMinimumCommonBaseQuantity({
    spot: instrument({ qtyStep: 0.0001, minOrderQty: 0.0001, minNotionalUsd: 5, ask: 2_000 }),
    perpetual: instrument({ qtyStep: 0.001, minOrderQty: 0.001, minNotionalUsd: 5, bid: 2_000 }),
  });
  assert.equal(first.quantity, 0.002);
  assert.equal(lowerPrice.quantity, 0.003);
});

test("invalid, non-finite, and incompatible provider rules fail closed", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    assert.throws(
      () => calculateMinimumCommonBaseQuantity({
        spot: instrument({ ask: value }),
        perpetual: instrument({}),
      }),
      (error: unknown) => error instanceof RwaAutomationMinimumOrderError
        && error.category === "automation_order_sizing_invalid",
    );
  }
});

function instrument(overrides: Partial<{
  qtyStep: number;
  minOrderQty: number;
  minNotionalUsd: number;
  ask: number;
  bid: number;
}>): {
  status: "Trading";
  qtyStep: number;
  minOrderQty: number;
  minNotionalUsd: number;
  priceTick: number;
  ask: number;
  bid: number;
} {
  return {
    status: "Trading",
    qtyStep: 0.001,
    minOrderQty: 0.001,
    minNotionalUsd: 5,
    priceTick: 0.01,
    ask: 4_000,
    bid: 4_000,
    ...overrides,
  };
}
