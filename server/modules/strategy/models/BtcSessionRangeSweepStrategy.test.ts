import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { BtcSessionRangeSweepStrategy } from "./BtcSessionRangeSweepStrategy";

test("session range strategy uses the completed Beijing day range and emits a next-bar long reclaim", () => {
  const candles = fixtures();
  const strategy = new BtcSessionRangeSweepStrategy();
  strategy.prepare(candles);
  const signal = strategy.evaluate({ candles, index: candles.length - 1, equity: 10_000 });

  assert.ok(signal);
  assert.equal(signal.side, "long");
  assert.equal(signal.entryOrderType, "market");
  assert.equal(signal.targetRewardRisk, 2);
  assert.equal(signal.evidence.referenceLow, 99);
  assert.ok(signal.stopPrice < candles.at(-1)!.low);
});

test("session range strategy rejects a sweep candle that does not reclaim the reference low", () => {
  const candles = fixtures();
  candles[candles.length - 1] = { ...candles.at(-1)!, close: 98.8 };
  const strategy = new BtcSessionRangeSweepStrategy();
  strategy.prepare(candles);

  assert.equal(strategy.evaluate({ candles, index: candles.length - 1, equity: 10_000 }), null);
});

function fixtures(): Candle[] {
  const start = Date.parse("2026-01-05T00:00:00Z") / 1000;
  const candles: Candle[] = Array.from({ length: 120 }, (_, index) => ({
    symbol: "BTCUSDT",
    interval: "5m",
    time: start + index * 300,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  }));
  candles.push({
    symbol: "BTCUSDT",
    interval: "5m",
    time: Date.parse("2026-01-05T10:00:00Z") / 1000,
    open: 99.2,
    high: 100.8,
    low: 98.5,
    close: 100.5,
    volume: 20,
  });
  return candles;
}
