export const BINANCE_STRATEGY_ID = "binance-xaut-spot-perp-v1" as const;
export const BINANCE_SPOT_SYMBOL = "XAUTUSDT" as const;
export const BINANCE_PERPETUAL_SYMBOL = "XAUTUSDT" as const;
export const BINANCE_PRODUCT_CACHE_TTL_MS = 30_000;

export type BinanceCredentials = { apiKey: string; apiSecret: string };
export type BinanceOrderExecutionMode = "production_ioc" | "test_gtc";
export type BinanceExecutionPriceMode = import("./BinanceExecutionPolicy").BinanceExecutionPriceMode;

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

export type BinanceAccountIdentity = {
  accountId: string;
  accountFingerprint: string;
  uidSnapshot?: string;
  accountMode:
    | "single_asset_one_way"
    | "single_asset_hedge"
    | "multi_assets_one_way"
    | "multi_assets_hedge"
    | "portfolio_margin"
    | "unknown";
  ipWhitelistVerificationMode?: "provider_list_exact" | "provider_restriction_only";
};

export type BinanceReadOnlyAccountBalance = {
  asset: string;
  accountType: "spot" | "derivatives";
  total: number;
  available: number;
  locked: number | null;
};

export type BinanceReadOnlyAccountSnapshot = BinanceAccountIdentity & {
  fetchedAt: number;
  permissions: BinancePermissions;
  balances: BinanceReadOnlyAccountBalance[];
};

export type BinancePerpetualPositionSnapshot = {
  symbol: string;
  side: "long" | "short" | "flat";
  baseQuantity: string;
  updatedAt: number | null;
};

export type BinanceProductAvailability = {
  available: boolean;
  status: "available" | "spot_unavailable" | "perpetual_unavailable" | "both_unavailable";
  spotSymbol: typeof BINANCE_SPOT_SYMBOL;
  perpetualSymbol: typeof BINANCE_PERPETUAL_SYMBOL;
  checkedAt: number;
  message: string | null;
};

export type BinanceInstrumentSpec = {
  status: "Trading" | "Paused" | "Unknown";
  minOrderQty: number;
  qtyStep: number;
  minNotionalUsd: number;
  priceTick: number;
};

export type BinanceInstrumentSnapshot = BinanceInstrumentSpec & {
  quantityPrecision: number;
  bid: number;
  ask: number;
  depthUsd: number;
};

export type BinancePreflightSnapshot = {
  accountId: string;
  accountFingerprint: string;
  uidSnapshot?: string;
  fetchedAt: number;
  accountMode: BinanceAccountIdentity["accountMode"];
  permissions: BinancePermissions;
  productAvailability: BinanceProductAvailability;
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
    marginMode: "cross" | "isolated" | "unknown";
    mark: number;
    fundingRate: number;
    fundingIntervalHours: number;
    nextFundingTime: number | null;
    liquidationDistancePercent: number | null;
  };
  fees: { spotTakerBps: number; perpetualTakerBps: number };
};

export type BinanceOrderRequest = {
  category: "spot" | "linear";
  symbol: typeof BINANCE_SPOT_SYMBOL;
  side: "Buy" | "Sell";
  quantityXaut: number;
  limitPrice: number;
  executionPriceMode?: BinanceExecutionPriceMode;
  reduceOnly: boolean;
  orderLinkId: string;
};

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

export type BinanceStrategyPnlSnapshot = {
  accountId: string;
  accountFingerprint: string;
  strategyId: typeof BINANCE_STRATEGY_ID;
  capturedAt: number;
  legs: {
    spot: BinanceStrategyLeg;
    perpetual: BinanceStrategyLeg;
  };
  netDeltaXaut: number;
  netDeltaUsd: number;
  entryBasisBps: number | null;
  currentBasisBps: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  fundingPnlUsd: number;
  feesUsd: number;
  slippageUsd: number;
  netPnlUsd: number;
  openOrders: BinanceProviderOrder[];
};

export type BinanceStrategyLeg = {
  kind: "spot_long" | "perpetual_short";
  quantityXaut: number;
  averageEntryPrice: number | null;
  markPrice: number | null;
  notionalUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
};

export type BinanceClientAdapter = {
  validateAccess(): Promise<BinanceAccountIdentity & { permissions: BinancePermissions }>;
  readProductAvailability(): Promise<BinanceProductAvailability>;
  readPreflightSnapshot(): Promise<BinancePreflightSnapshot>;
  setPerpetualLeverage(leverage: 1 | 2 | 3): Promise<void>;
  placeOrder(request: BinanceOrderRequest): Promise<{ orderId: string; orderLinkId: string }>;
  placeTestOrder(request: BinanceOrderRequest): Promise<{ orderId: string; orderLinkId: string }>;
  awaitOrder(category: "spot" | "linear", orderId: string, deadlineAt: number): Promise<BinanceProviderOrder>;
  cancelOrder(category: "spot" | "linear", orderId: string): Promise<void>;
  listAssetOpenOrders(): Promise<Array<{
    category: "spot" | "linear";
    orderId: string;
    clientOrderId: string;
    symbol: string;
  }>>;
  findOrderByClientOrderId(category: "spot" | "linear", orderLinkId: string): Promise<BinanceProviderOrder | null>;
  readStrategyPnl(orderLinkPrefix: string | null, since: number | null): Promise<BinanceStrategyPnlSnapshot>;
};
