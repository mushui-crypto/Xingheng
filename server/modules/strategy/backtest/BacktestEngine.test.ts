import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import type { Strategy } from "../core/types";
import { BacktestEngine, defaultBacktestConfig } from "./BacktestEngine";

test("backtest enters only after signal candle and applies fees and adverse slippage", () => {
  const strategy: Strategy = {
    id: "fixture",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "signal-1",
      strategyId: "fixture",
      symbol: "BTCUSDT",
      interval: "1m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 98,
      targetPrice: 104,
      riskFraction: 0.0025,
      reasonCodes: ["FIXTURE"],
      evidence: {},
    } : null,
  };
  const candles = [
    candle(0, 100, 101, 99, 100),
    candle(1, 101, 102, 99, 101),
    candle(2, 101, 105, 100, 104),
  ];
  const result = new BacktestEngine(strategy, {
    initialEquity: 10_000,
    makerEntryFeeRate: 0.001,
    takerExitFeeRate: 0.001,
    slippageBps: 1,
    maxLeverage: 3,
    dailyLossFraction: 0.01,
    maxTradesPerDay: 2,
    maxConsecutiveLossesPerDay: 2,
    minNetRewardRisk: 1,
    sessionStartMinute: 8 * 60 + 30,
    sessionEndMinute: 11 * 60,
  }).run(candles);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryTime, candles[1].time);
  assert.equal(result.trades[0].exitReason, "target");
  assert.ok(result.trades[0].fees > 0);
  assert.ok(result.trades[0].entryPrice > 100);
  assert.ok(result.trades[0].exitPrice < 104);
});

test("same-candle stop and target collision is resolved conservatively as stop", () => {
  const strategy: Strategy = {
    id: "fixture",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "signal-2",
      strategyId: "fixture",
      symbol: "BTCUSDT",
      interval: "1m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 98,
      targetPrice: 104,
      riskFraction: 0.0025,
      reasonCodes: [],
      evidence: {},
    } : null,
  };
  const result = new BacktestEngine(strategy, {
    initialEquity: 10_000,
    makerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    maxLeverage: 3,
    dailyLossFraction: 0.01,
    maxTradesPerDay: 2,
    maxConsecutiveLossesPerDay: 2,
    minNetRewardRisk: 1,
    sessionStartMinute: 8 * 60 + 30,
    sessionEndMinute: 11 * 60,
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101, 99, 100),
    candle(2, 100, 105, 97, 101),
  ]);
  assert.equal(result.trades[0].exitReason, "stop");
});

test("entry-candle ambiguity is resolved conservatively as an immediate stop", () => {
  const strategy: Strategy = {
    id: "fixture",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "signal-entry-collision",
      strategyId: "fixture",
      symbol: "BTCUSDT",
      interval: "1m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 98,
      targetPrice: 104,
      riskFraction: 0.0025,
      reasonCodes: [],
      evidence: {},
    } : null,
  };
  const result = new BacktestEngine(strategy, {
    initialEquity: 10_000,
    makerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    maxLeverage: 3,
    dailyLossFraction: 0.01,
    maxTradesPerDay: 2,
    maxConsecutiveLossesPerDay: 2,
    minNetRewardRisk: 1,
    sessionStartMinute: 8 * 60 + 30,
    sessionEndMinute: 11 * 60,
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 105, 97, 101),
  ]);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryTime, result.trades[0].exitTime);
  assert.equal(result.trades[0].exitReason, "stop");
});

test("rejects a fill when round-trip costs reduce expected reward-risk below the floor", () => {
  const strategy: Strategy = {
    id: "fixture",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "signal-cost",
      strategyId: "fixture",
      symbol: "BTCUSDT",
      interval: "1m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 99.9,
      targetPrice: 100.2,
      riskFraction: 0.0025,
      reasonCodes: [],
      evidence: {},
    } : null,
  };
  const result = new BacktestEngine(strategy, {
    initialEquity: 10_000,
    makerEntryFeeRate: 0.001,
    takerExitFeeRate: 0.001,
    slippageBps: 1,
    maxLeverage: 3,
    dailyLossFraction: 0.01,
    maxTradesPerDay: 2,
    maxConsecutiveLossesPerDay: 2,
    minNetRewardRisk: 1.5,
    sessionStartMinute: 8 * 60 + 30,
    sessionEndMinute: 11 * 60,
  }).run([
    candle(0, 100, 100.1, 99.9, 100),
    candle(1, 100, 100.1, 99.9, 100),
  ]);
  assert.equal(result.trades.length, 0);
  assert.equal(result.diagnostics.costRejectedOrders, 1);
});

