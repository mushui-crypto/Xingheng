import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { calculateConfirmedRanges, simulateExchangeStyleRangeGrid } from "./ExchangeStyleRangeGridEngine";

test("range grid detects only a completed non-trending four-hour structure", () => {
  const candles = makeRange();
  const ranges = calculateConfirmedRanges(candles);
  const first = ranges.findIndex(Boolean);
  assert.ok(first > 0);
  assert.ok(ranges[first]!.lower < candles[first].close);
  assert.ok(ranges[first]!.upper > candles[first].close);

  const prefix = calculateConfirmedRanges(candles.slice(0, first + 1));
  assert.deepEqual(prefix.at(-1), ranges[first]);
});

test("exchange-style range grid keeps cycling without order or holding expiry", () => {
  const candles = makeRange();
  const result = simulateExchangeStyleRangeGrid("BTCUSDT", candles, { forwardStart: candles[0].time });

  assert.ok(result.activeCycle);
  assert.equal(result.completedCycles.length, 0);
  assert.ok(result.diagnostics.gridProfits > 0);
  assert.ok(result.completedLegs.every((leg) => leg.exitReason === "grid_profit"));
  assert.ok(result.completedLegs.every((leg) => leg.exitTime > leg.entryTime));
});

function makeRange(): Candle[] {
  const start = 1_700_000_000 - (1_700_000_000 % 300);
  return Array.from({ length: 5_000 }, (_, index) => {
    const price = 60_000 + 3_000 * Math.sin(index * 2 * Math.PI / 576);
    return {
      symbol: "BTCUSDT",
      interval: "5m",
      time: start + index * 300,
      open: price,
      high: price + 20,
      low: price - 20,
      close: price,
      volume: 10,
    };
  });
}
