import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import type { Strategy, StrategySignal } from "../core/types";
import {
  IctConfirmedPullbackContinuationStrategy,
  ictRouteAConfirmedPullbackV2Config,
} from "./IctConfirmedPullbackContinuationStrategy";

test("confirmed pullback waits for a future midpoint touch and 5m rejection before emitting market entry", () => {
  const candles = fixtures();
  const source = setupSource(candles[14].time, "long");
  const strategy = new IctConfirmedPullbackContinuationStrategy(ictRouteAConfirmedPullbackV2Config, source);
  strategy.prepare(candles);

  assert.equal(strategy.evaluate({ candles, index: 14, equity: 10_000 }), null);
  const signal = strategy.evaluate({ candles, index: 15, equity: 10_000 });

  assert.ok(signal);
  assert.equal(signal.side, "long");
  assert.equal(signal.entryOrderType, "market");
  assert.equal(signal.targetRewardRisk, 2);
  assert.equal(signal.createdAt, candles[15].time);
  assert.ok(signal.stopPrice < candles[15].low);
  assert.deepEqual(signal.reasonCodes, ["HTF_EMA_TREND", "DISPLACEMENT_FVG", "FVG_MIDPOINT_TOUCH", "5M_REJECTION_MSS"]);
});

test("confirmed pullback cancels when original invalidation trades before confirmation", () => {
  const candles = fixtures();
  candles[15] = { ...candles[15], low: 89, close: 108 };
  const source = setupSource(candles[14].time, "long");
  const strategy = new IctConfirmedPullbackContinuationStrategy(ictRouteAConfirmedPullbackV2Config, source);
  strategy.prepare(candles);

  assert.equal(strategy.evaluate({ candles, index: 14, equity: 10_000 }), null);
  assert.equal(strategy.evaluate({ candles, index: 15, equity: 10_000 }), null);
  assert.equal(strategy.evaluate({ candles, index: 16, equity: 10_000 }), null);
});

function setupSource(createdAt: number, side: "long" | "short"): Strategy {
  return {
    id: "fixture-source",
    warmupBars: 14,
    evaluate: ({ candles, index }) => index === 14 ? ({
      id: "fixture-setup",
      strategyId: "fixture-source",
      symbol: "BTCUSDT",
      interval: "5m",
      createdAt,
      expiresAt: createdAt + 6 * 5 * 60,
      side,
      entryPrice: 100,
      stopPrice: 90,
      targetPrice: 120,
      riskFraction: 0.0025,
      entryOrderType: "limit",
      reasonCodes: [],
      evidence: { regimeKey: "fixture" },
    } satisfies StrategySignal) : null,
  };
}

function fixtures(): Candle[] {
  const start = Date.parse("2026-01-05T12:00:00Z") / 1000;
  const candles: Candle[] = Array.from({ length: 20 }, (_, index) => ({
    symbol: "BTCUSDT",
    interval: "5m",
    time: start + index * 5 * 60,
    open: 104,
    high: 106,
    low: 102,
    close: 104,
    volume: 10,
  }));
  candles[14] = { ...candles[14], open: 102, high: 103, low: 100, close: 102 };
  candles[15] = { ...candles[15], open: 101, high: 106, low: 99, close: 105 };
  candles[16] = { ...candles[16], open: 105, high: 106, low: 103, close: 104 };
  return candles;
}
