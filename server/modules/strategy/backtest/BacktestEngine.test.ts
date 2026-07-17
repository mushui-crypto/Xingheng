import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import type { Strategy, StrategyExitPlan } from "../core/types";
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

test("reward-risk target is resolved from the actual next-bar market fill", () => {
  const strategy: Strategy = {
    id: "dynamic-target-fixture",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "signal-dynamic-target",
      strategyId: "dynamic-target-fixture",
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
  const result = new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 103, 104, 102, 103),
    candle(2, 103, 120, 102, 119),
  ]);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryPrice, 103);
  assert.equal(result.trades[0].stopPrice, 95);
  assert.equal(result.trades[0].targetPrice, 119);
  assert.equal(result.trades[0].exitPrice, 119);
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

test("partial exit plan realizes TP1 and TP2 with correctly aggregated fees and PnL", () => {
  const strategy = partialExitFixture("partial-two-targets");
  const result = new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0.001,
    takerEntryFeeRate: 0.001,
    takerExitFeeRate: 0.001,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 105, 99, 104),
    candle(2, 105, 111, 101, 110),
    candle(3, 110, 126, 109, 125),
  ]);

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, "target");
  assert.equal(trade.exitLegs?.length, 2);
  assert.deepEqual(trade.exitLegs?.map((leg) => [leg.label, leg.reason]), [
    ["tp1_1r", "partial_target"],
    ["tp2_2_5r", "target"],
  ]);
  assert.ok(Math.abs(trade.exitLegs!.reduce((sum, leg) => sum + leg.quantityFraction, 0) - 1) < 1e-12);
  assert.ok(Math.abs(trade.grossPnl - trade.exitLegs!.reduce((sum, leg) => sum + leg.grossPnl, 0)) < 1e-9);
  assert.ok(Math.abs(trade.fees - (
    trade.exitLegs!.reduce((sum, leg) => sum + leg.entryFeeAllocated + leg.exitFee, 0)
  )) < 1e-9);
  assert.ok(Math.abs(trade.netPnl - trade.exitLegs!.reduce((sum, leg) => sum + leg.netPnl, 0)) < 1e-9);
});

test("TP1 moves the remaining stop to actual entry and a later candle exits at break-even", () => {
  const result = new BacktestEngine(partialExitFixture("partial-break-even"), {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 105, 99, 104),
    candle(2, 105, 111, 101, 110),
    candle(3, 104, 105, 99, 100),
  ]);

  const trade = result.trades[0];
  assert.equal(trade.exitReason, "stop");
  assert.deepEqual(trade.exitLegs?.map((leg) => [leg.label, leg.reason, leg.price]), [
    ["tp1_1r", "partial_target", 110],
    ["stop", "stop", 100],
  ]);
});

test("same-candle TP1 and break-even collision records TP1 then conservatively stops the remainder", () => {
  const result = new BacktestEngine(partialExitFixture("partial-same-candle-be"), {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 105, 99, 104),
    candle(2, 105, 126, 99, 110),
  ]);

  const trade = result.trades[0];
  assert.equal(trade.exitReason, "stop");
  assert.deepEqual(trade.exitLegs?.map((leg) => [leg.label, leg.reason]), [
    ["tp1_1r", "partial_target"],
    ["stop", "stop"],
  ]);
  assert.equal(trade.exitLegs?.some((leg) => leg.label === "tp2_2_5r"), false);
});

test("initial stop wins over TP1 when both are touched in one candle", () => {
  const result = new BacktestEngine(partialExitFixture("partial-stop-first"), {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 105, 99, 104),
    candle(2, 105, 111, 89, 100),
  ]);

  const trade = result.trades[0];
  assert.equal(trade.exitReason, "stop");
  assert.deepEqual(trade.exitLegs?.map((leg) => [leg.label, leg.reason, leg.price]), [
    ["stop", "stop", 90],
  ]);
});

test("invalid partial exit fractions are rejected at fill without opening a trade", () => {
  const strategy = partialExitFixture("invalid-partial-plan", {
    targets: [
      { price: 110, quantityFraction: 0.5, moveStopToBreakEvenAfterFill: true },
      { price: 125, quantityFraction: 0.4 },
    ],
  });
  const result = new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 105, 99, 104),
  ]);

  assert.equal(result.trades.length, 0);
  assert.equal(result.diagnostics.signals, 1);
  assert.equal(result.diagnostics.costRejectedOrders, 1);
  assert.equal(result.diagnostics.filledOrders, 0);
});

