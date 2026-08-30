import type { ExecutionStatus } from "../cex/ExecutionState";

export type BitgetCredentials = Readonly<{
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}>;

export type BitgetCategory = "SPOT" | "USDT-FUTURES";
export type BitgetOrderSide = "buy" | "sell";
export type BitgetOrderType = "market" | "limit";
export type BitgetTimeInForce = "gtc" | "ioc";

export type BitgetPlaceOrderRequest = Readonly<{
  category: BitgetCategory;
  symbol: string;
  side: BitgetOrderSide;
  orderType: BitgetOrderType;
  qty: string;
  clientOid: string;
  price?: string;
  force?: BitgetTimeInForce;
  reduceOnly?: "yes" | "no";
  /** Provider-only hedge bucket; omitted for one-way and Spot. */
  posSide?: "long" | "short";
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
}>;

export type BitgetOrderIdentity = Readonly<{
  category: BitgetCategory;
  symbol: string;
  orderId: string;
  clientOid: string;
}>;

export type BitgetPlaceOrderResult = BitgetOrderIdentity;

export type BitgetGetOrderRequest = Readonly<{
  category: BitgetCategory;
  symbol: string;
  orderId?: string;
  clientOid: string;
}>;

export type BitgetCancelOrderRequest = BitgetGetOrderRequest;

export type BitgetProviderOrder = Readonly<BitgetOrderIdentity & {
  side: BitgetOrderSide;
  posSide?: "long" | "short";
  tradeSide?: "open" | "close" | "open_long" | "open_short" | "close_long" | "close_short";
  holdMode?: "one_way_mode" | "hedge_mode";
  reduceOnly?: "yes" | "no";
  status: Extract<ExecutionStatus, "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN">;
  rawStatus: string;
  requestedQuantity: string;
  filledQuantity: string;
  averagePrice: string | null;
  fee: string;
  feeCurrency: string | null;
  updatedAt: number | null;
}>;
