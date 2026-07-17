import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { EthFactorScoreStrategy } from "./EthFactorScoreStrategy";

test("factor signal at an index is unchanged when every future candle is replaced", () => {
  const candles = makeCandles();
  const strategy = new EthFactorScoreStrategy({
    symbol: "ETHUSDT",
    family: "trend_continuation",
    threshold: 1,
    stopAtr: 1.5,
    rewardRisk: 2,
    session: "all",
    riskFraction: 0.0025,
    maximumHoldingBars: 24,
  });
  strategy.prepare(candles);
  const signalIndex = findSignalIndex(strategy, candles);
  assert.ok(signalIndex > 300, "synthetic series should produce a threshold-cross signal");
  const original = strategy.evaluate({ candles, index: signalIndex, equity: 10_000 });
  strategy.release();

  const mutated = candles.map((candle, index) => index <= signalIndex ? candle : {
    ...candle,
    open: 10_000 + index,
    high: 10_100 + index,
    low: 9_900 + index,
    close: 10_050 + index,
    volume: 1_000_000,
  });
  const replay = new EthFactorScoreStrategy(strategy.config);
  replay.prepare(mutated);
  const afterFutureMutation = replay.evaluate({ candles: mutated, index: signalIndex, equity: 10_000 });
  assert.deepEqual(afterFutureMutation, original);
  replay.release();
});

test("factor strategy emits a next-bar market signal with a hard ATR stop", () => {
  const candles = makeCandles();
  const strategy = new EthFactorScoreStrategy({
    symbol: "ETHUSDT",
    family: "trend_continuation",
    threshold: 1,
    stopAtr: 2,
    rewardRisk: 2.5,
    session: "all",
    riskFraction: 0.0025,
    maximumHoldingBars: 24,
  });
  strategy.prepare(candles);
  const index = findSignalIndex(strategy, candles);
  const signal = strategy.evaluate({ candles, index, equity: 10_000 });
  assert.ok(signal);
  assert.equal(signal.entryOrderType, "market");
  assert.equal(signal.expiresAt, candles[index].time + 300);
  assert.equal(signal.maxHoldingSeconds, 24 * 300);
  assert.ok(signal.side === "long" ? signal.stopPrice < signal.entryPrice : signal.stopPrice > signal.entryPrice);
  strategy.release();
});

function findSignalIndex(strategy: EthFactorScoreStrategy, candles: Candle[]) {
  for (let index = strategy.warmupBars; index < candles.length; index += 1) {
    if (strategy.evaluate({ candles, index, equity: 10_000 })) return index;
  }
  return -1;
}
function makeCandles() {
  const candles: Candle[] = [];
  let close = 2_000;
  for (let index = 0; index < 380; index += 1) {
    const change = index < 325 ? Math.sin(index / 9) * 0.3 : 6 + (index - 325) * 0.04;
    const open = close;
    close = Math.max(100, close + change);
    candles.push({
      symbol: "ETHUSDT",
      interval: "5m",
      time: Date.parse("2026-01-05T00:00:00Z") / 1000 + index * 300,
      open,
      high: Math.max(open, close) + 1.5,
      low: Math.min(open, close) - 1.5,
      close,
      volume: index < 325 ? 100 + index % 7 : 500 + index,
    });
  }
  return candles;
}
