import type { ExecutionStatus } from "../cex/ExecutionState";

export type OkxCredentials = Readonly<{
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}>;

export type OkxCredentialProvider = () => OkxCredentials;

export type OkxOrderSide = "buy" | "sell";
export type OkxTradeMode = "cross" | "isolated" | "cash";
export type OkxOrderType = "market" | "limit";
export type OkxContractQuantity = string;

export type OkxPlaceOrderRequest = Readonly<{
  instId: string;
  tdMode: OkxTradeMode;
  side: OkxOrderSide;
  ordType: OkxOrderType;
  quantity: OkxContractQuantity;
  clOrdId: string;
  price?: string;
  reduceOnly?: boolean;
  /** OKX Spot market buy quantity must be expressed in base currency. */
  targetCurrency?: "base_ccy";
  /** Provider-only hedge bucket; omitted for net_mode and Spot. */
  posSide?: "long" | "short";
  positionMode?: "ONE_WAY" | "HEDGE";
}>;

export type OkxOrderIdentity = Readonly<{
  instId: string;
  ordId: string;
  clOrdId: string;
}>;

export type OkxCancelOrderResult = OkxOrderIdentity;

export type OkxAccountIdentity = Readonly<{
  accountId: string;
  accountFingerprint: string;
  uidHash: string;
  accountLevel: string;
}>;

export type OkxPermissions = Readonly<{
  read: boolean;
  spotTrade: boolean;
  contractTrade: boolean;
  withdraw: boolean;
  ipRestricted: boolean;
  accountLevelSupported: boolean;
  positionModeSupported: boolean;
  providerVerified: boolean;
  executionEnabled: boolean;
}>;

export type OkxAccountAccess = OkxAccountIdentity & Readonly<{
  permissions: OkxPermissions;
}>;

export type OkxExecutionStatus = Extract<
  ExecutionStatus,
  "SUBMITTED" | "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN"
>;

export type OkxProviderOrder = Readonly<OkxOrderIdentity & {
  side?: OkxOrderSide;
  posSide?: "net" | "long" | "short";
  reduceOnly?: boolean;
  tdMode?: OkxTradeMode;
  status: OkxExecutionStatus;
  statusReason: string | null;
  rawState: string;
  requestedQuantity: OkxContractQuantity;
  filledQuantity: OkxContractQuantity;
  averagePrice: string | null;
  fee: string;
  feeCcy?: string | null;
  updatedAt: number | null;
}>;

export type OkxGetOrderRequest = Readonly<{
  instId: string;
  ordId?: string;
  clOrdId?: string;
}>;

export type OkxCancelOrderRequest = OkxGetOrderRequest;

export type OkxPositionSide = "long" | "short" | "flat";

export type OkxPerpetualPosition = Readonly<{
  instId: string;
  side: OkxPositionSide;
  quantity: string;
  averagePrice: string | null;
  markPrice: string | null;
  liquidationPrice: string | null;
  updatedAt: number | null;
}>;
