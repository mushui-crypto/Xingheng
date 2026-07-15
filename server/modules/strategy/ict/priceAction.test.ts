import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { confirmedSwings, fairValueGap, isDisplacement } from "./priceAction";
import { isWithinTimeZoneSession, newYorkTime } from "./time";
import { fvgEntryPrice } from "../models/IctLiquidityReversalStrategy";

test("swing is unavailable until right-side confirmation bars have closed", () => {
  const candles = [10, 11, 15, 12, 11].map((high, index) => candle(index, high - 2, high));
  assert.equal(confirmedSwings(candles, 3).some((swing) => swing.index === 2), false);
  const confirmed = confirmedSwings(candles, 4).find((swing) => swing.index === 2 && swing.kind === "high");
  assert.equal(confirmed?.confirmedAtIndex, 4);
});

test("detects three-candle bullish and bearish fair value gaps", () => {
  const bullish = [
    fullCandle(0, 100, 102, 99, 101),
    fullCandle(1, 101, 108, 101, 107),
    fullCandle(2, 105, 110, 104, 109),
  ];
  assert.deepEqual(fairValueGap(bullish, 2), { index: 2, lower: 102, upper: 104, midpoint: 103, side: "bullish" });
  const bearish = [
    fullCandle(0, 109, 110, 107, 108),
    fullCandle(1, 108, 108, 100, 101),
    fullCandle(2, 103, 105, 99, 100),
  ];
  assert.deepEqual(fairValueGap(bearish, 2), { index: 2, lower: 105, upper: 107, midpoint: 106, side: "bearish" });
});

test("displacement requires an ATR-sized body and close near the candle extreme", () => {
  assert.equal(isDisplacement(fullCandle(0, 100, 110, 99, 109), 10, "bullish", 0.8), true);
  assert.equal(isDisplacement(fullCandle(0, 100, 110, 99, 104), 10, "bullish", 0.8), false);
});

test("New York session conversion follows daylight saving time", () => {
  assert.equal(newYorkTime(Date.parse("2026-01-15T14:30:00Z") / 1000).minuteOfDay, 9 * 60 + 30);
  assert.equal(newYorkTime(Date.parse("2026-07-15T13:30:00Z") / 1000).minuteOfDay, 9 * 60 + 30);
});

test("time-zone session supports an allowed window that crosses midnight", () => {
  const timestamp = (iso: string) => Date.parse(iso) / 1000;
  assert.equal(isWithinTimeZoneSession(timestamp("2026-07-15T12:00:00Z"), "Asia/Shanghai", 18 * 60, 8 * 60), true);
  assert.equal(isWithinTimeZoneSession(timestamp("2026-07-15T23:00:00Z"), "Asia/Shanghai", 18 * 60, 8 * 60), true);
  assert.equal(isWithinTimeZoneSession(timestamp("2026-07-15T04:00:00Z"), "Asia/Shanghai", 18 * 60, 8 * 60), false);
});

test("FVG entry depth is measured symmetrically from the proximal edge", () => {
  assert.equal(fvgEntryPrice(100, 104, "long", 0.25), 103);
  assert.equal(fvgEntryPrice(100, 104, "short", 0.25), 101);
  assert.equal(fvgEntryPrice(100, 104, "long", 0.5), 102);
  assert.equal(fvgEntryPrice(100, 104, "short", 0.5), 102);
});

function candle(index: number, low: number, high: number): Candle {
  return fullCandle(index, low + 1, high, low, high - 1);
}

function fullCandle(index: number, open: number, high: number, low: number, close: number): Candle {
  return { symbol: "BTCUSDT", interval: "1m", time: index * 60, open, high, low, close, volume: 1 };
}
