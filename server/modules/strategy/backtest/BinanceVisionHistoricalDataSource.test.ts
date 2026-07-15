import assert from "node:assert/strict";
import test from "node:test";
import { dayRange, monthRange, parseBinanceKlines } from "./BinanceVisionHistoricalDataSource";

test("parses Binance USD-M kline CSV into the normalized Candle contract", () => {
  const candles = parseBinanceKlines([
    "1591258320000,9640.7,9642.4,9640.6,9642.0,206,1591258379999,2.1,48,119,1.2,0",
    "1591258380000,9642.0,9645.0,9641.0,9644.0,300,1591258439999,3.1,55,120,1.3,0",
  ].join("\n"));
  assert.equal(candles.length, 2);
  assert.deepEqual(candles[0], {
    symbol: "BTCUSDT",
    interval: "5m",
    time: 1591258320,
    open: 9640.7,
    high: 9642.4,
    low: 9640.6,
    close: 9642,
    volume: 206,
  });
});

test("builds an inclusive daily range across a month boundary", () => {
  assert.deepEqual(dayRange("2026-06-30", "2026-07-02"), [
    { symbol: "BTCUSDT", date: "2026-06-30" },
    { symbol: "BTCUSDT", date: "2026-07-01" },
    { symbol: "BTCUSDT", date: "2026-07-02" },
  ]);
});

test("builds an inclusive chronological month range", () => {
  assert.deepEqual(monthRange("2025-11", "2026-02"), [
    { symbol: "BTCUSDT", year: 2025, month: 11 },
    { symbol: "BTCUSDT", year: 2025, month: 12 },
    { symbol: "BTCUSDT", year: 2026, month: 1 },
    { symbol: "BTCUSDT", year: 2026, month: 2 },
  ]);
});
