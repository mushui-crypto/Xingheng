import { defaultMarketSymbols, isSupportedCryptoSymbol, supportedCryptoSymbols } from "../../config/supportedSymbols";
import type { CandleInterval } from "../../types";

export const supportedIntervals: CandleInterval[] = ["1m", "5m", "15m", "1h"];
export const realtimeInterval: CandleInterval = "1m";

export { defaultMarketSymbols, isSupportedCryptoSymbol, supportedCryptoSymbols };

export function normalizeSymbol(value: string) {
  const symbol = value.toUpperCase();
  if (!isSupportedCryptoSymbol(symbol)) {
    throw new Error(`unsupported symbol: ${symbol}. supported symbols: ${supportedCryptoSymbols.join(", ")}`);
  }
  return symbol;
}

export function normalizeInterval(value: string): CandleInterval {
  if (!supportedIntervals.includes(value as CandleInterval)) {
    throw new Error(`unsupported interval: ${value}. supported intervals: ${supportedIntervals.join(", ")}`);
  }
  return value as CandleInterval;
}

export function normalizeLimit(value: unknown) {
  const limit = Number(value ?? 500);
  return Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 1000) : 500;
}