function partialExitFixture(id: string, exitPlan: StrategyExitPlan = {
  targets: [
    { price: 110, quantityFraction: 0.5, moveStopToBreakEvenAfterFill: true, label: "tp1_1r" },
    { price: 125, quantityFraction: 0.5, label: "tp2_2_5r" },
  ],
}): Strategy {
  return {
    id,
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: `${id}-signal`,
      strategyId: id,
      symbol: "BTCUSDT",
      interval: "1m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 90,
      targetPrice: 125,
      exitPlan,
      riskFraction: 0.0025,
      reasonCodes: [],
      evidence: {},
    } : null,
  };
}

test("signal-level maximum holding time closes the remaining position without enabling loss locks", () => {
  const result = new BacktestEngine(timeExitFixture("time-exit", 120), {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 105, 99, 104),
    candle(2, 104, 108, 101, 106),
    candle(3, 106, 109, 103, 107),
  ]);

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, "time_stop");
  assert.equal(result.trades[0].exitTime - result.trades[0].entryTime, 120);
  assert.equal(result.trades[0].exitLegs?.at(-1)?.reason, "time_stop");
  assert.equal(result.trades[0].exitPrice, 107);
});

test("target execution precedes a time exit when both occur on the holding-limit candle", () => {
  const result = new BacktestEngine(timeExitFixture("target-before-time-exit", 120), {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 105, 99, 104),
    candle(2, 104, 108, 101, 106),
    candle(3, 106, 126, 103, 107),
  ]);

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, "target");
  assert.equal(result.trades[0].exitPrice, 125);
});

function timeExitFixture(id: string, maxHoldingSeconds: number): Strategy {
  return {
    id,
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: `${id}-signal`,
      strategyId: id,
      symbol: "BTCUSDT",
      interval: "1m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 300,
      side: "long",
      entryPrice: 100,
      stopPrice: 90,
      targetPrice: 125,
      maxHoldingSeconds,
      riskFraction: 0.0025,
      reasonCodes: [],
      evidence: {},
    } : null,
  };
}

test("limits actual new entries to two per New York day and restores capacity the next day", () => {
  const evaluatedIndexes: number[] = [];
  const strategy: Strategy = {
    id: "daily-entry-limit",
    warmupBars: 0,
    evaluate: ({ candles, index }) => {
      evaluatedIndexes.push(index);
      return {
        id: `daily-entry-${index}`,
        strategyId: "daily-entry-limit",
        symbol: "ETHUSDT",
        interval: "5m",
        createdAt: candles[index].time,
        expiresAt: candles[index].time + 600,
        side: "long",
        entryPrice: 100,
        stopPrice: 99,
        targetPrice: 102,
        riskFraction: 0.0025,
        entryOrderType: "market",
        reasonCodes: [],
        evidence: {},
      };
    },
  };
  const wednesday = Date.parse("2026-07-15T13:00:00Z") / 1_000;
  const thursday = Date.parse("2026-07-16T13:00:00Z") / 1_000;
  const candles: Candle[] = [
    { ...candle(0, 100, 100, 100, 100), interval: "5m", time: wednesday },
    { ...candle(1, 100, 100, 98, 99), interval: "5m", time: wednesday + 300 },
    { ...candle(2, 100, 100, 98, 99), interval: "5m", time: wednesday + 600 },
    { ...candle(3, 100, 100, 100, 100), interval: "5m", time: wednesday + 900 },
    { ...candle(4, 100, 100, 100, 100), interval: "5m", time: thursday },
    { ...candle(5, 100, 100, 98, 99), interval: "5m", time: thursday + 300 },
  ];
  const result = new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    maxNewEntriesPerDay: 2,
    closePositionAtSessionEnd: false,
    sessionStartMinute: 0,
    sessionEndMinute: 0,
  }).run(candles);

  assert.equal(result.trades.length, 3);
  assert.deepEqual(result.trades.map((trade) => trade.entryTime), [
    wednesday + 300,
    wednesday + 600,
    thursday + 300,
  ]);
  assert.deepEqual(evaluatedIndexes.filter((index) => index < 4), [0, 1]);
  assert.ok(evaluatedIndexes.includes(4));
});