test("does not fill a pending order after the configured session closes", () => {
  const signalTime = Date.parse("2026-07-15T14:55:00Z") / 1000;
  const strategy: Strategy = {
    id: "fixture",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "signal-session-close",
      strategyId: "fixture",
      symbol: "BTCUSDT",
      interval: "5m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 3600,
      side: "long",
      entryPrice: 100,
      stopPrice: 98,
      targetPrice: 106,
      riskFraction: 0.0025,
      reasonCodes: [],
      evidence: {},
    } : null,
  };
  const result = new BacktestEngine(strategy, {
    initialEquity: 10_000,
    makerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    maxLeverage: 3,
    dailyLossFraction: 0.01,
    maxTradesPerDay: 2,
    maxConsecutiveLossesPerDay: 2,
    minNetRewardRisk: 1,
    sessionStartMinute: 8 * 60 + 30,
    sessionEndMinute: 11 * 60,
  }).run([
    { ...candle(0, 100, 101, 99, 100), interval: "5m", time: signalTime },
    { ...candle(1, 100, 101, 99, 100), interval: "5m", time: signalTime + 300 },
  ]);
  assert.equal(result.trades.length, 0);
  assert.equal(result.diagnostics.expiredOrders, 1);
});

test("keeps an open position after the entry session closes when configured", () => {
  const signalTime = Date.parse("2026-07-15T14:45:00Z") / 1000;
  const strategy: Strategy = {
    id: "hold-after-session",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "signal-hold-after-session",
      strategyId: "hold-after-session",
      symbol: "BTCUSDT",
      interval: "5m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 3600,
      side: "long",
      entryPrice: 100,
      stopPrice: 98,
      targetPrice: 104,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    } : null,
  };
  const result = new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 1,
    sessionStartMinute: 8 * 60 + 30,
    sessionEndMinute: 11 * 60,
    closePositionAtSessionEnd: false,
  }).run([
    { ...candle(0, 100, 101, 99, 100), interval: "5m", time: signalTime },
    { ...candle(1, 100, 101, 99, 100), interval: "5m", time: signalTime + 300 },
    { ...candle(2, 100, 101, 99, 100), interval: "5m", time: signalTime + 900 },
    { ...candle(3, 100, 105, 99, 104), interval: "5m", time: signalTime + 1200 },
  ]);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, "target");
  assert.ok(result.trades[0].exitTime > signalTime + 900);
});

test("can disable account-level risk gates while retaining structural exits", () => {
  const strategy: Strategy = {
    id: "no-account-risk-gates",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 || index === 2 ? {
      id: `signal-${index}`,
      strategyId: "no-account-risk-gates",
      symbol: "BTCUSDT",
      interval: "1m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 99,
      targetPrice: 100.1,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    } : null,
  };
  const result = new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    maxLeverage: 0.0001,
    dailyLossFraction: 0,
    maxTradesPerDay: 1,
    maxConsecutiveLossesPerDay: 0,
    minNetRewardRisk: 100,
    sessionStartMinute: 0,
    sessionEndMinute: 0,
    accountRiskControlsEnabled: false,
  }).run([
    candle(0, 100, 100, 100, 100),
    candle(1, 100, 101, 100, 100.5),
    candle(2, 100, 100, 100, 100),
    candle(3, 100, 101, 100, 100.5),
  ]);
  assert.equal(result.trades.length, 2);
  assert.ok(result.trades.every((trade) => trade.exitReason === "target"));
  assert.ok(result.trades.every((trade) => trade.quantity > 0.01));
});

