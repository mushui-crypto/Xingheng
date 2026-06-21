import type { Candle, CandleInterval } from "../../types";

const maxCandlesPerSeries = 5_000;

export class KlineStore {
  private current = new Map<string, Candle>();
  private history = new Map<string, Candle[]>();

  upsertHistory(candle: Candle) {
    const key = this.key(candle.symbol, candle.interval);
    const candles = this.history.get(key) ?? [];
    const index = candles.findIndex((item) => item.time === candle.time);

    if (index >= 0) {
      candles[index] = this.normalizeCandle(candle);
    } else {
      candles.push(this.normalizeCandle(candle));
    }

    candles.sort((a, b) => a.time - b.time);
    this.history.set(key, candles.slice(-maxCandlesPerSeries));
  }

  updateCurrent(candle: Candle) {
    this.current.set(this.key(candle.symbol, candle.interval), this.normalizeCandle(candle));
  }

  closeCurrent(candle: Candle) {
    const normalized = this.normalizeCandle(candle);
    this.upsertHistory(normalized);
    this.current.set(this.key(normalized.symbol, normalized.interval), normalized);
  }

  getCandles(symbol: string, interval: CandleInterval, limit: number) {
    const key = this.key(symbol, interval);
    const history = this.history.get(key) ?? [];
    const current = this.current.get(key);
    const merged = current ? [...history.filter((item) => item.time !== current.time), current] : history;

    return merged.sort((a, b) => a.time - b.time).slice(-limit);
  }

  getCurrent(symbol: string, interval: CandleInterval) {
    return this.current.get(this.key(symbol, interval)) ?? null;
  }

  private normalizeCandle(candle: Candle): Candle {
    const high = Math.max(candle.high, candle.open, candle.close);
    const low = Math.min(candle.low, candle.open, candle.close);

    return {
      ...candle,
      symbol: candle.symbol.toUpperCase(),
      high,
      low,
    };
  }

  private key(symbol: string, interval: CandleInterval) {
    return `${symbol.toUpperCase()}:${interval}`;
  }
}
