import { EventEmitter } from "node:events";
import type { CandleStore } from "../storage/CandleStore";
import type { Candle, CandleInterval, MarketTick } from "../types";

export const intervals: CandleInterval[] = ["1m", "5m", "15m", "1h"];

const intervalSeconds: Record<CandleInterval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};

type CandleEvents = {
  candle: [Candle];
};

export class CandleAggregator extends EventEmitter<CandleEvents> {
  private current = new Map<string, Candle>();

  constructor(private store: CandleStore) {
    super();
  }

  async init() {
    await this.store.init();
  }

  async handleTick(tick: MarketTick) {
    await Promise.all(intervals.map((interval) => this.updateInterval(tick, interval)));
  }

  async getCandles(symbol: string, interval: CandleInterval, limit: number) {
    let history = await this.store.getHistory(symbol, interval, limit);
    const current = await this.getCurrent(symbol, interval);
    if (history.length === 0 && !current) {
      history = await this.seedHistory(symbol, interval, limit);
    }

    const combined = current ? [...history.filter((item) => item.time !== current.time), current] : history;
    return combined.sort((a, b) => a.time - b.time).slice(-limit);
  }

  async getCurrent(symbol: string, interval: CandleInterval) {
    const key = this.key(symbol, interval);
    return this.current.get(key) ?? (await this.store.getCurrent(symbol, interval));
  }

  private async updateInterval(tick: MarketTick, interval: CandleInterval) {
    const bucket = this.bucketTime(tick.timestamp, interval);
    const key = this.key(tick.symbol, interval);
    const previous = this.current.get(key) ?? (await this.store.getCurrent(tick.symbol, interval));

    if (!previous || previous.time !== bucket) {
      if (previous) {
        await this.store.saveClosed(previous);
      }
      const next: Candle = {
        symbol: tick.symbol,
        interval,
        time: bucket,
        open: tick.last,
        high: tick.last,
        low: tick.last,
        close: tick.last,
        volume: 1,
      };
      this.current.set(key, next);
      await this.store.saveCurrent(next);
      this.emit("candle", next);
      return;
    }

    const updated: Candle = {
      ...previous,
      high: Math.max(previous.high, tick.last),
      low: Math.min(previous.low, tick.last),
      close: tick.last,
      volume: previous.volume + 1,
    };
    this.current.set(key, updated);
    await this.store.saveCurrent(updated);
    this.emit("candle", updated);
  }

  private bucketTime(timestampMs: number, interval: CandleInterval) {
    const seconds = Math.floor(timestampMs / 1000);
    const size = intervalSeconds[interval];
    return Math.floor(seconds / size) * size;
  }

  private key(symbol: string, interval: CandleInterval) {
    return `${symbol}:${interval}`;
  }

  private async seedHistory(symbol: string, interval: CandleInterval, limit: number) {
    const size = intervalSeconds[interval];
    const now = Math.floor(Date.now() / 1000);
    const currentBucket = Math.floor(now / size) * size;
    const candles: Candle[] = [];
    let close = 2320;

    for (let index = limit; index > 0; index -= 1) {
      const time = currentBucket - index * size;
      const open = close;
      close = Number((open + (Math.random() - 0.48) * 2.4).toFixed(2));
      const high = Number((Math.max(open, close) + Math.random() * 1.2).toFixed(2));
      const low = Number((Math.min(open, close) - Math.random() * 1.2).toFixed(2));
      candles.push({
        symbol,
        interval,
        time,
        open: Number(open.toFixed(2)),
        high,
        low,
        close,
        volume: Math.floor(20 + Math.random() * 60),
      });
    }

    for (const candle of candles) {
      await this.store.saveClosed(candle);
    }

    return candles;
  }
}
