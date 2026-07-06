import type { CandleInterval, MarketStatus, TradeSide } from "../types";
import type { QuoteStatus, TradeSymbol } from "../types/market";
import { handleUserAuthFailure } from "./session";

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

function userHeaders(userId?: string | null): Record<string, string> {
  return {};
}

function adminHeaders(): Record<string, string> {
  return {};
}

async function readJson<T>(response: Response, fallbackMessage: string, options?: { userAuthFailure?: boolean }) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (options?.userAuthFailure && (response.status === 401 || response.status === 403)) {
      handleUserAuthFailure(payload?.message ?? "账号已禁用或登录已失效，请重新登录。");
    }
    throw new Error(payload?.message ?? fallbackMessage);
  }
  return payload as T;
}

export async function syncMarketSymbols(symbols: TradeSymbol[]) {
  const response = await fetch("/api/admin/market/symbols/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols }),
  });

  return readJson<ApiMarketSymbol[]>(response, "品种配置保存失败。").then((payload) => {
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
  const response = await fetch("/api/market/symbols");
  const payload = await readJson<ApiMarketSymbol[]>(response, "品种列表加载失败。");
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
  return readJson<ApiTicker>(response, "最新行情加载失败。");
}

export async function fetchCandles(symbol: string, interval: CandleInterval, limit = 500) {
  const response = await fetch(`/api/market/candles?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return readJson<ApiCandle[]>(response, "K 线加载失败。");
}

function withSimulationAccount(path: string, simulationAccountId: string) {
  const params = new URLSearchParams({ simulationAccountId });
  return `${path}?${params.toString()}`;
}

export async function fetchTradingAccount(simulationAccountId: string) {
  const response = await fetch(withSimulationAccount("/api/trading/account", simulationAccountId), { headers: userHeaders() });
  return readJson<TradingAccount>(response, "账户加载失败。", { userAuthFailure: true });
}

export async function fetchPositions(simulationAccountId: string) {
  const response = await fetch(withSimulationAccount("/api/trading/positions", simulationAccountId), { headers: userHeaders() });
  return readJson<PositionView[]>(response, "持仓加载失败。", { userAuthFailure: true });
}

export async function fetchOrders(simulationAccountId: string) {
  const response = await fetch(withSimulationAccount("/api/trading/orders", simulationAccountId), { headers: userHeaders() });
  return readJson<OrderRecord[]>(response, "订单加载失败。", { userAuthFailure: true });
}

export async function placeMarketOrder(symbol: string, side: TradeSide, volume: number, simulationAccountId: string) {
  const response = await fetch("/api/trading/order", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify({ symbol, side, volume, simulationAccountId }),
  });

  return readJson<PositionView>(response, "市价单被拒绝。", { userAuthFailure: true });
}

export async function closePosition(positionId: string, simulationAccountId: string) {
  const response = await fetch(`/api/trading/positions/${positionId}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...userHeaders() },
    body: JSON.stringify({ simulationAccountId }),
  });

  return readJson<{ positionId: string; closePrice: number; pnl: number; account: TradingAccount }>(response, "平仓被拒绝。", {
    userAuthFailure: true,
  });
}

export async function fetchAdminAccounts() {
  const response = await fetch("/api/admin/accounts", { headers: adminHeaders() });
  return readJson<TradingAccount[]>(response, "后台交易账户加载失败。");
}

export async function fetchAdminPositions() {
  const response = await fetch("/api/admin/positions", { headers: adminHeaders() });
  return readJson<PositionView[]>(response, "后台持仓加载失败。");
}

export async function fetchAdminOrders() {
  const response = await fetch("/api/admin/orders", { headers: adminHeaders() });
  return readJson<OrderRecord[]>(response, "后台订单加载失败。");
}

export async function fetchAdminBalanceAdjustments() {
  const response = await fetch("/api/admin/balance-adjustments", { headers: adminHeaders() });
  return readJson<BalanceAdjustment[]>(response, "后台资金调整记录加载失败。");
}

export async function adjustAdminAccountBalance(userId: string, type: "deposit" | "withdraw" | "reset", amount: number, note = "") {
  const response = await fetch(`/api/admin/accounts/${userId}/adjust-balance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ type, amount, note }),
  });
  return readJson<TradingAccount>(response, "资金调整失败。");
}

export async function fetchAdminMarketStatus() {
  const response = await fetch("/api/admin/market/status", { headers: adminHeaders() });
  return readJson<AdminMarketStatus[]>(response, "后台行情状态加载失败。");
}

function toQuoteStatus(status?: MarketStatus): QuoteStatus {
  return status ?? "disconnected";
}
