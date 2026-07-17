import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import type { Strategy } from "../core/types";
import { SignalRangePullbackEntryStrategy } from "./SignalRangePullbackEntryStrategy";

test("signal-range pullback changes only entry execution and preserves structural stop and reward-risk", () => {
  const candles = fixtureCandles();
  const strategy = new SignalRangePullbackEntryStrategy(fixtureBase(), {
    kind: "signal_range_pullback",
    fraction: 0.25,
    expiryBars: 3,
  });
  const signal = strategy.evaluate({ candles, index: 0, equity: 10_000 });
  assert.ok(signal);
  assert.equal(signal.entryOrderType, "limit");
  assert.equal(signal.entryPrice, 97.5);
  assert.equal(signal.stopPrice, 80);
  assert.equal(signal.targetRewardRisk, 2.5);
  assert.equal(signal.targetPrice, 141.25);
  assert.equal(signal.expiresAt, candles[0].time + 900);
});

test("market baseline resolves the frozen reward-risk from the actual fill without changing the stop", () => {
  const candles = fixtureCandles();
  const signal = new SignalRangePullbackEntryStrategy(fixtureBase(), { kind: "next_bar_market" })
    .evaluate({ candles, index: 0, equity: 10_000 });
  assert.ok(signal);
  assert.equal(signal.entryOrderType, "market");
  assert.equal(signal.stopPrice, 80);
  assert.equal(signal.targetRewardRisk, 2.5);
  assert.equal(signal.expiresAt, candles[0].time + 300);
});

function fixtureBase(): Strategy {
  return {
    id: "entry-fixture",
    warmupBars: 0,
    evaluate: ({ candles, index }) => ({
      id: "base-signal",
      strategyId: "entry-fixture",
      symbol: "ETHUSDT",
      interval: "5m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 80,
      targetPrice: 150,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    }),
  };
}

function fixtureCandles(): Candle[] {
  return [{
    symbol: "ETHUSDT",
    interval: "5m",
    time: Date.parse("2026-07-17T12:00:00Z") / 1000,
    open: 95,
    high: 105,
    low: 90,
    close: 100,
    volume: 1,
  }];
}