test("disabled account loss locks allow a second same-day entry after the first stop", () => {
  const strategy: Strategy = {
    id: "loss-lock-disabled",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index <= 1 ? {
      id: `loss-lock-disabled-${index}`,
      strategyId: "loss-lock-disabled",
      symbol: "ETHUSDT",
      interval: "5m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 600,
      side: "long",
      entryPrice: 100,
      stopPrice: 99,
      targetPrice: 102,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    } : null,
  };
  const start = Date.parse("2026-07-15T13:00:00Z") / 1_000;
  const result = new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    dailyLossFraction: 0,
    maxTradesPerDay: 1,
    maxConsecutiveLossesPerDay: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    maxNewEntriesPerDay: 2,
    closePositionAtSessionEnd: false,
    sessionStartMinute: 0,
    sessionEndMinute: 0,
  }).run([
    { ...candle(0, 100, 100, 100, 100), interval: "5m", time: start },
    { ...candle(1, 100, 100, 98, 99), interval: "5m", time: start + 300 },
    { ...candle(2, 100, 100, 98, 99), interval: "5m", time: start + 600 },
  ]);

  assert.equal(result.trades.length, 2);
  assert.ok(result.trades.every((trade) => trade.exitReason === "stop"));
});

test("a Friday position may remain open through the weekend when session-end closing is disabled", () => {
  const friday = Date.parse("2026-07-17T14:00:00Z") / 1_000;
  const saturday = Date.parse("2026-07-18T14:00:00Z") / 1_000;
  const sunday = Date.parse("2026-07-19T14:00:00Z") / 1_000;
  const monday = Date.parse("2026-07-20T14:00:00Z") / 1_000;
  const strategy: Strategy = {
    id: "weekend-hold",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? {
      id: "weekend-hold-signal",
      strategyId: "weekend-hold",
      symbol: "ETHUSDT",
      interval: "5m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 600,
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
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    maxNewEntriesPerDay: 2,
    closePositionAtSessionEnd: false,
    sessionStartMinute: 0,
    sessionEndMinute: 0,
  }).run([
    { ...candle(0, 100, 101, 99, 100), interval: "5m", time: friday },
    { ...candle(1, 100, 102, 99, 101), interval: "5m", time: friday + 300 },
    { ...candle(2, 101, 103, 99, 102), interval: "5m", time: saturday },
    { ...candle(3, 102, 104, 99, 103), interval: "5m", time: sunday },
    { ...candle(4, 103, 111, 102, 110), interval: "5m", time: monday },
  ]);

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryTime, friday + 300);
  assert.equal(result.trades[0].exitTime, monday);
  assert.equal(result.trades[0].exitReason, "target");
  assert.ok(result.trades[0].exitTime - result.trades[0].entryTime > 48 * 3600);
});

test("a pending touch rejected by the daily entry cap is diagnosed separately from cost rejection", () => {
  const mutableConfig = {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
    sessionStartMinute: 0,
    sessionEndMinute: 0,
  };
  const strategy: Strategy = {
    id: "pending-entry-cap-diagnostic",
    warmupBars: 0,
    evaluate: ({ candles, index }) => {
      if (index !== 0) return null;
      mutableConfig.maxNewEntriesPerDay = 0;
      return {
        id: "pending-entry-cap-signal",
        strategyId: "pending-entry-cap-diagnostic",
        symbol: "ETHUSDT",
        interval: "5m",
        createdAt: candles[index].time,
        expiresAt: candles[index].time + 600,
        side: "long",
        entryPrice: 100,
        stopPrice: 99,
        targetPrice: 102,
        riskFraction: 0.0025,
        entryOrderType: "limit",
        reasonCodes: [],
        evidence: { regimeKey: "fixture" },
      };
    },
  };
  const start = Date.parse("2026-07-15T13:00:00Z") / 1_000;
  const result = new BacktestEngine(strategy, mutableConfig).run([
    { ...candle(0, 101, 102, 101, 101), interval: "5m", time: start },
    { ...candle(1, 101, 102, 99, 100), interval: "5m", time: start + 300 },
  ]);

  assert.equal(result.trades.length, 0);
  assert.equal(result.diagnostics.entryLimitRejectedOrders, 1);
  assert.equal(result.diagnostics.costRejectedOrders, 0);
  assert.equal(result.diagnostics.byRegime.fixture.entryLimitRejected, 1);
  assert.equal(result.diagnostics.byRegime.fixture.costRejected, 0);
});

