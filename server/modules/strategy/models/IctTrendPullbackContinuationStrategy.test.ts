import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import {
  IctTrendPullbackContinuationStrategy,
  ictRouteATrendPullbackV1Config,
} from "./IctTrendPullbackContinuationStrategy";

test("trend pullback signal uses only the previous completed 15m trend bucket", () => {
  const signalIndex = 650;
  const signalTime = Date.parse("2024-01-03T10:00:00Z") / 1000;
  const startTime = signalTime - signalIndex * 300;
  const candles: Candle[] = Array.from({ length: 680 }, (_, index) => {
    const close = 20_000 + index;
    return {
      symbol: "BTCUSDT",
      interval: "5m",
      time: startTime + index * 300,
      open: close - 0.6,
      high: close + 0.4,
      low: close - 0.8,
      close,
      volume: 100,
    };
  });
  const previous = candles[signalIndex - 1];
  candles[signalIndex] = {
    ...candles[signalIndex],
    open: previous.close + 0.8,
    low: previous.close + 0.6,
    high: previous.close + 11.2,
    close: previous.close + 10.8,
  };

  const strategy = new IctTrendPullbackContinuationStrategy(ictRouteATrendPullbackV1Config);
  const signal = strategy.evaluate({ candles, index: signalIndex, equity: 10_000 });
  strategy.release();
  assert.ok(signal);
  assert.equal(signal.side, "long");
  assert.equal(signal.entryOrderType, "limit");
  assert.equal(signal.strategyId, "ict-route-a-trend-pullback-v1");

  const futureChanged = candles.map((candle) => ({ ...candle }));
  for (let index = signalIndex + 1; index < futureChanged.length; index += 1) {
    futureChanged[index].open *= 0.5;
    futureChanged[index].high *= 0.5;
    futureChanged[index].low *= 0.5;
    futureChanged[index].close *= 0.5;
  }
  const replay = new IctTrendPullbackContinuationStrategy(ictRouteATrendPullbackV1Config);
  const replaySignal = replay.evaluate({ candles: futureChanged, index: signalIndex, equity: 10_000 });
  replay.release();
  assert.deepEqual(replaySignal, signal);
});
