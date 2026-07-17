import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { TrendPullbackOneMinutePortfolio } from "./TrendPullbackOneMinuteEngine";

test("uses pre-2021 candles for indicator warmup without opening trades", () => {
  const config = { id: "warmup", stopAtrMultiple: 1, targetRMultiple: 2 };
  const warmupOnly = new TrendPullbackOneMinutePortfolio(config);
  const enabled = new TrendPullbackOneMinutePortfolio(config);
  const start = Date.parse("2020-12-01T08:00:00Z") / 1000;
  for (let index = 0; index < 2_000; index += 1) {
    const time = start + index * 60;
    const baseline = 100 + index * 0.02;
    const phase = index % 20;
    const close = baseline + (phase === 15 ? -1.2 : phase === 16 ? -0.8 : phase === 17 ? -0.2 : 0);
    const item = candle(time, close);
    warmupOnly.processMinute({ BTCUSDT: item }, null);
    enabled.processMinute({ BTCUSDT: item }, "formation_2021_2023");
  }
  assert.equal(warmupOnly.snapshot().trades.length, 0);
  assert.equal(warmupOnly.snapshot().diagnostics.entries, 0);
  assert.ok(enabled.snapshot().diagnostics.entries > 0, JSON.stringify(enabled.snapshot().diagnostics));
});

function candle(time: number, close: number): Candle {
  return {
    symbol: "BTCUSDT",
    interval: "1m",
    time,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1,
  };
}
