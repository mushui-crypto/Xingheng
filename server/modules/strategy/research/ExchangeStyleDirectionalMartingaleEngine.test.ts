import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import {
  EXCHANGE_MARTINGALE_CONFIG,
  simulateExchangeStyleDirectionalMartingale,
} from "./ExchangeStyleDirectionalMartingaleEngine";

test("exchange-style long martingale opens a base order and loops after cycle take profit", () => {
  const candles = makeTrend("long");
  const result = simulateExchangeStyleDirectionalMartingale("BTCUSDT", candles, { forwardStart: candles[0].time });

  assert.ok(result.diagnostics.longConfirmations > 0);
  assert.equal(result.diagnostics.shortConfirmations, 0);
  assert.ok(result.completed.length > 1);
  assert.ok(result.completed.every((cycle) => cycle.side === "long"));
  assert.ok(result.completed.every((cycle) => cycle.exitReason === "cycle_take_profit"));
  assert.ok(result.completed.every((cycle) => cycle.fills[0].level === 1));
  assert.ok(result.completed[0].plannedRisk <= EXCHANGE_MARTINGALE_CONFIG.initialEquity * EXCHANGE_MARTINGALE_CONFIG.maximumCycleLossFraction + 0.01);
});

test("exchange-style short martingale mirrors safety orders and has no holding timeout", () => {
  const candles = makeTrend("short");
  const result = simulateExchangeStyleDirectionalMartingale("BTCUSDT", candles, { forwardStart: candles[0].time });

  assert.ok(result.diagnostics.shortConfirmations > 0);
  assert.equal(result.diagnostics.longConfirmations, 0);
  assert.ok(result.completed.length > 1);
  assert.ok(result.completed.every((cycle) => cycle.side === "short"));
  assert.ok(result.completed.every((cycle) => cycle.exitReason === "cycle_take_profit"));
  assert.ok(result.completed.some((cycle) => cycle.fills.length > 1));
  for (const cycle of result.completed) {
    for (let index = 1; index < cycle.fills.length; index += 1) {
      assert.ok(cycle.fills[index].triggerPrice > cycle.fills[index - 1].triggerPrice);
      assert.ok(cycle.fills[index].notional > cycle.fills[index - 1].notional);
    }
  }
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
