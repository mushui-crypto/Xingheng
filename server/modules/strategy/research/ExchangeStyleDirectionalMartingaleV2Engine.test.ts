import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import {
  approximateLiquidationPrice,
  simulateExchangeStyleDirectionalMartingaleV2,
  type ExchangeMartingaleV2Config,
} from "./ExchangeStyleDirectionalMartingaleV2Engine";

const baseConfig: ExchangeMartingaleV2Config = {
  id: "test",
  initialEquity: 5_000,
  leverageSelection: 20,
  marginMode: "isolated",
  maximumLayers: 6,
  amountMultiplier: 1.08,
  priceStepMultiplier: 1,
  stepMode: "fixed_fraction",
  fixedStepFractionBySymbol: { BTCUSDT: 0.006, ETHUSDT: 0.008 },
  atrStepMultiplier: 0.75,
  minimumStepFraction: 0.004,
  maximumStepFraction: 0.012,
  takeProfitPriceFraction: 0.008,
  reentryPolicy: "new_confirmation",
  cooldownMinutes: 240,
  cumulativeMarginFractionCap: 0.015,
  maximumCycleLossFraction: 0.005,
  stopBeyondLastStepMultiplier: 1,
  maintenanceMarginRateStress: 0.005,
  takerFeeRate: 0.00045,
  slippageRate: 0.0001,
};

test("20x liquidation stress uses an adverse 4.5 percent move at 0.5 percent maintenance margin", () => {
  assert.equal(approximateLiquidationPrice("long", 60_000, baseConfig), 57_300);
  assert.ok(Math.abs(approximateLiquidationPrice("short", 60_000, baseConfig) - 62_700) < 1e-9);
});

test("new-confirmation reentry cannot start more cycles than closed HTF confirmations", () => {
  const candles = makeTrend("long");
  const result = simulateExchangeStyleDirectionalMartingaleV2("BTCUSDT", candles, {
    forwardStart: candles[0].time,
    config: baseConfig,
  });

  assert.ok(result.completed.length > 0);
  assert.ok(result.diagnostics.longConfirmations > 0);
  assert.ok(result.diagnostics.startedCycles <= result.diagnostics.longConfirmations);
  let equity = baseConfig.initialEquity;
  for (const cycle of result.completed) {
    assert.ok(cycle.plannedRisk <= equity * baseConfig.maximumCycleLossFraction + 0.01);
    equity += cycle.netPnl;
  }
  assert.ok(result.completed.every((cycle) => cycle.holdingMinutes >= 0));
});

test("completed one-hour ATR mode remains causal and bounded", () => {
  const candles = makeTrend("short");
  const config: ExchangeMartingaleV2Config = {
    ...baseConfig,
    id: "atr",
    stepMode: "completed_1h_atr",
    reentryPolicy: "cooldown_4h",
  };
  const baseline = simulateExchangeStyleDirectionalMartingaleV2("BTCUSDT", candles, {
    forwardStart: candles[0].time,
    config,
  });
  const mutated = candles.map((candle, index) => index < 5_000 ? candle : {
    ...candle,
    open: candle.open * 1.2,
    high: candle.high * 1.2,
    low: candle.low * 1.2,
    close: candle.close * 1.2,
  });
  const replay = simulateExchangeStyleDirectionalMartingaleV2("BTCUSDT", mutated, {
    forwardStart: candles[0].time,
    config,
  });
  const cutoff = candles[5_000].time;

  assert.deepEqual(
    replay.completed.filter((cycle) => cycle.exitTime < cutoff),
    baseline.completed.filter((cycle) => cycle.exitTime < cutoff),
  );
  assert.ok(baseline.completed.every((cycle) => cycle.stepFraction >= config.minimumStepFraction));
  assert.ok(baseline.completed.every((cycle) => cycle.stepFraction <= config.maximumStepFraction));
});

test("confirmation retracement starts only after a touched candle has closed", () => {
  const candles = makeTrend("long");
  const immediate = simulateExchangeStyleDirectionalMartingaleV2("BTCUSDT", candles, {
    forwardStart: candles[0].time,
    config: { ...baseConfig, id: "immediate", reentryPolicy: "cooldown_4h" },
  });
  const retracement = simulateExchangeStyleDirectionalMartingaleV2("BTCUSDT", candles, {
    forwardStart: candles[0].time,
    config: {
      ...baseConfig,
      id: "retracement",
      reentryPolicy: "cooldown_4h",
      entryPolicy: "confirmation_retracement",
      entryRetracementStepMultiple: 0.5,
    },
  });

  assert.ok(immediate.completed.length > 0);
  assert.ok(retracement.completed.length > 0);
  assert.ok(retracement.completed[0].entryTime > immediate.completed[0].entryTime);
  assert.ok(retracement.completed.every((cycle) => cycle.entryTime >= cycle.signalTime + 600));
});

function makeTrend(side: "long" | "short"): Candle[] {
  const start = 1_700_000_000 - (1_700_000_000 % 300);
  const sign = side === "long" ? 1 : -1;
  return Array.from({ length: 8_000 }, (_, index) => {
    const price = 60_000 + sign * index * 0.8 + 600 * Math.sin(index * 2 * Math.PI / 576);
    return {
      symbol: "BTCUSDT",
      interval: "5m",
      time: start + index * 300,
      open: price,
      high: price + 30,
      low: price - 30,
      close: price,
      volume: 10,
    };
  });
}
