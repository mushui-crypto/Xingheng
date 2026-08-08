import { requestJson } from "./httpClient";

export type BinancePermissions = {
  read: boolean;
  spotTrade: boolean;
  contractTrade: boolean;
  withdraw: boolean;
  ipRestricted: boolean;
  spotAccount: boolean;
  futuresAccount: boolean;
  positionModeSupported: boolean;
};

export type BinanceInstrumentSnapshot = {
  status: "Trading" | "Paused" | "Unknown";
  minOrderQty: number;
  qtyStep: number;
  minNotionalUsd: number;
  priceTick: number;
  quantityPrecision: number;
  bid: number;
  ask: number;
  depthUsd: number;
};

export type BinanceAccountSnapshot = {
  accountId: string;
  accountFingerprint: string;
  fetchedAt: number;
  accountMode: string;
  permissions: BinancePermissions;
  productAvailability: {
    available: boolean;
    status: string;
    spotSymbol: string;
    perpetualSymbol: string;
    checkedAt: number;
    message: string | null;
  };
  availableUsdt: number;
  spotAvailableUsdt: number;
  futuresAvailableUsdt: number;
  spotFreeXaut: number;
  spotLockedXaut: number;
  existingSpotQuantityXaut: number;
  spotAvailableQuantityXaut: number;
  spotLockedQuantityXaut: number;
  existingPerpetualQuantityXaut: number;
  perpetualPositionSide: "long" | "short" | "flat";
  openSpotOrderCount: number;
  openPerpetualOrderCount: number;
  spot: BinanceInstrumentSnapshot;
  perpetual: BinanceInstrumentSnapshot & {
    leverage: number | null;
    mark: number;
    fundingRate: number;
    fundingIntervalHours: number;
    nextFundingTime: number | null;
    liquidationDistancePercent: number | null;
  };
  fees: { spotTakerBps: number; perpetualTakerBps: number };
};

export type BinanceStatus = {
  mode: "personal";
  version: string;
  credential: { configured: boolean; maskedApiKey: string | null };
  connection: {
    status: "not_configured" | "checking" | "connected" | "failed";
    checkedAt: number | null;
    accountId: string | null;
    message: string | null;
  };
  risk: {
    liveTradingEnabled: boolean;
    killSwitchActive: boolean;
    maxOrderUsd: number;
    maxPositionUsd: number;
  };
};

export type BinanceOpportunity = {
  eligible: boolean;
  entryBasisBps: number;
  estimatedNetAprPercent: number;
  fundingRate: number;
  reasons: string[];
};

export type BinanceStrategyStatus = {
  snapshot: BinanceAccountSnapshot;
  opportunity: BinanceOpportunity;
};

export type BinanceMarketSnapshot = Pick<BinanceAccountSnapshot, "fetchedAt" | "productAvailability" | "spot" | "perpetual" | "fees">;

export type BinanceProviderOrder = {
  orderId: string;
  orderLinkId: string;
  status: "New" | "PartiallyFilled" | "Filled" | "Cancelled" | "Rejected" | "Expired" | "Unknown";
  requestedQuantityXaut: number;
  filledQuantityXaut: number;
  positionQuantityXaut?: number;
  averagePrice: number | null;
  feeUsd: number;
  updatedAt: number;
};

export type BinanceStoredOrder = {
  idempotencyKey: string;
  clientOrderId: string;
  providerOrderId: string | null;
  category: "spot" | "linear";
  executionMode: "production_ioc" | "test_gtc";
  status: "processing" | "completed" | "failed";
  order: BinanceProviderOrder | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type BinanceOrdersState = { orders: BinanceStoredOrder[] };
export type BinanceReconciliation = {
  reconciled: BinanceProviderOrder[];
  snapshot: BinanceAccountSnapshot;
  orders: BinanceStoredOrder[];
};

const get = <T>(path: string, message: string, signal?: AbortSignal) => requestJson<T>(path, message, {
  userAuthFailure: true,
  init: { cache: "no-store", credentials: "include", headers: { Accept: "application/json" }, signal },
});

const post = <T>(path: string, message: string, body?: unknown) => requestJson<T>(path, message, {
  userAuthFailure: true,
  init: {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  },
});

export const fetchBinanceStatus = (signal?: AbortSignal) => get<BinanceStatus>("/api/binance/status", "Binance 状态加载失败。", signal);
export const checkBinanceConnection = () => post<BinanceStatus>("/api/binance/connection-check", "Binance 连接检查失败。");
export const fetchBinanceAccount = (signal?: AbortSignal) => get<BinanceAccountSnapshot>("/api/binance/account", "Binance 账户加载失败。", signal);
export const fetchBinanceMarket = (signal?: AbortSignal) => get<BinanceMarketSnapshot>("/api/binance/market", "Binance 行情加载失败。", signal);
export const fetchBinanceStrategy = (signal?: AbortSignal) => get<BinanceStrategyStatus>("/api/binance/strategy", "Binance 策略状态加载失败。", signal);
export const enterBinanceStrategy = (input: { idempotencyKey: string; budgetUsd?: number }) => post("/api/binance/strategy/enter", "Binance 建仓失败。", input);
export const exitBinanceStrategy = (input: { idempotencyKey: string }) => post("/api/binance/strategy/exit", "Binance 退出失败。", input);
export const fetchBinanceOrders = (signal?: AbortSignal) => get<BinanceOrdersState>("/api/binance/orders", "Binance 订单加载失败。", signal);
export const reconcileBinance = () => post<BinanceReconciliation>("/api/binance/reconciliation", "Binance 对账失败。");
