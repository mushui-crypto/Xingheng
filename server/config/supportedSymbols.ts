import type { MarketSymbol } from "../types";

export const supportedCryptoSymbols = ["BTCUSDT", "ETHUSDT", "DOGEUSDT"] as const;

export type SupportedCryptoSymbol = (typeof supportedCryptoSymbols)[number];

export const defaultMarketSymbols: MarketSymbol[] = [
  {
    symbol: "BTCUSDT",
    displayName: "Bitcoin / USDT",
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
  {
    symbol: "ETHUSDT",
    displayName: "Ethereum / USDT",
    apiSymbol: "ETHUSDT",
    category: "crypto",
    digits: 2,
    spread: 1,
    leverage: 20,
    contractSize: 1,
    minLot: 0.001,
    maxLot: 100,
    lotStep: 0.001,
    tradeStatus: "enabled",
    isVisible: true,
  },
  {
    symbol: "DOGEUSDT",
    displayName: "Dogecoin / USDT",
    apiSymbol: "DOGEUSDT",
    category: "crypto",
    digits: 6,
    spread: 0.00001,
    leverage: 10,
    contractSize: 1,
    minLot: 1,
    maxLot: 100_000,
    lotStep: 1,
    tradeStatus: "enabled",
    isVisible: true,
  },
];

export function isSupportedCryptoSymbol(symbol: string): symbol is SupportedCryptoSymbol {
  return supportedCryptoSymbols.includes(symbol.toUpperCase() as SupportedCryptoSymbol);
}
