import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import {
  buildFixedGridPaperReport,
  calculateFixedGridDirections,
  FIXED_GRID_CONFIG,
  FIXED_GRID_ROUTE_ID,
  simulateFixedGridSymbol,
} from "./FixedGridPaperEngine";

test("fixed grid creates twelve risk-scaled working orders only after closed 4h/1h confirmation", () => {
  const candles = makeTrendingWave("BTCUSDT");
  const directions = calculateFixedGridDirections(candles);
  const confirmationIndex = directions.findIndex((point) => point.confirmation === "long_break");
  assert.ok(confirmationIndex > 0);
  const confirmation = directions[confirmationIndex];
  const result = simulateFixedGridSymbol("BTCUSDT", candles.slice(0, confirmationIndex + 1), {
    forwardStart: candles[0].time,
  });

  assert.ok(result.plan);
  assert.equal(result.plan!.orders.length, 12);
  assert.equal(result.plan!.orders[0].price, confirmation.anchorPrice! - 200);
  assert.equal(result.plan!.orders[11].price, confirmation.anchorPrice! - 2_400);
  assert.ok(result.plan!.orders.every((order) => order.status === "working" && order.quantity !== null));
  assert.ok(result.plan!.orders.reduce((sum, order) => sum + order.marginFraction, 0) <= FIXED_GRID_CONFIG.cumulativeMarginFractionCap + 1e-12);
});

test("fixed grid fills adverse levels first, exits at target, and cancels unfilled orders", () => {
  const candles = makeTrendingWave("BTCUSDT");
  const directions = calculateFixedGridDirections(candles);
  const confirmationIndex = directions.findIndex((point) => point.confirmation === "long_break");
  const anchor = directions[confirmationIndex].anchorPrice!;
  const entryCandle: Candle = {
    symbol: "BTCUSDT",
    interval: "5m",
    time: candles[confirmationIndex].time + 300,
    open: anchor,
    high: anchor + 100,
    low: anchor - 650,
    close: anchor,
    volume: 10,
  };
  const result = simulateFixedGridSymbol("BTCUSDT", [...candles.slice(0, confirmationIndex + 1), entryCandle], {
    forwardStart: candles[0].time,
  });

  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].exitReason, "take_profit");
  assert.equal(result.completed[0].fills.length, 3);
  assert.ok(result.completed[0].plannedRisk <= FIXED_GRID_CONFIG.initialEquityPerSymbol * FIXED_GRID_CONFIG.maximumGroupLossFraction + 0.01);
  assert.equal(result.completed[0].orders.filter((order) => order.status === "cancelled").length, 9);
});

test("fixed grid confirmation is not changed by candles that arrive later", () => {
  const candles = makeTrendingWave("BTCUSDT");
  const full = calculateFixedGridDirections(candles);
  const confirmationIndex = full.findIndex((point) => point.confirmation !== "none");
  const prefix = calculateFixedGridDirections(candles.slice(0, confirmationIndex + 1));
  assert.deepEqual(prefix.at(-1), full[confirmationIndex]);
});

test("fixed grid route remains Paper-only with exchange ordering disabled", () => {
  const btc = makeTrendingWave("BTCUSDT").slice(0, 500);
  const eth = makeTrendingWave("ETHUSDT").slice(0, 500);
  const report = buildFixedGridPaperReport({ BTCUSDT: btc, ETHUSDT: eth }, { forwardStart: btc[0].time });
  assert.equal(report.routeId, FIXED_GRID_ROUTE_ID);
  assert.equal(report.assumptions.automaticOrdersEnabled, false);
  assert.equal(report.assumptions.exchangeCredentialsRequired, false);
  assert.equal(report.configuration.maximumLayers, 12);
});

test("fixed grid can disable the holding timeout without disabling structural exits", () => {
  const candles = makeTrendingWave("BTCUSDT");
  const directions = calculateFixedGridDirections(candles);
  const confirmationIndex = directions.findIndex((point) => point.confirmation === "long_break");
  const anchor = directions[confirmationIndex].anchorPrice!;
  const entryTime = candles[confirmationIndex].time + 300;
  const entryCandle: Candle = {
    symbol: "BTCUSDT", interval: "5m", time: entryTime,
    open: anchor, high: anchor, low: anchor - 210, close: anchor - 200, volume: 10,
  };
  const laterCandle: Candle = {
    ...entryCandle,
    time: entryTime + 24 * 3600,
    open: anchor - 200,
    high: anchor - 150,
    low: anchor - 250,
    close: anchor - 200,
  };
  const prefix = [...candles.slice(0, confirmationIndex + 1), entryCandle, laterCandle];
  const timed = simulateFixedGridSymbol("BTCUSDT", prefix, {
    forwardStart: candles[0].time,
    config: { ...FIXED_GRID_CONFIG, maximumHoldingMinutes: 60 },
  });
  const untimed = simulateFixedGridSymbol("BTCUSDT", prefix, {
    forwardStart: candles[0].time,
    config: { ...FIXED_GRID_CONFIG, maximumHoldingMinutes: null },
  });

  assert.equal(timed.completed.at(-1)?.exitReason, "timeout");
  assert.equal(untimed.completed.length, 0);
  assert.ok(untimed.open);
  assert.equal(untimed.open!.stopPrice, anchor - 2_800);
});

test("fixed grid can keep one unfilled plan without an expiry until a newer confirmation replaces it", () => {
  const candles = makeTrendingWave("BTCUSDT");
  const directions = calculateFixedGridDirections(candles);
  const confirmationIndex = directions.findIndex((point) => point.confirmation === "long_break");
  const prefix = candles.slice(0, confirmationIndex + 1);
  const later = Array.from({ length: 100 }, (_, index): Candle => ({
    ...prefix.at(-1)!,
    time: prefix.at(-1)!.time + (index + 1) * 300,
    open: directions[confirmationIndex].anchorPrice!,
    high: directions[confirmationIndex].anchorPrice! + 50,
    low: directions[confirmationIndex].anchorPrice! - 50,
    close: directions[confirmationIndex].anchorPrice!,
  }));
  const result = simulateFixedGridSymbol("BTCUSDT", [...prefix, ...later], {
    forwardStart: candles[0].time,
    config: { ...FIXED_GRID_CONFIG, directionValidityHours: null },
  });

  assert.ok(result.plan);
  assert.equal(result.plan!.expiresAt, null);
  assert.equal(result.diagnostics.expiredPlans, 0);
});

function makeTrendingWave(symbol: "BTCUSDT" | "ETHUSDT"): Candle[] {
  const start = 1_780_000_000 - (1_780_000_000 % 300);
  const base = symbol === "BTCUSDT" ? 60_000 : 3_000;
  const drift = symbol === "BTCUSDT" ? 0.8 : 0.04;
  const amplitude = symbol === "BTCUSDT" ? 600 : 30;
  return Array.from({ length: 5_000 }, (_, index) => {
    const price = base + index * drift + amplitude * Math.sin(index * 2 * Math.PI / 576);
    return {
      symbol,
      interval: "5m",
      time: start + index * 300,
      open: price,
      high: price + amplitude / 30,
      low: price - amplitude / 30,
      close: price + amplitude / 120,
      volume: 10,
    };
  });
}
