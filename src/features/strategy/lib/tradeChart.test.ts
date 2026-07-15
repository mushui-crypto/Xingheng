import assert from "node:assert/strict";
import test from "node:test";
import type { StrategyForwardTrade } from "../model/types";
import {
  bucketStrategyTradeTime,
  buildStrategyTradeMarkerEvents,
  calculateStrategyCandleWindow,
  strategyIntervalSeconds,
} from "./tradeChart";

test("assigns execution time to the containing interval bucket", () => {
  assert.equal(
    bucketStrategyTradeTime("2026-07-15T12:07:59.000Z", "5m"),
    Date.parse("2026-07-15T12:05:00.000Z") / 1000,
  );
  assert.equal(
    bucketStrategyTradeTime("2026-07-15T12:59:59.000Z", "1h"),
    Date.parse("2026-07-15T12:00:00.000Z") / 1000,
  );
});

test("builds long and short entry/exit markers from actual execution fields", () => {
  const long = makeTrade("long", "2026-07-15T12:06:00.000Z", "2026-07-15T12:14:00.000Z", 100, 105);
  const short = makeTrade("short", "2026-07-15T12:07:00.000Z", "2026-07-15T12:13:00.000Z", 110, 103);
  const events = buildStrategyTradeMarkerEvents([short, long], "5m");

  assert.deepEqual(events.map((event) => [event.label, event.position, event.shape, event.price]), [
    ["多开", "belowBar", "arrowUp", 100],
    ["空开", "aboveBar", "arrowDown", 110],
    ["平空", "belowBar", "square", 103],
    ["平多", "aboveBar", "square", 105],
  ]);
});

test("keeps multiple events in one candle in stable order", () => {
  const first = makeTrade("long", "2026-07-15T12:06:00.000Z", null, 100, null);
  const second = makeTrade("long", "2026-07-15T12:07:00.000Z", null, 101, null);
  const events = buildStrategyTradeMarkerEvents([second, first], "5m");

  assert.equal(events.length, 2);
  assert.equal(events[0].price, 100);
  assert.equal(events[1].price, 101);
  assert.equal(events[0].bucketTime, events[1].bucketTime);
});

test("does not invent an exit marker for an open position", () => {
  const events = buildStrategyTradeMarkerEvents([
    makeTrade("short", "2026-07-15T12:07:00.000Z", null, 110, null),
  ], "5m");
  assert.deepEqual(events.map((event) => event.kind), ["entry"]);
});

test("calculates a bounded request window centered near the selected entry", () => {
  const window = calculateStrategyCandleWindow("2026-07-15T12:07:00.000Z", "5m", 300);
  const span = (Date.parse(window.to) - Date.parse(window.from)) / 1000;
  assert.equal(window.focusBucketTime, Date.parse("2026-07-15T12:05:00.000Z") / 1000);
  assert.equal(span, strategyIntervalSeconds("5m") * 299);
  assert.equal(window.limit, 300);
});

function makeTrade(
  side: "long" | "short",
  entryTime: string,
  exitTime: string | null,
  entryPrice: number,
  exitPrice: number | null,
): StrategyForwardTrade {
  return {
    side,
    signalTime: entryTime,
    entryTime,
    exitTime,
    entryPrice,
    exitPrice,
    stopPrice: 90,
    targetPrice: 120,
    quantity: 1,
    fees: exitTime ? 1 : 0,
    netPnl: exitTime ? 5 : null,
    rMultiple: exitTime ? 0.5 : null,
    exitReason: exitTime ? "target" : null,
  };
}
