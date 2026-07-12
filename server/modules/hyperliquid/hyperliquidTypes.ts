import type { CandleInterval } from "../../types";
import type { HyperliquidRealTradingNetwork } from "./hyperliquidConfig";

export type RealTradingSymbol = {
  symbol: string;
  providerCoin: string;
  assetId: number;
  szDecimals: number;
  pxDecimals: number;
  maxLeverage: number;
  status: "active" | "delisted";
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingMarketSummary = {
  symbol: string;
  providerCoin: string;
  markPrice: number | null;
  oraclePrice: number | null;
  midPrice: number | null;
  dayNotionalVolume: number | null;
  openInterest: number | null;
  funding: number | null;
  nextFundingTime: number | null;
  status: "connected" | "unavailable";
  timestamp: number;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingOrderbookLevel = {
  price: number;
  size: number;
  cumulativeSize: number;
  orderCount: number | null;
};

export type RealTradingOrderbook = {
  symbol: string;
  providerCoin: string;
  bids: RealTradingOrderbookLevel[];
  asks: RealTradingOrderbookLevel[];
  timestamp: number;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingTrade = {
  symbol: string;
  providerCoin: string;
  price: number;
  size: number;
  side: "buy" | "sell" | "unknown";
  timestamp: number;
  tradeId?: string | null;
  txHash?: string | null;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingCandle = {
  symbol: string;
  providerCoin: string;
  interval: CandleInterval;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingAccountSummary = {
  address: string;
  accountValue: number | null;
  withdrawable: number | null;
  usedMargin: number | null;
  availableMargin: number | null;
  totalUnrealizedPnl: number | null;
  crossAccountValue: number | null;
  isolatedAccountValue: number | null;
  timestamp: number;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingPosition = {
  coin: string;
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number | null;
  markPrice: number | null;
  liquidationPrice: number | null;
  margin: number | null;
  leverage: number | null;
  unrealizedPnl: number | null;
  rawStatus?: string | null;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingExchangeRequest = {
  masterAddress: string;
  network: HyperliquidRealTradingNetwork;
  action: Record<string, unknown>;
  nonce: number;
  signature: unknown;
  vaultAddress?: string | null;
  expiresAfter?: number | null;
};
