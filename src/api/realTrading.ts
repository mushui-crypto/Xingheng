import type { CandleInterval } from "../types";
import { requestJson, userHeaders } from "./httpClient";

export type RealTradingNetwork = "hyperliquid-testnet";

export type RealTradingSymbol = {
  symbol: string;
  providerCoin: string;
  assetId?: number;
  szDecimals?: number;
  pxDecimals?: number;
  maxLeverage?: number;
  status?: string;
  network?: RealTradingNetwork;
};

export type RealMarketSummary = {
  symbol: string;
  markPrice?: number | null;
  oraclePrice?: number | null;
  midPrice?: number | null;
  dayNotionalVolume?: number | null;
  openInterest?: number | null;
  funding?: number | null;
  nextFundingTime?: number | null;
  status?: string;
  timestamp?: number;
};

export type RealOrderbookLevel = {
  price: number;
  size: number;
  total?: number;
};

export type RealOrderbook = {
  symbol: string;
  asks: RealOrderbookLevel[];
  bids: RealOrderbookLevel[];
  timestamp?: number;
};

export type RealTrade = {
  price: number;
  size: number;
  side: "buy" | "sell" | string;
  timestamp: number;
  tradeId?: string;
  txHash?: string;
};

export type RealCandle = {
  symbol: string;
  interval: CandleInterval;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type RealAccountSummary = {
  address: string;
  accountValue?: number | null;
  availableMargin?: number | null;
  usedMargin?: number | null;
  totalUnrealizedPnl?: number | null;
  cross?: unknown;
  isolated?: unknown;
};

export type RealPosition = {
  coin: string;
  side: "long" | "short" | string;
  size: number;
  entryPx?: number | null;
  markPx?: number | null;
  liqPx?: number | null;
  margin?: number | null;
  leverage?: number | null;
  unrealizedPnl?: number | null;
};

export type RealOpenOrder = {
  id?: string;
  oid?: number | string;
  coin?: string;
  side?: string;
  price?: number | null;
  size?: number | null;
  status?: string;
  timestamp?: number;
};

export type RealHistoricalOrder = RealOpenOrder & {
  order?: RealOpenOrder & {
    limitPx?: number | string | null;
    sz?: number | string | null;
  };
  statusTimestamp?: number;
};

export type RealFill = {
  coin?: string;
  side?: string;
  px?: number | string | null;
  sz?: number | string | null;
  time?: number;
  oid?: number | string;
  tid?: number | string;
  closedPnl?: number | string | null;
};

export type RealOrderHistory = {
  orders: RealHistoricalOrder[];
  fills: RealFill[];
  nextCursor: string | null;
  warnings: string[];
};

export type SignedRealTradingExchangePayload = {
  network: RealTradingNetwork;
  masterAddress: string;
  action: Record<string, unknown>;
  nonce: number;
  signature: unknown;
  vaultAddress?: string | null;
  expiresAfter?: number | null;
};

export type RealTradingExchangeResponse = {
  ok: boolean;
  network: RealTradingNetwork;
  result?: unknown;
  message?: string;
  status?: number;
  timestamp: number;
};

const realTradingHeaders = () => userHeaders();

export async function fetchRealTradingSymbols() {
  return requestJson<RealTradingSymbol[]>("/api/real-trading/market/symbols", "真实交易品种加载失败。", {
    init: { headers: realTradingHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchRealMarketSummary(symbol: string) {
  return requestJson<RealMarketSummary>(`/api/real-trading/market/summary?symbol=${encodeURIComponent(symbol)}`, "真实行情摘要加载失败。", {
    init: { headers: realTradingHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchRealOrderbook(symbol: string) {
  return requestJson<RealOrderbook>(`/api/real-trading/market/orderbook?symbol=${encodeURIComponent(symbol)}`, "真实盘口加载失败。", {
    init: { headers: realTradingHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchRealTrades(symbol: string) {
  return requestJson<RealTrade[]>(`/api/real-trading/market/trades?symbol=${encodeURIComponent(symbol)}`, "真实成交加载失败。", {
    init: { headers: realTradingHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchRealCandles(symbol: string, interval: CandleInterval, limit = 500) {
  return requestJson<RealCandle[]>(
    `/api/real-trading/market/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
    "真实 K 线加载失败。",
    {
      init: { headers: realTradingHeaders() },
      userAuthFailure: true,
    },
  );
}

export async function fetchRealAccountSummary(address: string) {
  return requestJson<RealAccountSummary>(`/api/real-trading/account/summary?address=${encodeURIComponent(address)}`, "真实账户加载失败。", {
    init: { headers: realTradingHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchRealPositions(address: string) {
  return requestJson<RealPosition[]>(`/api/real-trading/positions?address=${encodeURIComponent(address)}`, "真实持仓加载失败。", {
    init: { headers: realTradingHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchRealOpenOrders(address: string) {
  return requestJson<RealOpenOrder[]>(`/api/real-trading/orders/open?address=${encodeURIComponent(address)}`, "真实当前委托加载失败。", {
    init: { headers: realTradingHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchRealOrderHistory(address: string) {
  return requestJson<RealOrderHistory>(`/api/real-trading/orders/history?address=${encodeURIComponent(address)}`, "真实历史订单加载失败。", {
    init: { headers: realTradingHeaders() },
    userAuthFailure: true,
  });
}

export async function forwardSignedRealTradingExchange(payload: SignedRealTradingExchangePayload) {
  return requestJson<RealTradingExchangeResponse>("/api/real-trading/exchange", "真实交易请求发送失败。", {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...realTradingHeaders() },
      body: JSON.stringify(payload),
    },
    userAuthFailure: true,
  });
}
