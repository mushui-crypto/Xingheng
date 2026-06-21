import type { Candle, CandleInterval } from "../types";
import type { CandleStore } from "./CandleStore";

const maxCandlesPerSeries = 5_000;

export class InMemoryCandleStore implements CandleStore {
  private current = new Map<string, Candle>();
  private history = new Map<string, Candle[]>();

  async init() {
    return;
  }

  async saveCurrent(candle: Candle) {
    this.current.set(this.key(candle.symbol, candle.interval), candle);
  }

  async getCurrent(symbol: string, interval: CandleInterval) {
    return this.current.get(this.key(symbol, interval)) ?? null;
  }

  async saveClosed(candle: Candle) {
    const key = this.key(candle.symbol, candle.interval);
    const candles = this.history.get(key) ?? [];
    const index = candles.findIndex((item) => item.time === candle.time);

    if (index >= 0) {
      candles[index] = candle;
    } else {
      candles.push(candle);
    }

    candles.sort((a, b) => a.time - b.time);
    this.history.set(key, candles.slice(-maxCandlesPerSeries));
  }

  async getHistory(symbol: string, interval: CandleInterval, limit: number) {
    return [...(this.history.get(this.key(symbol, interval)) ?? [])].sort((a, b) => a.time - b.time).slice(-limit);
  }

  private key(symbol: string, interval: CandleInterval) {
    return `${symbol.toUpperCase()}:${interval}`;
  }
}
