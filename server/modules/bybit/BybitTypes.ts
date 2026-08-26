import type { ExecutionStatus } from "../cex/ExecutionState";

export type BybitCredentials = Readonly<{
  apiKey: string;
  apiSecret: string;
}>;

export type BybitCategory = "spot" | "linear";
export type BybitOrderSide = "Buy" | "Sell";
export type BybitOrderType = "Market" | "Limit";
export type BybitMarketUnit = "baseCoin";
export type BybitPositionIdx = 0 | 1 | 2;
export type BybitObservedPositionIdx = 0 | 1 | 2;

export type BybitPlaceOrderRequest = Readonly<{
  category: BybitCategory;
  symbol: string;
  side: BybitOrderSide;
  orderType: BybitOrderType;
  qty: string;
  orderLinkId: string;
  price?: string;
  reduceOnly?: boolean;
  positionIdx?: BybitPositionIdx;
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
  marketUnit?: BybitMarketUnit;
}>;

export type BybitOrderIdentity = Readonly<{
  category: BybitCategory;
  symbol: string;
  orderId: string;
  orderLinkId: string;
}>;

export type BybitPlaceOrderResult = BybitOrderIdentity;

export type BybitGetOrderRequest = Readonly<{
  category: BybitCategory;
  symbol: string;
  orderId?: string;
  orderLinkId: string;
}>;

export type BybitCancelOrderRequest = BybitGetOrderRequest;

export type BybitExecutionStatus = Extract<
  ExecutionStatus,
  "SUBMITTED" | "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN"
>;

export type BybitProviderOrder = Readonly<BybitOrderIdentity & {
  side: BybitOrderSide;
  status: BybitExecutionStatus;
  statusReason: string | null;
  rawStatus: string;
  requestedQuantity: string;
  filledQuantity: string;
  averagePrice: string | null;
  fee: string;
  feeCurrency: string | null;
  positionIdx?: BybitObservedPositionIdx;
  reduceOnly?: boolean;
  marketUnit?: BybitMarketUnit;
  updatedAt: number | null;
}>;

export type BybitAccountIdentity = Readonly<{
  accountId: string;
  accountFingerprint: string;
  uidHash: string;
}>;

export type BybitPermissions = Readonly<{
  read: boolean;
  spotTrade: boolean;
  contractTrade: boolean;
  withdraw: boolean;
  ipRestricted: boolean;
  accountLevelSupported: boolean;
  providerVerified: boolean;
  executionEnabled: boolean;
}>;

export type BybitAccountAccess = BybitAccountIdentity & Readonly<{
  permissions: BybitPermissions;
  unifiedMarginStatus: number;
  marginMode: string;
}>;
