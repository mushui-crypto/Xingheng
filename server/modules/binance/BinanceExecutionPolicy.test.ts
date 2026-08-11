import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBinanceExecutionPriceMode,
  toBinanceExecutionPriceMode,
} from "./BinanceExecutionPolicy";

test("maps canonical execution policy to Binance-local order modes", () => {
  assert.equal(toBinanceExecutionPriceMode("PRICE_PRIORITY"), "IOC_LIMIT");
  assert.equal(toBinanceExecutionPriceMode("EXECUTION_PRIORITY"), "MARKET");
  assert.throws(() => parseBinanceExecutionPriceMode("EXECUTION_PRIORITY"), /executionPriceMode/u);
});
