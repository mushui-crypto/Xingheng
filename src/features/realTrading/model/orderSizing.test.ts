import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultRealTradingOrderType,
  resolveOrderValue,
  resolveMaximumOrderQuantity,
  resolvePercentForQuantity,
  resolveQuantityForPercent,
} from "./orderSizing";

test("real trading order type defaults to market", () => {
  assert.equal(defaultRealTradingOrderType, "market");
});

test("open quantity uses balance, symbol leverage and expected price with szDecimals floor", () => {
  assert.equal(resolveMaximumOrderQuantity({ availableMargin: 100, leverage: 5, orderPrice: 64_123, reduceOnly: false, symbol: "BTCUSDT", szDecimals: 5 }), "0.00779");
  assert.equal(resolveMaximumOrderQuantity({ availableMargin: 100, leverage: 10, orderPrice: 3_210, reduceOnly: false, symbol: "ETHUSDT", szDecimals: 3 }), "0.311");
});

test("100 percent is byte-for-byte identical to displayed maximum and manual size maps back", () => {
  const maximum = resolveMaximumOrderQuantity({ availableMargin: 100, leverage: 5, orderPrice: 64_123, reduceOnly: false, symbol: "BTCUSDT", szDecimals: 5 });
  assert.equal(resolveQuantityForPercent(maximum, 100, 5, "BTCUSDT"), maximum);
  assert.equal(resolveQuantityForPercent(maximum, 50, 5, "BTCUSDT"), "0.00389");
  assert.equal(resolvePercentForQuantity(maximum, maximum), 100);
  assert.equal(resolvePercentForQuantity("0.00389", maximum), 50);
});

test("reduce-only uses closeable size and zero or missing price remains safe", () => {
  assert.equal(resolveMaximumOrderQuantity({ availableMargin: 0, leverage: 50, orderPrice: null, positionSize: 1.23456, reduceOnly: true, symbol: "ETHUSDT", szDecimals: 3 }), "1.234");
  assert.equal(resolveMaximumOrderQuantity({ availableMargin: 0, leverage: 5, orderPrice: 100, reduceOnly: false, symbol: "BTCUSDT", szDecimals: 5 }), "");
  assert.equal(resolveMaximumOrderQuantity({ availableMargin: 100, leverage: 5, orderPrice: null, reduceOnly: false, symbol: "BTCUSDT", szDecimals: 5 }), "");
  assert.equal(resolveQuantityForPercent("", 100, 5, "BTCUSDT"), "");
});

test("order value follows quantity and current order reference price", () => {
  assert.equal(resolveOrderValue("0.25", 64_000), 16_000);
  assert.equal(resolveOrderValue("0", 64_000), null);
  assert.equal(resolveOrderValue("1", null), null);
});
