import assert from "node:assert/strict";
import test from "node:test";
import { formatPrice } from "@nktkas/hyperliquid/utils";
import {
  getHyperliquidPerpDisplayPriceDecimals,
  hyperliquidNonIntegerPriceSignificantFigures,
  hyperliquidPerpMaxPriceDecimals,
  normalizeHyperliquidPerpSzDecimals,
} from "./hyperliquidPrecision";

test("derives stable perpetual display precision from official size metadata", () => {
  const samples = [
    { market: "DOGE", szDecimals: 0, pxDecimals: 6 },
    { market: "BTC", szDecimals: 5, pxDecimals: 1 },
    { market: "ETH", szDecimals: 4, pxDecimals: 2 },
    { market: "xyz:GOLD", szDecimals: 4, pxDecimals: 2 },
  ];

  for (const sample of samples) {
    assert.equal(normalizeHyperliquidPerpSzDecimals(sample.szDecimals), sample.szDecimals, sample.market);
    assert.equal(getHyperliquidPerpDisplayPriceDecimals(sample.szDecimals), sample.pxDecimals, sample.market);
  }
  assert.equal(hyperliquidPerpMaxPriceDecimals, 6);
});

test("rejects missing, coerced, fractional, or out-of-range size precision metadata", () => {
  const invalidValues = [undefined, null, "4", -1, 1.5, 7, Number.NaN, Number.POSITIVE_INFINITY];

  for (const value of invalidValues) {
    assert.equal(normalizeHyperliquidPerpSzDecimals(value), null, String(value));
  }
  assert.throws(() => getHyperliquidPerpDisplayPriceDecimals(7), /szDecimals is invalid/);
});

test("documents the SDK perpetual order-price formatting contract", () => {
  assert.equal(hyperliquidNonIntegerPriceSignificantFigures, 5);
  assert.equal(formatPrice("1.23456789", 5, "perp"), "1.2", "non-integers are capped by decimal places and significant figures");
  assert.equal(formatPrice("123456", 5, "perp"), "123456", "integer prices are not capped to five significant figures");
  assert.equal(formatPrice("0.07123456", 0, "perp"), "0.071234", "low-price assets retain the allowed decimal-place ceiling");
});
