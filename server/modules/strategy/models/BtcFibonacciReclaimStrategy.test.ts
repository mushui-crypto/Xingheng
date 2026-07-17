import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import { BtcFibonacciReclaimStrategy, fibonacciPrices } from "./BtcFibonacciReclaimStrategy";

test("fibonacci prices mirror long and short retracements", () => {
  assert.deepEqual(fibonacciPrices({ side: "long", origin: 90, extreme: 110 }), {
    zoneStartPrice: 97.64,
    corePrice: 95.9,
    zoneEndPrice: 94.28,
  });
  assert.deepEqual(fibonacciPrices({ side: "short", origin: 110, extreme: 90 }), {
    zoneStartPrice: 102.36,
    corePrice: 104.1,
    zoneEndPrice: 105.72,
  });
});

test("confirmed 15m break plus 5m 0.705 reclaim emits one direct market signal", () => {
  const candles = fixtures();
  const strategy = new BtcFibonacciReclaimStrategy();
  strategy.prepare(candles);
  const index = candles.length - 1;
  const signal = strategy.evaluate({ candles, index, equity: 10_000 });

  assert.ok(signal);
  assert.equal(signal.side, "long");
  assert.equal(signal.entryOrderType, "market");
  assert.equal(signal.targetRewardRisk, 2);
  assert.equal(strategy.evaluate({ candles, index, equity: 10_000 }), null);
});

function fixtures(): Candle[] {
  const bars: Array<[number, number, number, number]> = [];
  for (let index = 0; index < 10; index += 1) bars.push([100, 102, 98, 100]);
  bars.push(
    [100, 105, 99, 103],
    [103, 104, 97, 100],
    [100, 102, 90, 95],
    [95, 103, 96, 100],
    [100, 106, 98, 104],
    [104, 110, 100, 108],
    [108, 108, 101, 105],
    [105, 107, 99, 105],
    [105, 112, 104, 111],
  );
  const start = Date.parse("2026-01-05T05:15:00Z") / 1000;
  const candles: Candle[] = [];
  for (let bar = 0; bar < bars.length; bar += 1) {
    const [open, high, low, close] = bars[bar];
    for (let part = 0; part < 3; part += 1) candles.push({
      symbol: "BTCUSDT", interval: "5m", time: start + (bar * 3 + part) * 300,
      open, high, low, close, volume: 10,
    });
  }
  candles.push({
    symbol: "BTCUSDT", interval: "5m", time: start + bars.length * 900,
    open: 96.5, high: 99, low: 95, close: 98.5, volume: 20,
  });
  return candles;
}
