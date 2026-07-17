import type { CandleInterval } from "../../types";
import type { HyperliquidRealTradingNetwork } from "./hyperliquidConfig";

export type RealTradingMarketCategory = "crypto" | "metals" | "us_equities" | "indices" | "other";

export type RealTradingMarketSourceType = "main" | "hip3";

export type RealTradingMarketStatus = "active" | "close_only" | "disabled" | "delisted";

export type HyperliquidUniverseItem = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
  marginMode?: "strictIsolated" | "noCross" | "normal";
  onlyIsolated?: boolean;
};

export type HyperliquidUniverseItemPayload = Omit<HyperliquidUniverseItem, "szDecimals"> & {
  szDecimals?: unknown;
};

export type HyperliquidAssetContext = {
  markPx?: string;
  oraclePx?: string;
  midPx?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  openInterest?: string;
  funding?: string;
  nextFundingTime?: number;
};

export type RealTradingMarketDefinition = {
  symbol: string;
  providerMarketId: string;
  providerCoin: string;
  sourceDex: string;
  sourceType: RealTradingMarketSourceType;
  category: RealTradingMarketCategory;
  assetId: number;
  universeIndex: number;
  universeItem: HyperliquidUniverseItem;
  context: HyperliquidAssetContext;
};

export type RealTradingMarketCatalog = {
  markets: RealTradingMarketDefinition[];
  bySymbol: Map<string, RealTradingMarketDefinition>;
  byProviderMarketId: Map<string, RealTradingMarketDefinition>;
};

