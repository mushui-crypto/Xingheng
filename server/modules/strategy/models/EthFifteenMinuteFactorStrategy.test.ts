import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { EthFifteenMinuteFactorStrategy } from "./EthFifteenMinuteFactorStrategy";

test("15m factor only signals on the third closed 5m candle of a bucket", () => {
  const candles = makeCandles();
  const strategy = makeStrategy();
  strategy.prepare(candles);
  const index = findSignal(strategy, candles);
  assert.ok(index > strategy.warmupBars);
  assert.equal(candles[index].time % 900, 600);
  const signal = strategy.evaluate({ candles, index, equity: 10_000 });
  assert.ok(signal);
  assert.equal(signal.entryOrderType, "market");
  assert.equal(signal.expiresAt, candles[index].time + 300);
  strategy.release();
});

test("15m factor signal is unchanged after mutating future 5m candles", () => {
  const candles = makeCandles();
  const strategy = makeStrategy();
  strategy.prepare(candles);
  const index = findSignal(strategy, candles);
  const original = strategy.evaluate({ candles, index, equity: 10_000 });
  strategy.release();
  const changed = candles.map((candle, cursor) => cursor <= index ? candle : {
    ...candle,
    open: candle.open * 5,
    high: candle.high * 5,
    low: candle.low * 5,
    close: candle.close * 5,
    volume: 9_999_999,
  });
  const replay = makeStrategy();
  replay.prepare(changed);
  assert.deepEqual(replay.evaluate({ candles: changed, index, equity: 10_000 }), original);
  replay.release();
});

function makeStrategy() {
  return new EthFifteenMinuteFactorStrategy({
    symbol: "ETHUSDT",
    family: "trend_continuation",
    threshold: 1,
    stopAtr: 0.75,
    rewardRisk: 2,
    session: "all",
    riskFraction: 0.0025,
    maximumHoldingBars: 36,
  });
}
function findSignal(strategy: EthFifteenMinuteFactorStrategy, candles: Candle[]) {
  for (let index = strategy.warmupBars; index < candles.length; index += 1) {
    if (strategy.evaluate({ candles, index, equity: 10_000 })) return index;
  }
  return -1;
}

function makeCandles() {
  const result: Candle[] = [];
  let close = 2_000;
  for (let index = 0; index < 1_150; index += 1) {
    const change = index < 960 ? Math.sin(index / 17) * 0.25 : 3 + (index - 960) * 0.01;
    const open = close;
    close += change;
    result.push({
      symbol: "ETHUSDT",
      interval: "5m",
      time: Date.parse("2026-01-05T00:00:00Z") / 1000 + index * 300,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: index < 960 ? 100 + index % 13 : 500 + index,
    });
  }
  return result;
}
