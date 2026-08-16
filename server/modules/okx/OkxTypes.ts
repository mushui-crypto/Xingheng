import type { ExecutionStatus } from "../cex/ExecutionState";

export type OkxCredentials = Readonly<{
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}>;

export type OkxCredentialProvider = () => OkxCredentials;

export type OkxOrderSide = "buy" | "sell";
export type OkxTradeMode = "cross" | "isolated";
export type OkxOrderType = "market" | "limit";

export type OkxPlaceOrderRequest = Readonly<{
  instId: string;
  tdMode: OkxTradeMode;
  side: OkxOrderSide;
  ordType: OkxOrderType;
  quantity: string;
  clOrdId: string;
  price?: string;
  reduceOnly?: boolean;
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

export type OkxExecutionStatus = Extract<
  ExecutionStatus,
  "SUBMITTED" | "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN"
>;

export type OkxProviderOrder = Readonly<OkxOrderIdentity & {
  status: OkxExecutionStatus;
  statusReason: string | null;
  rawState: string;
  requestedQuantity: string;
  filledQuantity: string;
  averagePrice: string | null;
  fee: string;
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
