import type { Candle, CandleInterval } from "../../types";
import { normalizeInterval, normalizeLimit, normalizeSymbol } from "./marketConfig";

const binanceRestBaseUrl = "https://api.binance.com";

type BinanceKlineRow = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

export class BinanceRestClient {
  constructor(private baseUrl = binanceRestBaseUrl) {}

  async getKlines(symbol: string, interval: CandleInterval, limit: number): Promise<Candle[]> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedInterval = normalizeInterval(interval);
    const normalizedLimit = normalizeLimit(limit);
    const url = new URL("/api/v3/klines", this.baseUrl);
    url.searchParams.set("symbol", normalizedSymbol);
    url.searchParams.set("interval", normalizedInterval);
    url.searchParams.set("limit", String(normalizedLimit));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance REST klines failed: ${response.status} ${response.statusText}`);
    }

    const rows = (await response.json()) as BinanceKlineRow[];
    return rows.map((row) => normalizeCandle({
      symbol: normalizedSymbol,
      interval: normalizedInterval,
      time: Math.floor(row[0] / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
  }
}

function normalizeCandle(candle: Candle): Candle {
  return {
    ...candle,
    high: Math.max(candle.high, candle.open, candle.close),
    low: Math.min(candle.low, candle.open, candle.close),
  };
}
