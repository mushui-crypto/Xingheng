import {
  getSupportedCryptoSymbols,
  getSupportedMarketSymbols,
  isSupportedCryptoSymbol,
  resolveSupportedSymbol,
  setSupportedMarketSymbols,
} from "../../config/supportedSymbols";
import type { CandleInterval } from "../../types";

export const supportedIntervals: CandleInterval[] = ["1m", "5m", "15m", "1h"];
export const realtimeInterval: CandleInterval = "1m";
export {
  getSupportedCryptoSymbols,
  getSupportedMarketSymbols,
  isSupportedCryptoSymbol,
  setSupportedMarketSymbols,
};

export function normalizeSymbol(value: string) {
  const symbol = resolveSupportedSymbol(value);
  if (!symbol) {
    throw new Error(`unsupported symbol: ${value}.`);
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

export function toHyperliquidCoin(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  return getSupportedMarketSymbols().find((item) => item.symbol === normalized)!.providerMarketId;
}

export function toHyperliquidDex(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  const config = getSupportedMarketSymbols().find((item) => item.symbol === normalized)!;
  return config.sourceType === "hip3" ? config.sourceDex : "";
}

export function getSupportedSourceDexs() {
  return [...new Set(getSupportedMarketSymbols().map((item) => item.sourceDex))];
}

export function intervalDurationMs(interval: CandleInterval) {
  const durationByInterval: Record<CandleInterval, number> = {
    "1m": 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "1h": 60 * 60_000,
  };
  return durationByInterval[interval];
}
