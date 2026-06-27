import type { CandleInterval, MarketStatus, TradeSide } from "../types";
import type { QuoteStatus, TradeSymbol } from "../types/market";
import { readStorage, storageKeys } from "../utils/storage";

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

function userHeaders(userId?: string | null): Record<string, string> {
  const auth = readStorage<{ isLoggedIn?: boolean; userToken?: string | null }>(storageKeys.auth, {});
  return auth.userToken ? { Authorization: `Bearer ${auth.userToken}` } : {};
}

function adminHeaders(): Record<string, string> {
  const auth = readStorage<{ isAdminLoggedIn?: boolean; adminToken?: string | null }>(storageKeys.adminAuth, {});
  return auth.adminToken ? { Authorization: `Bearer ${auth.adminToken}` } : {};
}

export async function syncMarketSymbols(symbols: TradeSymbol[]) {
  const response = await fetch("/api/market/symbols/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols }),
  });

  if (!response.ok) {
    return fetchMarketSymbols();
  }

  return response.json();
}

export async function fetchMarketSymbols() {
  const response = await fetch("/api/market/symbols");
  if (!response.ok) {
    throw new Error("品种列表加载失败。");
  }

  const payload = (await response.json()) as ApiMarketSymbol[];
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
  const response = await fetch(`/api/market/ticker?symbol=${symbol}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message ?? "最新行情加载失败。");
  }
  return response.json() as Promise<ApiTicker>;
}

export async function fetchCandles(symbol: string, interval: CandleInterval, limit = 500) {
  const response = await fetch(`/api/market/candles?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message ?? "K 线加载失败。");
  }
  return response.json() as Promise<ApiCandle[]>;
}

export async function fetchTradingAccount() {
  const response = await fetch("/api/trading/account", { headers: userHeaders() });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message ?? "账户加载失败。");
  }
  return response.json() as Promise<TradingAccount>;
}

export async function fetchPositions() {
  const response = await fetch("/api/trading/positions", { headers: userHeaders() });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message ?? "持仓加载失败。");
  }
  return response.json() as Promise<PositionView[]>;
}

export async function fetchOrders() {
  const response = await fetch("/api/trading/orders", { headers: userHeaders() });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message ?? "订单加载失败。");
  }
  return response.json() as Promise<OrderRecord[]>;
}

export async function placeMarketOrder(symbol: string, side: TradeSide, volume: number) {
  const response = await fetch("/api/trading/order", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify({ symbol, side, volume }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message ?? "市价单被拒绝。");
  }
  return payload as PositionView;
}

export async function closePosition(positionId: string) {
  const response = await fetch(`/api/trading/positions/${positionId}/close`, {
    method: "POST",
    headers: userHeaders(),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message ?? "平仓被拒绝。");
  }
  return payload as { positionId: string; closePrice: number; pnl: number; account: TradingAccount };
}

export async function fetchAdminAccounts() {
  const response = await fetch("/api/admin/accounts", { headers: adminHeaders() });
  return response.json() as Promise<TradingAccount[]>;
}

export async function fetchAdminPositions() {
  const response = await fetch("/api/admin/positions", { headers: adminHeaders() });
  return response.json() as Promise<PositionView[]>;
}

export async function fetchAdminOrders() {
  const response = await fetch("/api/admin/orders", { headers: adminHeaders() });
  return response.json() as Promise<OrderRecord[]>;
}

export async function fetchAdminBalanceAdjustments() {
  const response = await fetch("/api/admin/balance-adjustments", { headers: adminHeaders() });
  return response.json() as Promise<BalanceAdjustment[]>;
}

export async function adjustAdminAccountBalance(userId: string, type: "deposit" | "withdraw" | "reset", amount: number, note = "") {
  const response = await fetch(`/api/admin/accounts/${userId}/adjust-balance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ type, amount, note }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message ?? "资金调整失败。");
  }
  return payload as TradingAccount;
}

export async function fetchAdminMarketStatus() {
  const response = await fetch("/api/admin/market/status", { headers: adminHeaders() });
  return response.json() as Promise<AdminMarketStatus[]>;
}

function toQuoteStatus(status?: MarketStatus): QuoteStatus {
  if (status === "connected") {
    return "normal";
  }
  if (status === "disconnected") {
    return "error";
  }
  return "stale";
}
