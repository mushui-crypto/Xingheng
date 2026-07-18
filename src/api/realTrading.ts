import type { CandleInterval } from "../types";
import type { MarketSourceType, SymbolCategory, TradeStatus } from "../types/market";
import { adminHeaders, requestJson, userHeaders } from "./httpClient";

export type RealTradingNetwork = "hyperliquid-testnet";
export type RealTradingMarginMode = "cross" | "isolated";

export type RealTradingRealtimeMetadata = {
  connectionStatus?: string;
  lastUpdateAt?: number | string | null;
  realtimeStatus?: string;
  snapshotAt?: number | string | null;
};

export type RealTradingSymbol = {
  symbol: string;
  providerMarketId?: string;
  providerCoin: string;
  sourceDex?: string;
  sourceType?: MarketSourceType;
  category?: SymbolCategory;
  iconUrl?: string | null;
  assetId?: number;
  szDecimals?: number;
  pxDecimals?: number;
  maxLeverage?: number;
  supportedMarginModes?: RealTradingMarginMode[];
  marginModeConstraint?: "cross_and_isolated" | "isolated_only";
  status?: string;
  tradeStatus?: TradeStatus;
  network?: RealTradingNetwork;
};

export type RealMarketSummary = RealTradingRealtimeMetadata & {
  symbol: string;
  markPrice?: number | null;
  oraclePrice?: number | null;
  midPrice?: number | null;
  previousDayPrice?: number | null;
  dayChange?: number | null;
  dayChangePercent?: number | null;
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
  cumulativeSize?: number;
  orderCount?: number | null;
};

export type RealOrderbook = RealTradingRealtimeMetadata & {
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
  withdrawable?: number | null;
  availableMargin?: number | null;
  usedMargin?: number | null;
  totalUnrealizedPnl?: number | null;
  crossAccountValue?: number | null;
  crossMaintenanceMarginUsed?: number | null;
  crossTotalMarginUsed?: number | null;
  crossTotalNotionalPosition?: number | null;
  crossMarginRatio?: number | null;
  isolatedAccountValue?: number | null;
  spotUsdcBalance?: number | null;
  spotBalances?: Array<{
    coin: string;
    total: number | null;
    hold: number | null;
    available: number | null;
  }>;
  warnings?: string[];
  cross?: unknown;
  isolated?: unknown;
};

export type RealPosition = {
  coin: string;
  symbol?: string;
  providerMarketId?: string;
  providerCoin?: string;
  assetId?: number;
  sourceDex?: string;
  sourceType?: MarketSourceType;
  side: "long" | "short" | string;
  size: number;
  entryPx?: number | null;
  entryPrice?: number | null;
  markPx?: number | null;
  markPrice?: number | null;
  liqPx?: number | null;
  liquidationPrice?: number | null;
  positionValue?: number | null;
  returnOnEquity?: number | null;
  margin?: number | null;
  marginMode?: RealTradingMarginMode | null;
  leverage?: number | null;
  maxLeverage?: number | null;
  unrealizedPnl?: number | null;
  fundingAllTime?: number | null;
  fundingSinceChange?: number | null;
  fundingSinceOpen?: number | null;
  cumFunding?: {
    allTime: number | null;
    sinceChange: number | null;
    sinceOpen: number | null;
  };
};

export type RealOpenOrder = {
  id?: string;
  oid?: number | string;
  coin?: string;
  symbol?: string;
  providerMarketId?: string;
  providerCoin?: string;
  assetId?: number;
  sourceDex?: string;
  sourceType?: MarketSourceType;
  side?: string;
  price?: number | null;
  size?: number | null;
  status?: string;
  lifecycleStatus?: string;
  clientOrderId?: string | null;
  updatedAt?: number | null;
  timestamp?: number;
  limitPx?: number | string | null;
  sz?: number | string | null;
  cloid?: string | null;
  reduceOnly?: boolean | null;
  isPositionTpsl?: boolean | null;
  isTrigger?: boolean | null;
  orderType?: string | null;
  origSz?: number | null;
  triggerCondition?: string | null;
  triggerPx?: number | null;
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
  symbol?: string;
  providerMarketId?: string;
  providerCoin?: string;
  assetId?: number;
  sourceDex?: string;
  sourceType?: MarketSourceType;
  side?: string;
  px?: number | string | null;
  sz?: number | string | null;
  time?: number;
  oid?: number | string;
  tid?: number | string;
  closedPnl?: number | string | null;
  price?: number | null;
  size?: number | null;
  timestamp?: number | null;
  fee?: number | null;
  feeToken?: string | null;
  hash?: string | null;
  direction?: string | null;
};

