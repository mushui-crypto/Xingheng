import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../../../types";
import {
  buildConfirmedStructureContexts,
  ethSmcIctConfluenceV1Config,
  selectFibFvgOrderBlockSetup,
} from "./EthSmcIctConfluenceStrategy";

const baseTime = Date.parse("2024-01-02T12:00:00Z") / 1000;

function candle(
  index: number,
  values: Pick<Candle, "open" | "high" | "low" | "close">,
  interval: Candle["interval"] = "5m",
): Candle {
  return {
    symbol: "ETHUSDT",
    interval,
    time: baseTime + index * (interval === "15m" ? 900 : 300),
    volume: 100,
    ...values,
  };
}

const setupConfig = {
  fvgLookbackBars: ethSmcIctConfluenceV1Config.fvgLookbackBars,
  fvgMinAtr: ethSmcIctConfluenceV1Config.fvgMinAtr,
  fvgMaxAtr: ethSmcIctConfluenceV1Config.fvgMaxAtr,
  orderBlockLookbackBars: ethSmcIctConfluenceV1Config.orderBlockLookbackBars,
  orderBlockProximityAtr: ethSmcIctConfluenceV1Config.orderBlockProximityAtr,
};

test("15m swing enters structure context only after its right-side confirmation candle closes", () => {
  const candles: Candle[] = [
    candle(0, { open: 7, high: 9, low: 5, close: 7 }, "15m"),
    candle(1, { open: 7, high: 10, low: 4, close: 8 }, "15m"),
    candle(2, { open: 8, high: 11, low: 5, close: 10 }, "15m"),
    candle(3, { open: 10, high: 15, low: 6, close: 12 }, "15m"),
    candle(4, { open: 12, high: 12, low: 7, close: 9 }, "15m"),
  ];

  const contexts = buildConfirmedStructureContexts(candles, 1, 1);

  assert.equal(contexts.get(candles[3].time)?.bullish, null);
  const confirmed = contexts.get(candles[4].time)?.bullish;
  assert.ok(confirmed);
  assert.equal(confirmed.breakLevel.index, 3);
  assert.equal(confirmed.breakLevel.confirmedAtIndex, 4);
  assert.equal(confirmed.impulseOrigin.index, 1);
});

test("long setup accepts a discount FVG midpoint near the preceding bearish order block", () => {
  const candles = validLongSetupCandles();
  const result = selectFibFvgOrderBlockSetup({
    candles,
    index: 5,
    side: "long",
    impulseOrigin: {
      index: -1,
      time: baseTime - 300,
      price: 100,
      kind: "low",
      confirmedAtIndex: -1,
    },
    impulseExtreme: 130,
    atr: 2,
    config: setupConfig,
  });

  assert.ok(result);
  assert.equal(result.entryPrice, 111.5);
  assert.equal(result.equilibriumPrice, 115);
  assert.equal(result.fvg.index, 2);
  assert.equal(result.orderBlockIndex, 0);
  assert.equal(result.orderBlockDistanceAtr, 0.25);
});

test("long setup rejects an FVG midpoint already touched before the BOS candle", () => {
  const candles = validLongSetupCandles();
  candles[3] = candle(3, { open: 113, high: 114, low: 111.4, close: 113.5 });

  const result = selectFibFvgOrderBlockSetup({
    candles,
    index: 5,
    side: "long",
    impulseOrigin: {
      index: -1,
      time: baseTime - 300,
      price: 100,
      kind: "low",
      confirmedAtIndex: -1,
    },
    impulseExtreme: 130,
    atr: 2,
    config: setupConfig,
  });

  assert.equal(result, null);
});

test("long setup rejects an FVG midpoint above Fibonacci equilibrium", () => {
  const candles = validLongSetupCandles();
  const result = selectFibFvgOrderBlockSetup({
    candles,
    index: 5,
    side: "long",
    impulseOrigin: {
      index: -1,
      time: baseTime - 300,
      price: 100,
      kind: "low",
      confirmedAtIndex: -1,
    },
    impulseExtreme: 120,
    atr: 2,
    config: setupConfig,
  });

  assert.equal(result, null);
});

function validLongSetupCandles(): Candle[] {
  return [
    candle(0, { open: 110, high: 111, low: 107, close: 108 }),
    candle(1, { open: 108, high: 115, low: 108, close: 114 }),
    candle(2, { open: 113, high: 116, low: 112, close: 115 }),
    candle(3, { open: 113, high: 116, low: 112, close: 115 }),
    candle(4, { open: 114, high: 116, low: 112, close: 115 }),
    candle(5, { open: 120, high: 130, low: 120, close: 129 }),
  ];
}

test("short setup accepts a premium FVG midpoint near the preceding bullish order block", () => {
  const candles: Candle[] = [
    candle(0, { open: 120, high: 123, low: 120, close: 122 }),
    candle(1, { open: 122, high: 122, low: 115, close: 116 }),
    candle(2, { open: 118, high: 119, low: 115, close: 116 }),
    candle(3, { open: 117, high: 119, low: 115, close: 116 }),
    candle(4, { open: 117, high: 119, low: 115, close: 116 }),
    candle(5, { open: 110, high: 110, low: 100, close: 101 }),
  ];
  const result = selectFibFvgOrderBlockSetup({
    candles,
    index: 5,
    side: "short",
    impulseOrigin: {
      index: -1,
      time: baseTime - 300,
      price: 130,
      kind: "high",
      confirmedAtIndex: -1,
    },
    impulseExtreme: 100,
    atr: 2,
    config: setupConfig,
  });

  assert.ok(result);
  assert.equal(result.entryPrice, 119.5);
  assert.equal(result.equilibriumPrice, 115);
  assert.equal(result.fvg.index, 2);
  assert.equal(result.orderBlockIndex, 0);
  assert.equal(result.orderBlockDistanceAtr, 0.25);
});
