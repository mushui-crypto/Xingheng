import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { StructureBreakoutOneMinutePortfolio } from "./StructureBreakoutOneMinuteEngine";

test("warms higher-timeframe structure without trading and fills a retest only on the next minute", () => {
  const config = { id: "causal", stopAtrMultiple: 1.5, targetRMultiple: 2 };
  const warmup = new StructureBreakoutOneMinutePortfolio(config);
  const enabled = new StructureBreakoutOneMinutePortfolio(config);
  const start = Date.parse("2020-12-01T08:00:00Z") / 1000;
  for (let index = 0; index < 4_000; index += 1) {
    const time = start + index * 60;
    const close = 100 + index * 0.2;
    const item = candle(time, close);
    warmup.processMinute({ BTCUSDT: item }, null);
    enabled.processMinute({ BTCUSDT: item }, "formation_2021_2023");
  }
  const warmupSnapshot = warmup.snapshot();
  const enabledSnapshot = enabled.snapshot();
  assert.equal(warmupSnapshot.trades.length, 0);
  assert.equal(warmupSnapshot.diagnostics.entries, 0);
  assert.ok(enabledSnapshot.diagnostics.entries > 0, JSON.stringify(enabledSnapshot.diagnostics));
  assert.ok(enabledSnapshot.trades.every((trade) => trade.entryTime === trade.contextSignalTime));
});

function candle(time: number, close: number): Candle {
  return {
    symbol: "BTCUSDT",
    interval: "1m",
    time,
    open: close - 0.5,
    high: close + 0.05,
    low: close - 3,
    close,
    volume: 1,
  };
}