export type RealTradingFees = {
  makerRate: number | null;
  takerRate: number | null;
  spotMakerRate: number | null;
  spotTakerRate: number | null;
  activeReferralDiscount: number | null;
  activeStakingDiscount: number | null;
  timestamp: number;
  network: RealTradingNetwork;
  warnings?: string[];
};

export type RealOrderHistory = {
  orders: RealHistoricalOrder[];
  fills: RealFill[];
  nextCursor: string | null;
  warnings: string[];
  connectionStatus?: string;
  realtimeStatus?: string;
  snapshotAt?: number | string | null;
};

export type SignedRealTradingExchangePayload = {
  clientRequestId: string;
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
  lifecycleStatus?: string;
  reconciliationStatus?: string;
  cloid?: string | null;
  needsReconciliation?: boolean;
  requestId?: string;
  actionType?: string;
  submittedAt?: number;
  accepted?: boolean;
  rejected?: boolean;
  outcome?: "accepted" | "rejected" | "partial" | "pending_reconciliation";
  orderStatuses?: Array<{
    index: number;
    status: "accepted" | "rejected";
    providerStatus: "resting" | "filled" | "error" | "unknown";
    oid: string | number | null;
    message: string | null;
  }>;
  clientRequestId?: string;
  cloids?: string[];
  orderState?: "submitted" | "accepted" | "partial" | "filled" | "cancelled" | "rejected" | "expired";
  errorCategory?: string | null;
  retryable?: boolean;
  reconcileRequired?: boolean;
  timestamp: number;
};

export type RealTradingOrderAudit = {
  requestId: string;
  clientRequestId?: string | null;
  cloid?: string | null;
  cloids?: string[];
  orderState: "submitted" | "accepted" | "partial" | "filled" | "cancelled" | "rejected" | "expired";
  errorCategory?: string | null;
  retryable: boolean;
  reconcileRequired: boolean;
  timestamp: number;
};

export type RealTradingReconciliationRecord = {
  requestId: string;
  actionType: string;
  submittedAt: number | null;
  clientOrderIds: string[];
  autoRecoverable: boolean;
  manualReview: boolean;
  lastReconcileAttemptAt: number | null;
  errorCategory: string | null;
  blockingScope: "new_risk" | "manual_review";
};

export type RealTradingReconciliationResponse = {
  network: RealTradingNetwork;
  records: RealTradingReconciliationRecord[];
};

export type AdminRealTradingOperationsStatus = "ok" | "degraded" | "unavailable";
export type AdminRealTradingMetric = number | "unavailable";

export type AdminRealTradingOperations = {
  network: RealTradingNetwork;
  status: AdminRealTradingOperationsStatus;
  generatedAt: number;
  reconciliation: {
    status?: AdminRealTradingOperationsStatus;
    enabled?: boolean;
    running?: boolean;
    network?: RealTradingNetwork;
    lastAttemptAt?: number | null;
    lastSuccessAt?: number | null;
    lastCompletedAt?: number | null;
    lastRunReason?: string | null;
    consecutiveFailures?: number;
    lastError?: string | null;
    lastScannedPending?: number;
    lastRecoveredRequests?: number;
    nextCheckAt?: number | null;
    stale?: boolean;
  };
  userStreams: {
    status?: AdminRealTradingOperationsStatus;
    activeStreamCount?: number;
    activeUserCount?: number;
    maxStreamCount?: number;
    streams?: Array<{
      address: string;
      status: string;
      reconnecting: boolean;
      stale: boolean;
      userCount: number;
      listenerCount: number;
      sequence: number;
      lastSnapshotAt: number | null;
      lastEventAt: number | null;
    }>;
  };
  risk: {
    status?: AdminRealTradingOperationsStatus;
    limits?: {
      maxLeverage: number;
      maxOrderNotionalEquityRatio: number;
      maxTotalNotionalEquityRatio: number;
      maxOpenOrders: number;
      maxSnapshotAgeMs: number;
    };
    inFlightCount?: number;
    inFlightNotional?: number;
    inFlightByAddress?: Array<{
      masterAddress: string;
      count: number;
      notional: number;
    }>;
  };
  operations: {
    pendingCount: AdminRealTradingMetric;
    autoRecoverablePendingCount: AdminRealTradingMetric;
    manualReviewPendingCount: AdminRealTradingMetric;
    idempotencyPendingWithoutAuditCount?: AdminRealTradingMetric;
    oldestPendingSubmittedAt: number | null;
    oldestPendingAgeMs: number | null;
    recentWindowMs?: number;
    recentCounts: Array<{
      actionType: string;
      outcome: "accepted" | "rejected" | "partial" | "pending_reconciliation";
      count: number;
    }>;
    auditCleanup: "unavailable" | {
      retentionDays: number;
      lastMaintenanceAt: number | null;
      lastDeletedRows: number;
    };
  };
  mainnetReadinessGaps?: string[];
};

