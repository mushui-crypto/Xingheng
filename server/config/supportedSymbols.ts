import type { MarketSymbol } from "../types";

const legacyAliases = new Map<string, string>([["BTCUSDT", "BTCUSDT"]]);
let marketSymbols: MarketSymbol[] = [
  {
    symbol: "BTCUSDT",
    displayName: "BTC Perpetual",
    apiSymbol: "BTC",
    providerMarketId: "BTC",
    providerCoin: "BTC",
    sourceDex: "main",
    sourceType: "main",
    category: "crypto",
    digits: 0,
    spread: 1,
    leverage: 40,
    contractSize: 1,
    minLot: 0.00001,
    maxLot: 10,
    lotStep: 0.00001,
    tradeStatus: "enabled",
    isVisible: true,
  },
];

export function setSupportedMarketSymbols(symbols: MarketSymbol[]) {
  marketSymbols = symbols.map((symbol) => ({ ...symbol }));
  const providerCoinCounts = new Map<string, number>();
  for (const symbol of marketSymbols) {
    const providerCoin = symbol.providerCoin.toUpperCase();
    providerCoinCounts.set(providerCoin, (providerCoinCounts.get(providerCoin) ?? 0) + 1);
  }
  for (const symbol of marketSymbols) {
    legacyAliases.set(symbol.symbol.toUpperCase(), symbol.symbol);
    legacyAliases.set(symbol.apiSymbol.toUpperCase(), symbol.symbol);
    legacyAliases.set(symbol.providerMarketId.toUpperCase(), symbol.symbol);
    if (providerCoinCounts.get(symbol.providerCoin.toUpperCase()) === 1) {
      legacyAliases.set(symbol.providerCoin.toUpperCase(), symbol.symbol);
    }
  }
}

export function getSupportedMarketSymbols() {
  return marketSymbols.map((symbol) => ({ ...symbol }));
}

export function getSupportedCryptoSymbols() {
  return marketSymbols.map((symbol) => symbol.symbol);
}

export function resolveSupportedSymbol(value: string) {
  const normalized = value.trim().toUpperCase();
  const configuredSymbol = marketSymbols.find(
    (symbol) =>
      symbol.symbol.toUpperCase() === normalized ||
      symbol.apiSymbol.toUpperCase() === normalized ||
      symbol.providerMarketId.toUpperCase() === normalized,
  );
  return configuredSymbol?.symbol ?? legacyAliases.get(normalized) ?? null;
}

export function isSupportedCryptoSymbol(symbol: string) {
  return resolveSupportedSymbol(symbol) !== null;
}
