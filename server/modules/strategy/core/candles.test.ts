import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { aggregateCandles } from "./candles";

test("aggregates 5m ETHUSDT candles into a 4h candle", () => {
  const start = Date.parse("2026-07-16T00:00:00Z") / 1000;
  const candles: Candle[] = Array.from({ length: 48 }, (_, index) => ({
    symbol: "ETHUSDT",
    interval: "5m",
    time: start + index * 300,
    open: 1_900 + index,
    high: 1_902 + index,
    low: 1_898 + index,
    close: 1_901 + index,
    volume: index + 1,
    quoteVolume: (index + 1) * 2,
    tradeCount: index + 2,
    takerBuyBaseVolume: (index + 1) / 2,
    takerBuyQuoteVolume: index + 1,
  }));

  const aggregated = aggregateCandles(candles, "4h");
  assert.equal(aggregated.length, 1);
  assert.deepEqual(aggregated[0], {
    symbol: "ETHUSDT",
    interval: "4h",
    time: start,
    open: 1_900,
    high: 1_949,
    low: 1_898,
    close: 1_948,
    volume: 48 * 49 / 2,
    quoteVolume: 48 * 49,
    tradeCount: 48 * 51 / 2,
    takerBuyBaseVolume: 48 * 49 / 4,
    takerBuyQuoteVolume: 48 * 49 / 2,
  });
});
