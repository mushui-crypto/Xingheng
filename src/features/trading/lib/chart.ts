import type { CandlestickData } from "lightweight-charts";
import type { ApiCandle } from "../../../api/market";

export function toChartCandle(candle: ApiCandle): CandlestickData {
  return {
    time: candle.time as CandlestickData["time"],
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

export function normalizeChartCandles(candles: ApiCandle[]) {
  const byTime = new Map<number, ApiCandle>();
  for (const candle of candles) {
    if (isValidCandle(candle)) {
      byTime.set(candle.time, candle);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function isValidCandle(candle: ApiCandle) {
  return (
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close)
  );
}

export function getChartPriceFormat(digits: number) {
  const precision = Math.min(Math.max(Math.trunc(digits), 0), 8);
  return {
    type: "price" as const,
    precision,
    minMove: 10 ** -precision,
  };
}