test("fixed-margin sizing converts margin fraction and leverage into position notional", () => {
  const strategy: Strategy = {
    id: "fixed-margin-sizing",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "fixed-margin-signal",
      strategyId: "fixed-margin-sizing",
      symbol: "BTCUSDT",
      interval: "1m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 98,
      targetPrice: 104,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    } : null,
  };
  const result = new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    accountRiskControlsEnabled: false,
    positionSizingMode: "fixed_margin_fraction",
    positionMarginFraction: 0.02,
    positionLeverage: 100,
    liquidationMaintenanceMarginRate: 0.005,
    sessionStartMinute: 0,
    sessionEndMinute: 0,
  }).run([
    candle(0, 100, 100, 100, 100),
    candle(1, 100, 105, 100, 104),
  ]);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].allocatedMargin, 200);
  assert.equal(result.trades[0].quantity, 200);
  assert.equal(result.trades[0].entryPrice * result.trades[0].quantity, 20_000);
});

test("liquidation exits before a structural stop that is beyond the liquidation price", () => {
  const strategy: Strategy = {
    id: "liquidation-aware",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "liquidation-signal",
      strategyId: "liquidation-aware",
      symbol: "BTCUSDT",
      interval: "1m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 98,
      targetPrice: 104,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    } : null,
  };
  const result = new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    accountRiskControlsEnabled: false,
    positionSizingMode: "fixed_margin_fraction",
    positionMarginFraction: 0.02,
    positionLeverage: 100,
    liquidationMaintenanceMarginRate: 0.005,
    liquidationFeeRate: 0.0125,
    sessionStartMinute: 0,
    sessionEndMinute: 0,
  }).run([
    candle(0, 100, 100, 100, 100),
    candle(1, 100, 100.2, 99.4, 99.5),
  ]);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, "liquidation");
  assert.ok(result.trades[0].liquidationPrice! > 99.49 && result.trades[0].liquidationPrice! < 99.51);
  assert.ok(result.trades[0].exitPrice > result.trades[0].stopPrice);
  assert.ok(Math.abs(result.trades[0].netPnl + 200) < 1e-9);
});

test("cross margin uses the full account equity as liquidation collateral", () => {
  const strategy: Strategy = {
    id: "cross-margin",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "cross-margin-signal",
      strategyId: "cross-margin",
      symbol: "BTCUSDT",
      interval: "1m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 90,
      targetPrice: 110,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    } : null,
  };
  const result = new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    accountRiskControlsEnabled: false,
    positionSizingMode: "fixed_margin_fraction",
    positionMarginFraction: 0.05,
    positionLeverage: 100,
    positionMarginMode: "cross",
    liquidationMaintenanceMarginRate: 0.004,
    liquidationFeeRate: 0.0125,
    sessionStartMinute: 0,
    sessionEndMinute: 0,
  }).run([
    candle(0, 100, 100, 100, 100),
    candle(1, 100, 111, 95, 110),
  ]);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].marginMode, "cross");
  assert.equal(result.trades[0].allocatedMargin, 500);
  assert.equal(result.trades[0].liquidationCollateral, 10_000);
  assert.ok(result.trades[0].liquidationPrice! > 80.3 && result.trades[0].liquidationPrice! < 80.4);
  assert.equal(result.trades[0].exitReason, "target");
});

test("market signal fills at the next candle open and pays taker entry fee", () => {
  const strategy: Strategy = {
    id: "market-fixture",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "signal-market",
      strategyId: "market-fixture",
      symbol: "BTCUSDT",
      interval: "1m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 120,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    } : null,
  };
  const result = new BacktestEngine(strategy, {
    initialEquity: 10_000,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0.001,
    takerExitFeeRate: 0,
    slippageBps: 0,
    maxLeverage: 3,
    dailyLossFraction: 0.01,
    maxTradesPerDay: 2,
    maxConsecutiveLossesPerDay: 2,
    minNetRewardRisk: 1,
    sessionStartMinute: 8 * 60 + 30,
    sessionEndMinute: 11 * 60,
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 103, 104, 102, 103),
    candle(2, 103, 121, 102, 120),
  ]);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryPrice, 103);
  assert.ok(result.trades[0].fees > 0);
});

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return {
    symbol: "BTCUSDT",
    interval: "1m",
    time: Date.parse("2026-07-15T13:30:00Z") / 1000 + index * 60,
    open,
    high,
    low,
    close,
    volume: 1,
  };
}
