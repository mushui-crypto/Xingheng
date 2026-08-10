import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBinanceStartupLeverage,
  parseExistingExposureRiskAcknowledgement,
  parsePublicOrderInput,
} from "./BinancePersonalTradingService";
import { BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT } from "./BinanceExecutionPolicy";

test("Binance startup requires exactly 1x perpetual leverage", () => {
  assert.doesNotThrow(() => assertBinanceStartupLeverage(1));
  assert.throws(() => assertBinanceStartupLeverage(2), /must be configured to 1x/u);
  assert.throws(() => assertBinanceStartupLeverage(null), /must be configured to 1x/u);
});

test("raw order input is fixed to IOC_LIMIT and rejects MARKET", () => {
  const input = {
    idempotencyKey: "raw-ioc",
    category: "spot",
    side: "Buy",
    quantityXaut: 0.01,
    limitPrice: 1_000,
  };
  assert.equal(parsePublicOrderInput(input).executionPriceMode, "IOC_LIMIT");
  assert.equal(parsePublicOrderInput({ ...input, executionPriceMode: "IOC_LIMIT" }).executionPriceMode, "IOC_LIMIT");
  assert.throws(
    () => parsePublicOrderInput({ ...input, executionPriceMode: "MARKET" }),
    /support IOC_LIMIT only/u,
  );
});

test("existing exposure acknowledgement accepts only the frozen request literal", () => {
  assert.equal(parseExistingExposureRiskAcknowledgement(undefined), undefined);
  assert.equal(
    parseExistingExposureRiskAcknowledgement(BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT),
    BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT,
  );
  assert.throws(() => parseExistingExposureRiskAcknowledgement(true), /is invalid/u);
  assert.throws(() => parseExistingExposureRiskAcknowledgement("ALLOW"), /is invalid/u);
});
