export type SymbolCategory = "crypto" | "metals" | "us_equities" | "indices" | "other";
export type MarketSourceType = "main" | "hip3";
export type TradeStatus = "enabled" | "close_only" | "disabled";
export type QuoteStatus = "connected" | "stale" | "disconnected";

export type TradeSymbol = {
  id: string;
  symbol: string;
  displayName: string;
  apiSymbol: string;
  providerMarketId: string;
  providerCoin: string;
  sourceDex: string;
  sourceType: MarketSourceType;
  category: SymbolCategory;
  digits: number;
  spread: number;
  leverage: number;
  contractSize: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  tradeStatus: TradeStatus;
  quoteStatus: QuoteStatus;
  isVisible: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Quote = {
  symbol: string;
  apiSymbol: string;
  last: number;
  bid: number;
  ask: number;
  spread: number;
  change: number;
  changePercent: number;
  high?: number;
  low?: number;
  open?: number;
  timestamp: number;
  localUpdatedAt: string;
  source: string;
  status: QuoteStatus;
};
