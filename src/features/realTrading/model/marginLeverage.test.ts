import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMaxLeverage, resolveMarginLeverageSelection } from "./marginLeverage";

test("caps metadata and legacy fallback leverage at the P0 20x policy", () => {
  assert.equal(normalizeMaxLeverage(50), 20);
  assert.equal(normalizeMaxLeverage(undefined), 20);
  assert.equal(normalizeMaxLeverage(10), 10);
  assert.equal(resolveMarginLeverageSelection({ maxLeverage: 50 }).maxLeverage, 20);
});
