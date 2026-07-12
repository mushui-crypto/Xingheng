export const hyperliquidTestnetNetwork = "hyperliquid-testnet" as const;
export const hyperliquidTestnetBaseUrl = "https://api.hyperliquid-testnet.xyz";

export type HyperliquidRealTradingNetwork = typeof hyperliquidTestnetNetwork;

export function getHyperliquidRealTradingConfig() {
  return {
    network: hyperliquidTestnetNetwork,
    baseUrl: hyperliquidTestnetBaseUrl,
  };
}
