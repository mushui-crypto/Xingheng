import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMaxLeverage, resolveMarginLeverageSelection } from "./marginLeverage";

test("uses the symbol metadata max leverage without a local 20x cap", () => {
  assert.equal(normalizeMaxLeverage(50), 50);
  assert.equal(normalizeMaxLeverage(undefined), 1);
  assert.equal(normalizeMaxLeverage(10), 10);
  assert.equal(resolveMarginLeverageSelection({ maxLeverage: 50 }).maxLeverage, 50);
});
