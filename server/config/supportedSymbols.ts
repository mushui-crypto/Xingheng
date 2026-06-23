import type { MarketSymbol } from "../types";

export const supportedCryptoSymbols = ["BTCUSDT"] as const;

export type SupportedCryptoSymbol = (typeof supportedCryptoSymbols)[number];

export const defaultMarketSymbols: MarketSymbol[] = [
  {
    symbol: "BTCUSDT",
    displayName: "PERP BTC/USDT",
    apiSymbol: "BTCUSDT",
    category: "crypto",
    digits: 2,
    spread: 10,
    leverage: 20,
    contractSize: 1,
    minLot: 0.001,
    maxLot: 10,
    lotStep: 0.001,
    tradeStatus: "enabled",
    isVisible: true,
  },
];

export function isSupportedCryptoSymbol(symbol: string): symbol is SupportedCryptoSymbol {
  return supportedCryptoSymbols.includes(symbol.toUpperCase() as SupportedCryptoSymbol);
}