export type RealTradingOrderSnapshot = {
  authoritative: true;
  fills: RealFill[];
  mode: "snapshot";
  openOrders: RealOpenOrder[];
  orders: RealHistoricalOrder[];
  reconnecting: boolean;
  sequence: number;
  stale: boolean;
  status: "connected" | "stale" | "reconnecting";
  timestamp: number;
  warnings: string[];
};

export type RealTradingOrderIncremental = {
  authoritative: true;
  baseSequence: number;
  fills: RealFill[];
  mode: "incremental";
  openOrders: {
    removedOrderIds: string[];
    upserted: RealOpenOrder[];
  };
  reconnecting: false;
  sequence: number;
  stale: false;
  status: "connected";
  terminalOrders: RealHistoricalOrder[];
  timestamp: number;
  warnings: string[];
};

export type RealTradingOrderState = RealTradingOrderSnapshot | RealTradingOrderIncremental;

export type RealTradingCloidStatus = {
  authoritative: true;
  cloid: string;
  network: RealTradingNetwork;
  order: RealHistoricalOrder | null;
  status: "order" | "unknown";
  timestamp: number;
};

export type RealTradingRealtimeToken = {
  address: string;
  expiresAt: number;
  token: string;
};

export type RealTradingUserStreamEvent = {
  address: string;
  authoritative: true;
  channel: "snapshot" | "orders" | "fills" | "open_orders" | "account" | "connection";
  data: unknown;
  mode: "snapshot" | "incremental";
  reconnecting: boolean;
  sequence: number;
  source: "hyperliquid-user-ws" | "hyperliquid-rest-snapshot";
  stale: boolean;
  status: "connected" | "stale" | "reconnecting";
  timestamp: number;
  type: "real-trading-user";
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

export async function fetchRealTradingFees(address: string) {
  return requestJson<RealTradingFees>(`/api/real-trading/account/fees?address=${encodeURIComponent(address)}`, "真实交易费率加载失败。", {
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

export async function fetchRealTradingOrderState(address: string, afterSequence?: number | null) {
  const sequence = typeof afterSequence === "number" ? `&afterSequence=${afterSequence}` : "";
  return requestJson<RealTradingOrderState>(`/api/real-trading/orders/state?address=${encodeURIComponent(address)}${sequence}`, "真实订单状态加载失败。", {
    init: { headers: realTradingHeaders() },
    userAuthFailure: true,
  });
}

export async function fetchRealTradingCloidStatus(address: string, cloid: string) {
  return requestJson<RealTradingCloidStatus>(
    `/api/real-trading/orders/status?address=${encodeURIComponent(address)}&cloid=${encodeURIComponent(cloid)}`,
    "真实订单对账状态加载失败。",
    {
      init: { headers: realTradingHeaders() },
      userAuthFailure: true,
    },
  );
}

export async function fetchRealTradingOrderAudit(requestId: string) {
  return requestJson<RealTradingOrderAudit>(
    `/api/real-trading/orders/audit?requestId=${encodeURIComponent(requestId)}`,
    "真实订单审计状态加载失败。",
    {
      init: { headers: realTradingHeaders() },
      userAuthFailure: true,
    },
  );
}

export async function fetchRealTradingReconciliation(signal?: AbortSignal) {
  return requestJson<RealTradingReconciliationResponse>(
    "/api/real-trading/orders/reconciliation",
    "真实交易待对账状态加载失败。",
    {
      init: { headers: realTradingHeaders(), cache: "no-store", signal },
      userAuthFailure: true,
    },
  );
}

export async function fetchAdminRealTradingOperations(signal?: AbortSignal) {
  return requestJson<AdminRealTradingOperations>(
    "/api/admin/real-trading/operations",
    "真实交易运维状态加载失败。",
    {
      init: { headers: adminHeaders(), cache: "no-store", signal },
      networkErrorMessage: "真实交易运维服务暂时不可用。",
    },
  );
}

export async function requestRealTradingRealtimeToken(address: string) {
  return requestJson<RealTradingRealtimeToken>("/api/real-trading/realtime/token", "真实交易实时订阅授权失败。", {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...realTradingHeaders() },
      body: JSON.stringify({ address }),
    },
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
    acceptErrorResponse: true,
    userAuthFailure: true,
  });
}
