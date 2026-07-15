import type { Candle } from "../../../types";

export type SwingPoint = {
  index: number;
  time: number;
  price: number;
  kind: "high" | "low";
  confirmedAtIndex: number;
};

export type FairValueGap = {
  index: number;
  lower: number;
  upper: number;
  midpoint: number;
  side: "bullish" | "bearish";
};

export function averageTrueRange(candles: Candle[], endIndex: number, period = 14) {
  if (endIndex < period) return null;
  let total = 0;
  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1]?.close ?? candle.open;
    total += Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  }
  return total / period;
}

export function exponentialMovingAverage(candles: Candle[], endIndex: number, period: number) {
  if (endIndex < period - 1) return null;
  const multiplier = 2 / (period + 1);
  let value = candles[endIndex - period + 1].close;
  for (let index = endIndex - period + 2; index <= endIndex; index += 1) {
    value = (candles[index].close - value) * multiplier + value;
  }
  return value;
}

export function confirmedSwings(
  candles: Candle[],
  availableAtIndex: number,
  leftBars = 2,
  rightBars = 2,
) {
  const swings: SwingPoint[] = [];
  const lastCandidate = availableAtIndex - rightBars;
  for (let index = leftBars; index <= lastCandidate; index += 1) {
    const candle = candles[index];
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= leftBars; offset += 1) {
      isHigh &&= candle.high > candles[index - offset].high;
      isLow &&= candle.low < candles[index - offset].low;
    }
    for (let offset = 1; offset <= rightBars; offset += 1) {
      isHigh &&= candle.high >= candles[index + offset].high;
      isLow &&= candle.low <= candles[index + offset].low;
    }
    if (isHigh) swings.push({ index, time: candle.time, price: candle.high, kind: "high", confirmedAtIndex: index + rightBars });
    if (isLow) swings.push({ index, time: candle.time, price: candle.low, kind: "low", confirmedAtIndex: index + rightBars });
  }
  return swings;
}

export function fairValueGap(candles: Candle[], index: number): FairValueGap | null {
  if (index < 2) return null;
  const first = candles[index - 2];
  const third = candles[index];
  if (third.low > first.high) {
    return {
      index,
      lower: first.high,
      upper: third.low,
      midpoint: (first.high + third.low) / 2,
      side: "bullish",
    };
  }
  if (third.high < first.low) {
    return {
      index,
      lower: third.high,
      upper: first.low,
      midpoint: (third.high + first.low) / 2,
      side: "bearish",
    };
  }
  return null;
}

export function isDisplacement(candle: Candle, atr: number, side: "bullish" | "bearish", bodyAtr = 0.8) {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  if (range <= 0 || body < atr * bodyAtr) return false;
  if (side === "bullish") {
    return candle.close > candle.open && (candle.high - candle.close) / range <= 0.25;
  }
  return candle.close < candle.open && (candle.close - candle.low) / range <= 0.25;
}