export type RealTradingSymbol = {
  symbol: string;
  providerMarketId: string;
  providerCoin: string;
  sourceDex: string;
  sourceType: RealTradingMarketSourceType;
  category: RealTradingMarketCategory;
  iconUrl: string | null;
  assetId: number;
  szDecimals: number;
  pxDecimals: number;
  maxLeverage: number;
  supportedMarginModes: Array<"cross" | "isolated">;
  marginModeConstraint: "cross_and_isolated" | "isolated_only";
  status: RealTradingMarketStatus;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingMarketSummary = {
  symbol: string;
  providerCoin: string;
  markPrice: number | null;
  oraclePrice: number | null;
  midPrice: number | null;
  previousDayPrice: number | null;
  dayChange: number | null;
  dayChangePercent: number | null;
  dayNotionalVolume: number | null;
  openInterest: number | null;
  funding: number | null;
  nextFundingTime: number | null;
  status: "connected" | "unavailable";
  timestamp: number;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingOrderbookLevel = {
  price: number;
  size: number;
  cumulativeSize: number;
  total: number;
  orderCount: number | null;
};

export type RealTradingOrderbook = {
  symbol: string;
  providerCoin: string;
  bids: RealTradingOrderbookLevel[];
  asks: RealTradingOrderbookLevel[];
  timestamp: number;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingTrade = {
  symbol: string;
  providerCoin: string;
  price: number;
  size: number;
  side: "buy" | "sell" | "unknown";
  timestamp: number;
  tradeId?: string | null;
  txHash?: string | null;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingCandle = {
  symbol: string;
  providerCoin: string;
  interval: CandleInterval;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingSpotBalance = {
  coin: string;
  total: number | null;
  hold: number | null;
  available: number | null;
};

export type RealTradingAccountSummary = {
  address: string;
  accountValue: number | null;
  withdrawable: number | null;
  usedMargin: number | null;
  availableMargin: number | null;
  totalUnrealizedPnl: number | null;
  crossAccountValue: number | null;
  crossMaintenanceMarginUsed: number | null;
  crossTotalMarginUsed: number | null;
  crossTotalNotionalPosition: number | null;
  crossMarginRatio: number | null;
  isolatedAccountValue: number | null;
  spotUsdcBalance: number | null;
  spotBalances: RealTradingSpotBalance[];
  timestamp: number;
  status: "connected" | "stale" | "unavailable";
  network: HyperliquidRealTradingNetwork;
  warnings?: string[];
};

export type RealTradingPosition = {
  coin: string;
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number | null;
  entryPx: number | null;
  markPrice: number | null;
  markPx: number | null;
  liquidationPrice: number | null;
  liqPx: number | null;
  positionValue: number | null;
  returnOnEquity: number | null;
  margin: number | null;
  marginMode: "cross" | "isolated" | null;
  leverage: number | null;
  maxLeverage: number | null;
  unrealizedPnl: number | null;
  fundingAllTime: number | null;
  fundingSinceChange: number | null;
  fundingSinceOpen: number | null;
  cumFunding: {
    allTime: number | null;
    sinceChange: number | null;
    sinceOpen: number | null;
  };
  rawStatus?: string | null;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingOpenOrder = {
  coin: string | null;
  symbol: string | null;
  side: "buy" | "sell" | "unknown";
  price: number | null;
  size: number | null;
  timestamp: number | null;
  status: string | null;
  limitPx: number | null;
  sz: number | null;
  oid: number | string | null;
  cloid: string | null;
  reduceOnly: boolean | null;
  isPositionTpsl: boolean | null;
  isTrigger: boolean | null;
  orderType: string | null;
  origSz: number | null;
  triggerCondition: string | null;
  triggerPx: number | null;
  raw?: unknown;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingHistoricalOrder = RealTradingOpenOrder & {
  statusTimestamp: number | null;
};

export type RealTradingFill = {
  coin: string | null;
  symbol: string | null;
  side: "buy" | "sell" | "unknown";
  price: number | null;
  size: number | null;
  timestamp: number | null;
  fee: number | null;
  feeToken: string | null;
  hash: string | null;
  direction: string | null;
  raw?: unknown;
  network: HyperliquidRealTradingNetwork;
};

export type RealTradingOrderHistory = {
  orders: RealTradingHistoricalOrder[];
  fills: RealTradingFill[];
  nextCursor: null;
  warnings: string[];
};

export type RealTradingFees = {
  makerRate: number | null;
  takerRate: number | null;
  spotMakerRate: number | null;
  spotTakerRate: number | null;
  activeReferralDiscount: number | null;
  activeStakingDiscount: number | null;
  timestamp: number;
  network: HyperliquidRealTradingNetwork;
  warnings?: string[];
};

export type RealTradingExchangeRequest = {
  masterAddress: string;
  network: HyperliquidRealTradingNetwork;
  action: Record<string, unknown>;
  nonce: number;
  signature: unknown;
  vaultAddress?: string | null;
  expiresAfter?: number | null;
};

export type RealTradingExchangeReceipt = {
  ok: boolean;
  network: HyperliquidRealTradingNetwork;
  result?: unknown;
  message?: string;
  status?: number;
  timestamp: number;
  requestId: string;
  actionType: string;
  submittedAt: number;
  accepted: boolean;
  rejected: boolean;
  outcome: "accepted" | "rejected" | "partial" | "pending_reconciliation";
  needsReconciliation: boolean;
  orderStatuses?: Array<{
    index: number;
    status: "accepted" | "rejected";
    providerStatus: "resting" | "filled" | "error" | "unknown";
    oid: string | number | null;
    message: string | null;
  }>;
};

export type RealTradingOrderConnectionStatus = "connected" | "stale" | "reconnecting";

export type RealTradingOrderSnapshot = {
  mode: "snapshot";
  sequence: number;
  timestamp: number;
  status: RealTradingOrderConnectionStatus;
  stale: boolean;
  reconnecting: boolean;
  authoritative: true;
  openOrders: RealTradingOpenOrder[];
  orders: RealTradingHistoricalOrder[];
  fills: RealTradingFill[];
  warnings: string[];
};

export type RealTradingOrderIncremental = {
  mode: "incremental";
  baseSequence: number;
  sequence: number;
  timestamp: number;
  status: RealTradingOrderConnectionStatus;
  stale: false;
  reconnecting: false;
  authoritative: true;
  openOrders: {
    upserted: RealTradingOpenOrder[];
    removedOrderIds: string[];
  };
  terminalOrders: RealTradingHistoricalOrder[];
  fills: RealTradingFill[];
  warnings: string[];
};

export type RealTradingOrderState = RealTradingOrderSnapshot | RealTradingOrderIncremental;

export type RealTradingCloidStatus = {
  authoritative: true;
  cloid: string;
  network: HyperliquidRealTradingNetwork;
  order: RealTradingHistoricalOrder | null;
  status: "order" | "unknown";
  timestamp: number;
};
