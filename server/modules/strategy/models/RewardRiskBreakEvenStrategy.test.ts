import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { BacktestEngine, defaultBacktestConfig } from "../backtest/BacktestEngine";
import type { Strategy } from "../core/types";
import { RewardRiskBreakEvenStrategy } from "./RewardRiskBreakEvenStrategy";

test("1R activation moves the full-position stop to actual entry and charges exit costs", () => {
  const result = run([
    candle(0, 100, 101, 99, 100),
    candle(1, 103, 112, 102, 111),
    candle(2, 111, 112, 102, 103),
  ]);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.entryPrice, 103);
  assert.equal(trade.exitReason, "break_even");
  assert.equal(trade.breakEvenActivatedAt, candle(1, 0, 0, 0, 0).time);
  assert.ok(trade.netPnl < 0, "fees make a price break-even exit a small net loss");
});

test("initial stop wins when the entry candle covers both the original stop and 1R activation", () => {
  const result = run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 111, 94, 100),
  ]);
  assert.equal(result.trades[0].exitReason, "stop");
  assert.equal(result.trades[0].breakEvenActivatedAt, null);
});

test("same candle 1R activation and entry retest exits at break-even before a covered target", () => {
  const result = run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 121, 99, 118),
  ]);
  assert.equal(result.trades[0].exitReason, "break_even");
  assert.notEqual(result.trades[0].exitReason, "target");
});

function run(candles: Candle[]) {
  const strategy = new RewardRiskBreakEvenStrategy(fixtureBase(), 1);
  return new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    takerEntryFeeRate: 0.001,
    takerExitFeeRate: 0.001,
    slippageBps: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
    sessionTimeZone: "UTC",
    sessionStartMinute: 0,
    sessionEndMinute: 0,
  }).run(candles);
}

function fixtureBase(): Strategy {
  return {
    id: "break-even-fixture",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "break-even-signal",
      strategyId: "break-even-fixture",
      symbol: "ETHUSDT",
      interval: "5m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      targetRewardRisk: 2,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    } : null,
  };
}

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return {
    symbol: "ETHUSDT",
    interval: "5m",
    time: Date.parse("2026-07-17T12:00:00Z") / 1000 + index * 300,
    open,
    high,
    low,
    close,
    volume: 1,
  };
}
