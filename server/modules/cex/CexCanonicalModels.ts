export type CexVenue = "binance" | "okx" | "bitget" | "bybit";

export type CexMarketType = "spot" | "perpetual";
export type CexContractType = "spot" | "linear_perpetual" | "inverse_perpetual";

export type CanonicalInstrument = {
  instrumentId: string;
  venue: CexVenue;
  marketType: CexMarketType;
  contractType: CexContractType;
  baseAsset: string;
  quoteAsset: string;
  settlementAsset: string;
  providerSymbol: string;
  providerLocator: Readonly<Record<string, string>>;
  quantityUnit: "base" | "contract";
  contractSize: number;
  priceTick: number;
  quantityStep: number;
  minQuantity: number;
  minNotional: number | null;
  status: "trading" | "close_only" | "paused" | "delisted" | "unknown";
  fetchedAt: number;
};

export type CanonicalOrderStatus =
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED"
  | "UNKNOWN";

export type CanonicalOrderRequest = {
  idempotencyKey: string;
  clientOrderId: string;
  venue: CexVenue;
  accountId: string;
  instrumentId: string;
  side: "buy" | "sell";
  positionEffect: "open" | "reduce";
  orderType: "limit";
  executionMode: "production" | "test";
  timeInForce: "IOC" | "GTC";
  baseQuantity: number;
  limitPrice: number;
};

export type CanonicalOrder = {
  venue: CexVenue;
  accountId: string;
  instrumentId: string;
  clientOrderId: string;
  providerOrderId: string;
  status: CanonicalOrderStatus;
  requestedBaseQuantity: number;
  filledBaseQuantity: number;
  averagePrice: number | null;
  feeAmount: number;
  feeAsset: string | null;
  updatedAt: number;
};

export type CanonicalPosition = {
  venue: CexVenue;
  accountId: string;
  instrumentId: string;
  side: "long" | "short" | "flat";
  baseQuantity: number;
  notionalUsd: number;
  entryPrice: number | null;
  markPrice: number | null;
  liquidationPrice: number | null;
  leverage: number | null;
  marginMode: "cross" | "isolated" | "unknown";
  unrealizedPnlUsd: number | null;
  fetchedAt: number;
};

export type CanonicalBalance = {
  asset: string;
  available: number;
  locked: number;
  total: number;
};

export type CanonicalAccountSnapshot = {
  venue: CexVenue;
  accountId: string;
  accountFingerprint: string;
  fetchedAt: number;
  balances: CanonicalBalance[];
  positions: CanonicalPosition[];
  openOrderCount: number;
};

export type CanonicalTopOfBook = {
  venue: CexVenue;
  instrumentId: string;
  bid: number;
  ask: number;
  markPrice: number | null;
  depthUsd: number | null;
  fetchedAt: number;
};

export type CanonicalFundingRate = {
  venue: CexVenue;
  instrumentId: string;
  rate: number;
  intervalHours: number;
  nextFundingAt: number | null;
  markPrice: number | null;
  fetchedAt: number;
};

export type CanonicalOrderScope = {
  venue: CexVenue;
  accountId: string;
  instrumentId: string;
};
