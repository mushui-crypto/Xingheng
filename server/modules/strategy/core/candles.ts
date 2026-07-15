import type { Candle, CandleInterval } from "../../../types";

const intervalMinutes: Partial<Record<CandleInterval, number>> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
};

export function aggregateCandles(candles: Candle[], interval: CandleInterval) {
  const minutes = intervalMinutes[interval];
  if (!minutes) throw new Error(`Strategy candle aggregation does not support ${interval}.`);
  const bucketSeconds = minutes * 60;
  const buckets = new Map<number, Candle>();
  for (const candle of candles) {
    const time = Math.floor(candle.time / bucketSeconds) * bucketSeconds;
    const existing = buckets.get(time);
    if (!existing) {
      buckets.set(time, { ...candle, interval, time });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
  }
  return [...buckets.values()].sort((left, right) => left.time - right.time);
}
