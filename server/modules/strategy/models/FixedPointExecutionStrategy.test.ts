import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import type { Strategy } from "../core/types";
import { FixedPointExecutionStrategy } from "./FixedPointExecutionStrategy";

test("fixed-point wrapper replaces ATR exits with exact 40/100 points and removes time exit", () => {
  const candles: Candle[] = [{
    symbol: "ETHUSDT",
    interval: "5m",
    time: Date.parse("2026-07-16T12:00:00Z") / 1000,
    open: 3_000,
    high: 3_010,
    low: 2_995,
    close: 3_005,
    volume: 100,
  }];
  const base: Strategy = {
    id: "base",
    warmupBars: 0,
    evaluate: ({ candles: input }) => ({
      id: "base-signal",
      strategyId: "base",
      symbol: "ETHUSDT",
      interval: "5m",
      createdAt: input[0].time,
      expiresAt: input[0].time + 300,
      side: "long",
      entryPrice: 3_005,
      stopPrice: 2_990,
      targetPrice: 3_035,
      maxHoldingSeconds: 3_600,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: ["BASE"],
      evidence: {},
    }),
  };
  const strategy = new FixedPointExecutionStrategy(base, {
    stopPoints: 40,
    targetPoints: 100,
    sessionTimeZone: "Asia/Shanghai",
    sessionStartMinute: 18 * 60,
    sessionEndMinute: 8 * 60,
    excludeWeekends: true,
  });
  const signal = strategy.evaluate({ candles, index: 0, equity: 10_000 });
  assert.ok(signal);
  assert.equal(signal.stopPrice, 2_965);
  assert.equal(signal.targetPrice, 3_105);
  assert.equal(signal.maxHoldingSeconds, undefined);
  assert.equal(signal.evidence.grossRewardRisk, 2.5);
});
