import assert from "node:assert/strict";
import test from "node:test";
import { assertBinanceStartupLeverage } from "./BinancePersonalTradingService";

test("Binance startup requires exactly 1x perpetual leverage", () => {
  assert.doesNotThrow(() => assertBinanceStartupLeverage(1));
  assert.throws(() => assertBinanceStartupLeverage(2), /must be configured to 1x/u);
  assert.throws(() => assertBinanceStartupLeverage(null), /must be configured to 1x/u);
});
