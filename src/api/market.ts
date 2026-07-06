import type { CandleInterval, MarketStatus, TradeSide } from "../types";
import type { QuoteStatus, TradeSymbol } from "../types/market";
import { adminHeaders, requestJson, userHeaders } from "./httpClient";

export type ApiCandle = {
  symbol: string;
  interval: CandleInterval;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ApiTicker = {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  spread?: number;
  source?: string;
  timestamp?: number;
  status: MarketStatus;
};

export type PositionView = {
  id: string;
  userId: string;
  accountId: string;
  simulationAccountId: string;
  symbol: string;
  side: "long" | "short";
  volume: number;
  entryPrice: number;
  margin: number;
  openedAt: number;
  source: string;
  quoteTime: number;
  entryBid: number;
  entryAsk: number;
  entrySpread: number;
  markPrice: number | null;
  pnl: number | null;
};

export type TradingAccount = {
  id: string;
  userId: string;
  simulationAccountId?: string;
  asset: "USDT";
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  floatingPnl: number;
  createdAt: number;
  updatedAt: number;
};

export type OrderRecord = {
  id: string;
  userId: string;
  accountId: string;
  simulationAccountId: string;
  positionId?: string;
  symbol: string;
  side: TradeSide;
  positionSide: "long" | "short";
  orderType: "Market";
  action: "open" | "close";
  status: "filled" | "rejected";
  volume: number;
  price: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  source: string;
  quoteTime: number | null;
  simulated: true;
  reason?: string | null;
  pnl?: number | null;
  createdAt: number;
};

export type BalanceAdjustment = {
  id: string;
  accountId: string;
  userId: string;
  type: "deposit" | "withdraw" | "reset";
  amount: number;
  previousBalance: number;
  nextBalance: number;
  note?: string;
  createdAt: number;
};

export type AdminMarketStatus = {
  symbol: string;
  apiSymbol: string;
  displayName: string;
  tradeStatus: string;
  status: MarketStatus;
  ticker: ApiTicker | null;
};

type ApiMarketSymbol = Omit<TradeSymbol, "id" | "quoteStatus" | "createdAt" | "updatedAt"> & {
  status?: MarketStatus;
};

export async function syncMarketSymbols(symbols: TradeSymbol[]) {
  return requestJson<ApiMarketSymbol[]>("/api/admin/market/symbols/config", "品种配置保存失败。", {
    init: {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols }),
    },
  }).then((payload) => {
    const now = new Date().toISOString();
    return payload.map((symbol) => ({
      ...symbol,
      id: `SYM-${symbol.symbol}`,
      quoteStatus: toQuoteStatus(symbol.status),
      createdAt: now,
      updatedAt: now,
    })) satisfies TradeSymbol[];
  });
}

export async function fetchMarketSymbols() {
  const payload = await requestJson<ApiMarketSymbol[]>("/api/market/symbols", "品种列表加载失败。");
  const now = new Date().toISOString();
  return payload.map((symbol) => ({
    ...symbol,
    id: `SYM-${symbol.symbol}`,
    quoteStatus: toQuoteStatus(symbol.status),
    createdAt: now,
    updatedAt: now,
  })) satisfies TradeSymbol[];
}

export async function fetchTicker(symbol: string) {
  return requestJson<ApiTicker>(`/api/market/ticker?symbol=${symbol}`, "最新行情加载失败。");
}

export async function fetchCandles(symbol: string, interval: CandleInterval, limit = 500) {
  return requestJson<ApiCandle[]>(`/api/market/candles?symbol=${symbol}&interval=${interval}&limit=${limit}`, "K 线加载失败。");
}

function withSimulationAccount(path: string, simulationAccountId: string) {
  const params = new URLSearchParams({ simulationAccountId });
  return `${path}?${params.toString()}`;
}

export async function fetchTradingAccount(simulationAccountId: string) {
  return requestJson<TradingAccount>(withSimulationAccount("/api/trading/account", simulationAccountId), "账户加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchPositions(simulationAccountId: string) {
  return requestJson<PositionView[]>(withSimulationAccount("/api/trading/positions", simulationAccountId), "持仓加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchOrders(simulationAccountId: string) {
  return requestJson<OrderRecord[]>(withSimulationAccount("/api/trading/orders", simulationAccountId), "订单加载失败。", {
    init: { headers: userHeaders() },
    userAuthFailure: true,
  });
}

export async function placeMarketOrder(symbol: string, side: TradeSide, volume: number, simulationAccountId: string) {
  return requestJson<PositionView>("/api/trading/order", "市价单被拒绝。", {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...userHeaders() },
      body: JSON.stringify({ symbol, side, volume, simulationAccountId }),
    },
    userAuthFailure: true,
  });
}

export async function closePosition(positionId: string, simulationAccountId: string) {
  return requestJson<{ positionId: string; closePrice: number; pnl: number; account: TradingAccount }>(
    `/api/trading/positions/${positionId}/close`,
    "平仓被拒绝。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", ...userHeaders() },
        body: JSON.stringify({ simulationAccountId }),
      },
      userAuthFailure: true,
    },
  );
}

export async function fetchAdminAccounts() {
  return requestJson<TradingAccount[]>("/api/admin/accounts", "后台交易账户加载失败。", {
    init: { headers: adminHeaders() },
  });
}

export async function fetchAdminPositions() {
  return requestJson<PositionView[]>("/api/admin/positions", "后台持仓加载失败。", {
    init: { headers: adminHeaders() },
  });
}

export async function fetchAdminOrders() {
  return requestJson<OrderRecord[]>("/api/admin/orders", "后台订单加载失败。", {
    init: { headers: adminHeaders() },
  });
}

export async function fetchAdminBalanceAdjustments() {
  return requestJson<BalanceAdjustment[]>("/api/admin/balance-adjustments", "后台资金调整记录加载失败。", {
    init: { headers: adminHeaders() },
  });
}

export async function adjustAdminAccountBalance(userId: string, type: "deposit" | "withdraw" | "reset", amount: number, note = "") {
  return requestJson<TradingAccount>(`/api/admin/accounts/${userId}/adjust-balance`, "资金调整失败。", {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ type, amount, note }),
    },
  });
}

export async function fetchAdminMarketStatus() {
  return requestJson<AdminMarketStatus[]>("/api/admin/market/status", "后台行情状态加载失败。", {
    init: { headers: adminHeaders() },
  });
}

function toQuoteStatus(status?: MarketStatus): QuoteStatus {
  return status ?? "disconnected";
}
