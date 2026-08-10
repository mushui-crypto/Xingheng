import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBinanceExecutionPriceMode,
  parseBinanceUserExecutionMode,
  toBinanceExecutionPriceMode,
} from "./BinanceExecutionPolicy";

test("maps strict public execution policy to Binance-local order modes", () => {
  assert.equal(toBinanceExecutionPriceMode(parseBinanceUserExecutionMode("PRICE_PRIORITY")), "IOC_LIMIT");
  assert.equal(toBinanceExecutionPriceMode(parseBinanceUserExecutionMode("EXECUTION_PRIORITY")), "MARKET");
  assert.throws(() => parseBinanceUserExecutionMode("MARKET"), /executionMode/u);
  assert.throws(() => parseBinanceExecutionPriceMode("EXECUTION_PRIORITY"), /executionPriceMode/u);
});
