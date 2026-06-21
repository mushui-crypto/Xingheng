import type { Candle, CandleInterval } from "../types";

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

  async getHistoricalKlines(symbol: string, interval: CandleInterval = "1m", limit = 500): Promise<Candle[]> {
    const normalizedSymbol = symbol.toUpperCase();
    const normalizedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    const url = new URL("/api/v3/klines", this.baseUrl);
    url.searchParams.set("symbol", normalizedSymbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(normalizedLimit));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance REST klines failed: ${response.status} ${response.statusText}`);
    }

    const rows = (await response.json()) as BinanceKlineRow[];
    return rows.map((row) => ({
      symbol: normalizedSymbol,
      interval,
      time: Math.floor(row[0] / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
  }
}