test("maxConcurrentPositions allows two overlapping positions while the default remains one", () => {
  const makeStrategy = (): Strategy => ({
    id: "concurrent-two",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index <= 1 ? ({
      id: `concurrent-${index}`,
      strategyId: "concurrent-two",
      symbol: "BTCUSDT",
      interval: "5m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 600,
      side: "long",
      entryPrice: 100,
      stopPrice: 90,
      targetPrice: 120,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    }) : null,
  });
  const items = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101, 99, 100),
    candle(2, 100, 101, 99, 100),
    candle(3, 100, 101, 99, 100),
  ];
  const config = {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
    sessionStartMinute: 0,
    sessionEndMinute: 0,
  };
  const single = new BacktestEngine(makeStrategy(), config).run(items);
  const concurrent = new BacktestEngine(makeStrategy(), { ...config, maxConcurrentPositions: 2 }).run(items);

  assert.equal(single.trades.length, 1);
  assert.equal(single.diagnostics.maximumConcurrentPositions, 1);
  assert.equal(concurrent.trades.length, 2);
  assert.equal(concurrent.diagnostics.maximumConcurrentPositions, 2);
});

test("same-side concurrency rejects an opposite signal while a position is open", () => {
  const strategy: Strategy = {
    id: "same-side-only",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index <= 1 ? ({
      id: `same-side-${index}`,
      strategyId: "same-side-only",
      symbol: "BTCUSDT",
      interval: "5m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 600,
      side: index === 0 ? "long" : "short",
      entryPrice: 100,
      stopPrice: index === 0 ? 90 : 110,
      targetPrice: index === 0 ? 120 : 80,
      riskFraction: 0.0025,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    }) : null,
  };
  const result = new BacktestEngine(strategy, {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
    sessionStartMinute: 0,
    sessionEndMinute: 0,
    maxConcurrentPositions: 2,
    concurrentPositionMode: "same_side",
  }).run([
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101, 99, 100),
    candle(2, 100, 101, 99, 100),
  ]);

  assert.equal(result.trades.length, 1);
  assert.equal(result.diagnostics.concurrentSignalsRejected, 1);
  assert.equal(result.diagnostics.maximumConcurrentPositions, 1);
});

test("mark-to-market equity records intratrade drawdown before a profitable exit", () => {
  const makeStrategy = (): Strategy => ({
    id: "mark-to-market",
    warmupBars: 0,
    evaluate: ({ candles, index }) => index === 0 ? ({
      id: "mark-to-market-signal",
      strategyId: "mark-to-market",
      symbol: "BTCUSDT",
      interval: "5m",
      createdAt: candles[index].time,
      expiresAt: candles[index].time + 600,
      side: "long",
      entryPrice: 100,
      stopPrice: 90,
      targetPrice: 110,
      riskFraction: 0.1,
      entryOrderType: "market",
      reasonCodes: [],
      evidence: {},
    }) : null,
  });
  const items = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101, 99, 100),
    candle(2, 100, 96, 94, 95),
    candle(3, 100, 111, 99, 110),
  ];
  const config = {
    ...defaultBacktestConfig,
    makerEntryFeeRate: 0,
    takerEntryFeeRate: 0,
    takerExitFeeRate: 0,
    slippageBps: 0,
    minNetRewardRisk: 0,
    accountRiskControlsEnabled: false,
    closePositionAtSessionEnd: false,
    sessionStartMinute: 0,
    sessionEndMinute: 0,
  };
  const realizedOnly = new BacktestEngine(makeStrategy(), config).run(items);
  const marked = new BacktestEngine(makeStrategy(), { ...config, markToMarketEquityCurve: true }).run(items);

  assert.equal(realizedOnly.metrics.maxDrawdownFraction, 0);
  assert.ok(marked.metrics.maxDrawdownFraction > 0.04);
  assert.equal(marked.trades[0].exitReason, "target");
});
