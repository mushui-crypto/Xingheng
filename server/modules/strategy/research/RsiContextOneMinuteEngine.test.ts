import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import {
  DEFAULT_RSI_CONTEXT_ASSUMPTIONS,
  RsiContextOneMinutePortfolio,
  type RsiContextEvent,
} from "./RsiContextOneMinuteEngine";

test("waits for a closed one-minute recovery candle and enters on the next open", () => {
  const engine = new RsiContextOneMinutePortfolio(
    { id: "test", stopAtrMultiple: 1, targetRMultiple: 1.5 },
    { ...DEFAULT_RSI_CONTEXT_ASSUMPTIONS, maxHoldingSeconds: 60 },
  );
  let time = 1_700_000_000;
  const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 105];
  const context: RsiContextEvent = {
    symbol: "BTCUSDT",
    type: "oversold",
    signalTime: time,
    trendRegime: "uptrend",
    session: "america_16_24_utc",
  };
  for (let index = 0; index < closes.length; index += 1) {
    engine.processMinute({ BTCUSDT: candle(time, closes[index]) }, index === 0 ? [context] : [], "formation");
    time += 60;
  }
  const tradesBeforeNextOpen = engine.snapshot().trades;
  assert.equal(tradesBeforeNextOpen.length, 0);
  engine.processMinute({ BTCUSDT: candle(time, 105) }, [], "formation");
  const snapshot = engine.snapshot();
  assert.equal(snapshot.trades.length, 1);
  assert.ok(snapshot.trades[0].entryTime > context.signalTime);
  assert.equal(snapshot.trades[0].exitReason, "time");
});

test("uses the stop when a one-minute candle touches stop and target", () => {
  const engine = new RsiContextOneMinutePortfolio(
    { id: "collision", stopAtrMultiple: 1, targetRMultiple: 1.5 },
    { ...DEFAULT_RSI_CONTEXT_ASSUMPTIONS, maxHoldingSeconds: 3_600 },
  );
  let time = 1_700_100_000;
  const context: RsiContextEvent = {
    symbol: "BTCUSDT",
    type: "oversold",
    signalTime: time,
    trendRegime: "neutral",
    session: "america_16_24_utc",
  };
  const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 105];
  for (let index = 0; index < closes.length; index += 1) {
    engine.processMinute({ BTCUSDT: candle(time, closes[index]) }, index === 0 ? [context] : [], "formation");
    time += 60;
  }
  engine.processMinute({ BTCUSDT: { ...candle(time, 92), high: 110, low: 70 } }, [], "formation");
  const trade = engine.snapshot().trades[0];
  assert.ok(trade);
  assert.equal(trade.exitReason, "stop");
  assert.ok(trade.netPnl < 0);
});

function candle(time: number, close: number): Candle {
  return {
    symbol: "BTCUSDT",
    interval: "1m",
    time,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
  };
}
