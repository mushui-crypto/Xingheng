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

export type BinanceAllSymbolReadStatus = {
  status: "success";
  fullScan: true;
};

export type BinanceReadOnlyFuturesPosition = {
  symbol: string;
  positionSide: "BOTH" | "LONG" | "SHORT";
  positionAmt: string;
  entryPrice: string | null;
  leverage: string | null;
  marginType: "cross" | "isolated" | null;
};

export type BinanceReadOnlyOpenOrder = {
  symbol: string;
  side: "BUY" | "SELL";
  orderId: string;
  clientOrderId: string;
  status: string;
  originalQuantity: string;
  executedQuantity: string;
};

export type BinanceReadOnlyFuturesOpenOrder = BinanceReadOnlyOpenOrder & {
  reduceOnly: boolean | null;
};

export type BinanceReadOnlyInstrumentSetting = {
  symbol: "BTCUSDT" | "ETHUSDT" | "DOGEUSDT" | "XAUTUSDT";
  status: "READABLE" | "NOT_CURRENTLY_READABLE";
  leverage: string | null;
  marginMode: "cross" | "isolated" | null;
};

export type BinanceReadOnlyAccountSnapshot = BinanceAccountIdentity & {
  fetchedAt: number;
  permissions: BinancePermissions;
  balances: BinanceReadOnlyAccountBalance[];
};

export type BinanceAllSymbolAccountReadSnapshot = BinanceReadOnlyAccountSnapshot & {
  allSymbolReadStatus: {
    futuresPositions: BinanceAllSymbolReadStatus;
    spotOpenOrders: BinanceAllSymbolReadStatus;
    futuresOpenOrders: BinanceAllSymbolReadStatus;
  };
  futuresPositions: BinanceReadOnlyFuturesPosition[];
  spotOpenOrders: BinanceReadOnlyOpenOrder[];
  futuresOpenOrders: BinanceReadOnlyFuturesOpenOrder[];
  instrumentSettings: BinanceReadOnlyInstrumentSetting[];
};

export type BinancePerpetualPositionSnapshot = {
  symbol: string;
  side: "long" | "short" | "flat";
  baseQuantity: string;
  updatedAt: number | null;
};

export type BinanceSpotOrderFillSummary = Readonly<{
  symbol: string;
  providerOrderId: string;
  grossBaseQuantity: string;
  baseCommissionQuantity: string;
}>;

export type BinanceGenericRiskSnapshotRequest = Readonly<{
  category: "spot" | "linear";
  symbol: string;
  baseAsset: string;
}>;

export type BinanceGenericRiskSnapshot = Readonly<{
  accountId: string;
  accountFingerprint: string;
  fetchedAt: number;
  accountMode: BinanceAccountIdentity["accountMode"];
  permissions: BinancePermissions;
  category: "spot" | "linear";
  symbol: string;
  baseAsset: string;
  availableUsdt: string;
  availableBaseAsset: string | null;
  openOrderCount: number;
  position: Readonly<{
    side: "long" | "short" | "flat";
    quantity: string;
    leverage: string;
    marginMode: "cross" | "isolated";
  }> | null;
}>;

export type BinanceGenericRiskContext = Readonly<{
  userId: string;
  accountId: string;
  instrumentId: string;
  category: "spot" | "linear";
  providerSymbol: string;
  baseAsset: string;
  instrumentStatus: "trading" | "paused" | "close_only" | "delisted" | "unknown";
  valuationPrice: string;
  quoteFetchedAt: number;
}>;

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

type BinanceExecutionOrderRequestBase = {
  category: "spot" | "linear";
  symbol: string;
  side: "Buy" | "Sell";
  quantity: string;
  reduceOnly: boolean;
  /** Internal semantic identity only; never serialized to Binance. */
  positionDirection?: "LONG" | "SHORT";
  /** Provider-only position bucket; serialized only for HEDGE futures. */
  positionSide?: "BOTH" | "LONG" | "SHORT";
  positionMode?: "ONE_WAY" | "HEDGE";
  orderLinkId: string;
};

export type BinanceExecutionOrderRequest = BinanceExecutionOrderRequestBase & (
  | Readonly<{ executionPriceMode?: "IOC_LIMIT"; limitPrice: string }>
  | Readonly<{ executionPriceMode: "MARKET"; limitPrice?: never }>
);

export type BinanceProviderOrder = {
  symbol: string;
  orderId: string;
  orderLinkId: string;
  status: "New" | "PartiallyFilled" | "Filled" | "Cancelled" | "Rejected" | "Expired" | "Unknown";
  requestedQuantity: number;
  filledQuantity: number;
  positionSide?: "BOTH" | "LONG" | "SHORT";
  /** Exact provider origQty in canonical base-asset units. */
  requestedBaseQuantity?: string;
  /** Exact provider executedQty in canonical base-asset units. */
  filledBaseQuantity?: string;
  positionQuantity?: number;
  averagePrice: number | null;
  feeUsd: number;
  updatedAt: number;
};

export function binanceFilledBaseQuantity(
  order: Pick<BinanceProviderOrder, "filledBaseQuantity" | "filledQuantity">,
) {
  if (order.filledBaseQuantity !== undefined) {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(order.filledBaseQuantity)) {
      throw new Error("Binance filled base quantity is invalid.");
    }
    return order.filledBaseQuantity;
  }
  // Compatibility for orders persisted before exact Decimal quantities existed.
  return legacyBinanceNumberToDecimal(order.filledQuantity);
}

function legacyBinanceNumberToDecimal(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Binance filled quantity is invalid.");
  const text = String(value);
  if (!/[eE]/u.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [integer, fraction = ""] = coefficient!.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer!.length + exponent;
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

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
  readGenericRiskSnapshot?(request: BinanceGenericRiskSnapshotRequest): Promise<BinanceGenericRiskSnapshot>;
  placeOrder(request: BinanceExecutionOrderRequest): Promise<{ orderId: string; orderLinkId: string; symbol?: string }>;
  placeTestOrder(request: BinanceExecutionOrderRequest): Promise<{ orderId: string; orderLinkId: string; symbol?: string }>;
  awaitOrder(
    category: "spot" | "linear",
    symbol: string,
    orderId: string,
    deadlineAt: number,
    clientOrderId?: string,
  ): Promise<BinanceProviderOrder>;
  cancelOrder(
    category: "spot" | "linear",
    symbol: string,
    orderId: string,
    onDispatch?: () => void,
  ): Promise<void>;
  listAssetOpenOrders(): Promise<Array<{
    category: "spot" | "linear";
    orderId: string;
    clientOrderId: string;
    symbol: string;
  }>>;
  findOrderByClientOrderId(category: "spot" | "linear", symbol: string, orderLinkId: string): Promise<BinanceProviderOrder | null>;
  readStrategyPnl(orderLinkPrefix: string | null, since: number | null): Promise<BinanceStrategyPnlSnapshot>;
  readPositionMode?(): Promise<"ONE_WAY" | "HEDGE">;
};
