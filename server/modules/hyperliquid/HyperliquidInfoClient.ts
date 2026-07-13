import type { CandleInterval } from "../../types";
import { normalizeInterval, normalizeLimit, normalizeSymbol } from "../market/marketConfig";
import { hyperliquidTestnetNetwork } from "./hyperliquidConfig";
import type {
  RealTradingAccountSummary,
  RealTradingCandle,
  RealTradingFees,
  RealTradingFill,
  RealTradingHistoricalOrder,
  RealTradingMarketSummary,
  RealTradingOpenOrder,
  RealTradingOrderbook,
  RealTradingPosition,
  RealTradingSpotBalance,
  RealTradingSymbol,
  RealTradingTrade,
} from "./hyperliquidTypes";

const requestTimeoutMs = 15_000;
const hyperliquidIconBaseUrl = "https://app.hyperliquid.xyz/coins";

type HyperliquidUniverseItem = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
  marginMode?: "strictIsolated" | "noCross" | "normal";
  onlyIsolated?: boolean;
};

type HyperliquidAssetContext = {
  markPx?: string;
  oraclePx?: string;
  midPx?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  openInterest?: string;
  funding?: string;
  nextFundingTime?: number;
};

type HyperliquidBookLevel = {
  px: string | number;
  sz: string | number;
  n?: number;
};

type HyperliquidCandle = {
  T: number;
  c: string | number;
  h: string | number;
  i: string;
  l: string | number;
  n: number;
  o: string | number;
  s: string;
  t: number;
  v: string | number;
};

export class HyperliquidInfoClient {
  constructor(private baseUrl: string) {}

  async getSymbols(): Promise<RealTradingSymbol[]> {
    const { universe, contexts } = await this.getMetaAndContexts();
    return universe.map((item, index) => {
      const marginCapabilities = normalizeSymbolMarginCapabilities(item);
      return {
        symbol: toInternalSymbol(item.name),
        providerCoin: item.name,
        iconUrl: buildHyperliquidIconUrl(item.name),
        assetId: index,
        szDecimals: Number(item.szDecimals ?? 0),
        pxDecimals: inferPriceDecimals(contexts[index]),
        maxLeverage: Number(item.maxLeverage ?? 1),
        supportedMarginModes: marginCapabilities.supportedMarginModes,
        marginModeConstraint: marginCapabilities.marginModeConstraint,
        status: item.isDelisted ? "delisted" : "active",
        network: hyperliquidTestnetNetwork,
      };
    });
  }

  async getSummary(symbolInput: string): Promise<RealTradingMarketSummary> {
    const symbol = normalizeSymbol(symbolInput);
    const coin = toProviderCoin(symbol);
    const { universe, contexts } = await this.getMetaAndContexts();
    const index = universe.findIndex((item) => item.name === coin);
    if (index < 0) {
      throw new Error(`真实交易品种 ${symbol} 不存在。`);
    }
    return normalizeMarketSummary(symbol, coin, contexts[index] ?? {});
  }

  async getOrderbook(symbolInput: string): Promise<RealTradingOrderbook> {
    const symbol = normalizeSymbol(symbolInput);
    const coin = toProviderCoin(symbol);
    const payload = await this.postInfo({ type: "l2Book", coin });
    const levels = Array.isArray(payload?.levels) ? payload.levels : [];
    const bids = normalizeBookSide(Array.isArray(levels[0]) ? levels[0] : [], "desc");
    const asks = normalizeBookSide(Array.isArray(levels[1]) ? levels[1] : [], "asc");
    return {
      symbol,
      providerCoin: coin,
      bids,
      asks,
      timestamp: Number(payload?.time ?? Date.now()),
      network: hyperliquidTestnetNetwork,
    };
  }

  async getTrades(symbolInput: string): Promise<RealTradingTrade[]> {
    const symbol = normalizeSymbol(symbolInput);
    const coin = toProviderCoin(symbol);
    const payload = await this.postInfo({ type: "recentTrades", coin });
    if (!Array.isArray(payload)) {
      throw new Error("Hyperliquid recentTrades returned an invalid payload.");
    }
    return payload.map((trade): RealTradingTrade => ({
      symbol,
      providerCoin: coin,
      price: Number(trade.px ?? trade.price ?? 0),
      size: Number(trade.sz ?? trade.size ?? 0),
      side: normalizeTradeSide(trade.side),
      timestamp: Number(trade.time ?? trade.timestamp ?? Date.now()),
      tradeId: trade.tid !== undefined ? String(trade.tid) : null,
      txHash: trade.hash !== undefined ? String(trade.hash) : null,
      network: hyperliquidTestnetNetwork,
    }));
  }

  async getCandles(symbolInput: string, intervalInput: string, limitInput: unknown): Promise<RealTradingCandle[]> {
    const symbol = normalizeSymbol(symbolInput);
    const coin = toProviderCoin(symbol);
    const interval = normalizeInterval(intervalInput);
    const limit = normalizeLimit(limitInput);
    const endTime = Date.now();
    const startTime = endTime - intervalDurationMs(interval) * (limit + 2);
    const payload = await this.postInfo({
      type: "candleSnapshot",
      req: { coin, interval, startTime, endTime },
    });
    if (!Array.isArray(payload)) {
      throw new Error("Hyperliquid candleSnapshot returned an invalid payload.");
    }
    return payload
      .map((row) => normalizeCandle(row as HyperliquidCandle, symbol, coin, interval))
      .filter((candle): candle is RealTradingCandle => candle !== null)
      .sort((left, right) => left.time - right.time)
      .slice(-limit);
  }

  async getAccountSummary(address: string): Promise<RealTradingAccountSummary> {
    const normalizedAddress = normalizeAddress(address);
    const [state, spotResult] = await Promise.all([
      this.getClearinghouseState(normalizedAddress),
      this.getSpotClearinghouseState(normalizedAddress)
        .then((payload) => ({ ok: true as const, payload }))
        .catch((error) => ({ ok: false as const, warning: `spotClearinghouseState unavailable: ${sanitizeError(error)}` })),
    ]);
    return normalizeAccountSummary(normalizedAddress, state, spotResult);
  }

  async getPositions(address: string): Promise<RealTradingPosition[]> {
    const normalizedAddress = normalizeAddress(address);
    const [state, marketContextsResult] = await Promise.all([
      this.getClearinghouseState(normalizedAddress),
      this.getMetaAndContexts()
        .then(({ universe, contexts }) => ({ ok: true as const, value: buildMarketContextsByCoin(universe, contexts) }))
        .catch(() => ({ ok: false as const, value: new Map<string, HyperliquidAssetContext>() })),
    ]);
    return normalizePositions(state.assetPositions, marketContextsResult.value);
  }

  async getOpenOrders(address: string): Promise<RealTradingOpenOrder[]> {
    const user = normalizeAddress(address);
    const payload = await this.postInfo({ type: "frontendOpenOrders", user }).catch(() => this.postInfo({ type: "openOrders", user }));
    if (!Array.isArray(payload)) {
      throw new Error("Hyperliquid open orders returned an invalid payload.");
    }
    return payload.map(normalizeOpenOrder);
  }

  async getOrderHistory(address: string) {
    const user = normalizeAddress(address);
    const [orders, fills] = await Promise.all([
      this.postInfo({ type: "historicalOrders", user }).catch((error) => ({ error: sanitizeError(error) })),
      this.postInfo({ type: "userFills", user }).catch((error) => ({ error: sanitizeError(error) })),
    ]);
    return {
      orders: Array.isArray(orders) ? orders.map(normalizeHistoricalOrder) : [],
      fills: Array.isArray(fills) ? fills.map(normalizeFill) : [],
      nextCursor: null,
      warnings: [
        !Array.isArray(orders) && "historicalOrders unavailable",
        !Array.isArray(fills) && "userFills unavailable",
      ].filter(Boolean),
    };
  }

  async getFees(address: string): Promise<RealTradingFees> {
    const user = normalizeAddress(address);
    try {
      const payload = await this.postInfo({ type: "userFees", user });
      return normalizeFees(payload);
    } catch (error) {
      return {
        makerRate: null,
        takerRate: null,
        spotMakerRate: null,
        spotTakerRate: null,
        activeReferralDiscount: null,
        activeStakingDiscount: null,
        timestamp: Date.now(),
        network: hyperliquidTestnetNetwork,
        warnings: [`userFees unavailable: ${sanitizeError(error)}`],
      };
    }
  }

  private async getMetaAndContexts() {
    const payload = await this.postInfo({ type: "metaAndAssetCtxs" });
    if (!Array.isArray(payload) || !payload[0] || !Array.isArray(payload[0].universe) || !Array.isArray(payload[1])) {
      throw new Error("Hyperliquid metaAndAssetCtxs returned an invalid payload.");
    }
    return {
      universe: payload[0].universe as HyperliquidUniverseItem[],
      contexts: payload[1] as HyperliquidAssetContext[],
    };
  }

  private async getClearinghouseState(address: string) {
    return this.postInfo({ type: "clearinghouseState", user: address });
  }

  private async getSpotClearinghouseState(address: string) {
    return this.postInfo({ type: "spotClearinghouseState", user: address });
  }

  private async postInfo(body: unknown) {
    const response = await fetch(new URL("/info", this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`Hyperliquid testnet info request failed: ${response.status}${detail ? ` - ${detail}` : ""}`);
    }
    return response.json() as Promise<any>;
  }
}

export function normalizeRealTradingSymbol(value: unknown) {
  return normalizeSymbol(String(value ?? "BTCUSDT"));
}

export function normalizeAddress(value: unknown) {
  const address = String(value ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("请输入有效的 Hyperliquid 账户地址。");
  }
  return address;
}

export function normalizeMarketSummary(symbol: string, providerCoin: string, context: HyperliquidAssetContext): RealTradingMarketSummary {
  const markPrice = toNullableNumber(context.markPx);
  const previousDayPrice = toNullableNumber(context.prevDayPx);
  const dayChange = markPrice !== null && previousDayPrice !== null ? markPrice - previousDayPrice : null;
  const dayChangePercent = dayChange !== null && previousDayPrice !== null && previousDayPrice !== 0
    ? (dayChange / previousDayPrice) * 100
    : null;
  return {
    symbol,
    providerCoin,
    markPrice,
    oraclePrice: toNullableNumber(context.oraclePx),
    midPrice: toNullableNumber(context.midPx),
    previousDayPrice,
    dayChange,
    dayChangePercent,
    dayNotionalVolume: toNullableNumber(context.dayNtlVlm),
    openInterest: toNullableNumber(context.openInterest),
    funding: toNullableNumber(context.funding),
    nextFundingTime: typeof context.nextFundingTime === "number" ? context.nextFundingTime : null,
    status: "connected",
    timestamp: Date.now(),
    network: hyperliquidTestnetNetwork,
  };
}

export function normalizeBookSide(levels: HyperliquidBookLevel[], direction: "asc" | "desc") {
  let cumulativeSize = 0;
  return levels
    .map((level) => ({
      price: toRequiredNumber(level.px),
      size: toRequiredNumber(level.sz),
      orderCount: typeof level.n === "number" ? level.n : null,
    }))
    .filter((level) => level.price !== null && level.size !== null)
    .sort((left, right) => direction === "asc" ? left.price! - right.price! : right.price! - left.price!)
    .map((level) => {
      cumulativeSize += level.size!;
      return { price: level.price!, size: level.size!, orderCount: level.orderCount, cumulativeSize, total: cumulativeSize };
    });
}

export function normalizePositions(value: unknown, marketContextsByCoin = new Map<string, HyperliquidAssetContext>()): RealTradingPosition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const position = entry?.position ?? {};
    const size = toNullableNumber(position.szi);
    if (size === null || size === 0) return [];
    const coin = String(position.coin ?? "");
    const entryPx = toNullableNumber(position.entryPx);
    const rawMarkPx = toNullablePositiveNumber(position.markPx);
    const contextMarkPx = toNullablePositiveNumber(getMarketContextForCoin(marketContextsByCoin, coin)?.markPx);
    const markPx = rawMarkPx ?? contextMarkPx;
    const liqPx = toNullableNumber(position.liquidationPx);
    const margin = toNullableNumber(position.marginUsed ?? position.positionValue);
    const positionValue = toNullableNumber(position.positionValue);
    const fundingAllTime = toNullableNumber(position.cumFunding?.allTime);
    const fundingSinceChange = toNullableNumber(position.cumFunding?.sinceChange);
    const fundingSinceOpen = toNullableNumber(position.cumFunding?.sinceOpen);
    const leverage = toNullableNumber(position.leverage?.value ?? position.leverage);
    return [{
      coin,
      symbol: toInternalSymbol(coin),
      side: size >= 0 ? "long" : "short",
      size: Math.abs(size),
      entryPrice: entryPx,
      entryPx,
      markPrice: markPx,
      markPx,
      liquidationPrice: liqPx,
      liqPx,
      positionValue,
      returnOnEquity: toNullableNumber(position.returnOnEquity ?? position.roe),
      margin,
      marginMode: normalizePositionMarginMode(position.leverage?.type),
      leverage,
      maxLeverage: toNullableNumber(position.maxLeverage),
      unrealizedPnl: toNullableNumber(position.unrealizedPnl),
      fundingAllTime,
      fundingSinceChange,
      fundingSinceOpen,
      cumFunding: {
        allTime: fundingAllTime,
        sinceChange: fundingSinceChange,
        sinceOpen: fundingSinceOpen,
      },
      rawStatus: typeof position.status === "string" ? position.status : null,
      network: hyperliquidTestnetNetwork,
    }];
  });
}

export function normalizeOpenOrder(row: unknown): RealTradingOpenOrder {
  const value = row && typeof row === "object" ? row as Record<string, any> : {};
  const coin = value.coin !== undefined ? String(value.coin) : null;
  const side = normalizeOrderSide(value.side ?? value.isBuy);
  const price = toNullableNumber(value.price ?? value.limitPx);
  const size = toNullableNumber(value.size ?? value.sz);
  return {
    coin,
    symbol: coin ? toInternalSymbol(coin) : null,
    side,
    price,
    size,
    timestamp: toNullableNumber(value.timestamp ?? value.time),
    status: value.status !== undefined ? String(value.status) : null,
    limitPx: toNullableNumber(value.limitPx ?? value.price),
    sz: toNullableNumber(value.sz ?? value.size),
    oid: normalizeOptionalId(value.oid),
    cloid: value.cloid !== undefined && value.cloid !== null ? String(value.cloid) : null,
    reduceOnly: toNullableBoolean(value.reduceOnly),
    isPositionTpsl: toNullableBoolean(value.isPositionTpsl),
    isTrigger: toNullableBoolean(value.isTrigger),
    orderType: value.orderType !== undefined && value.orderType !== null ? String(value.orderType) : null,
    origSz: toNullableNumber(value.origSz),
    triggerCondition: value.triggerCondition !== undefined && value.triggerCondition !== null ? String(value.triggerCondition) : null,
    triggerPx: toNullableNumber(value.triggerPx),
    raw: value,
    network: hyperliquidTestnetNetwork,
  };
}

export function normalizeHistoricalOrder(row: unknown): RealTradingHistoricalOrder {
  const value = row && typeof row === "object" ? row as Record<string, any> : {};
  const order = value.order && typeof value.order === "object" ? value.order : value;
  const normalized = normalizeOpenOrder({
    ...order,
    status: value.status ?? order.status,
    statusTimestamp: value.statusTimestamp ?? order.statusTimestamp,
  });
  return {
    ...normalized,
    statusTimestamp: toNullableNumber(value.statusTimestamp ?? order.statusTimestamp),
    raw: value,
  };
}

export function normalizeFill(row: unknown): RealTradingFill {
  const value = row && typeof row === "object" ? row as Record<string, any> : {};
  const coin = value.coin !== undefined ? String(value.coin) : null;
  return {
    coin,
    symbol: coin ? toInternalSymbol(coin) : null,
    side: normalizeTradeSide(value.side),
    price: toNullableNumber(value.px ?? value.price),
    size: toNullableNumber(value.sz ?? value.size),
    timestamp: toNullableNumber(value.time ?? value.timestamp),
    fee: toNullableNumber(value.fee),
    feeToken: value.feeToken !== undefined && value.feeToken !== null ? String(value.feeToken) : null,
    hash: value.hash !== undefined && value.hash !== null ? String(value.hash) : null,
    direction: value.dir !== undefined && value.dir !== null ? String(value.dir) : value.direction !== undefined && value.direction !== null ? String(value.direction) : null,
    raw: value,
    network: hyperliquidTestnetNetwork,
  };
}

export function normalizeSpotBalances(payload: unknown): RealTradingSpotBalance[] {
  const balances = Array.isArray((payload as any)?.balances) ? (payload as any).balances : [];
  return balances.map((row: any): RealTradingSpotBalance => {
    const coin = String(row.coin ?? row.token ?? "");
    const total = toNullableNumber(row.total);
    const hold = toNullableNumber(row.hold);
    return {
      coin,
      total,
      hold,
      available: total !== null && hold !== null ? total - hold : null,
    };
  }).filter((balance: RealTradingSpotBalance) => balance.coin.length > 0);
}

export function normalizeFees(payload: unknown): RealTradingFees {
  const value = payload && typeof payload === "object" ? payload as Record<string, any> : {};
  const activeReferralDiscount = value.activeReferralDiscount !== undefined
    ? toNullableNumber(value.activeReferralDiscount)
    : toNullableBoolean(value.activeReferralDiscountBps) === false
      ? null
      : toNullableNumber(value.activeReferralDiscountBps);
  return {
    makerRate: toNullableNumber(value.userAddRate ?? value.makerRate),
    takerRate: toNullableNumber(value.userCrossRate ?? value.takerRate),
    spotMakerRate: toNullableNumber(value.spotAddRate ?? value.spotMakerRate),
    spotTakerRate: toNullableNumber(value.spotCrossRate ?? value.spotTakerRate),
    activeReferralDiscount,
    activeStakingDiscount: toNullableNumber(value.activeStakingDiscount ?? value.activeStakingDiscountBps),
    timestamp: Date.now(),
    network: hyperliquidTestnetNetwork,
  };
}

function normalizeAccountSummary(
  normalizedAddress: string,
  state: any,
  spotResult: { ok: true; payload: unknown } | { ok: false; warning: string },
): RealTradingAccountSummary {
  const marginSummary = state.marginSummary ?? {};
  const crossSummary = state.crossMarginSummary ?? {};
  const positions = normalizePositions(state.assetPositions);
  const totalUnrealizedPnl = positions.reduce((sum, position) => sum + (position.unrealizedPnl ?? 0), 0);
  const accountValue = toNullableNumber(marginSummary.accountValue);
  const usedMargin = toNullableNumber(marginSummary.totalMarginUsed);
  const crossAccountValue = toNullableNumber(crossSummary.accountValue);
  const crossMaintenanceMarginUsed = toNullableNumber(state.crossMaintenanceMarginUsed);
  const spotBalances = spotResult.ok ? normalizeSpotBalances(spotResult.payload) : [];
  const spotUsdcBalance = spotBalances.find((balance) => balance.coin.toUpperCase() === "USDC")?.total ?? null;
  return {
    address: normalizedAddress,
    accountValue,
    withdrawable: toNullableNumber(state.withdrawable),
    usedMargin,
    availableMargin: accountValue !== null && usedMargin !== null ? Math.max(0, accountValue - usedMargin) : null,
    totalUnrealizedPnl,
    crossAccountValue,
    crossMaintenanceMarginUsed,
    crossTotalMarginUsed: toNullableNumber(crossSummary.totalMarginUsed),
    crossTotalNotionalPosition: toNullableNumber(crossSummary.totalNtlPos),
    crossMarginRatio: crossMaintenanceMarginUsed !== null && crossAccountValue !== null && crossAccountValue > 0
      ? crossMaintenanceMarginUsed / crossAccountValue
      : null,
    isolatedAccountValue: null,
    spotUsdcBalance,
    spotBalances,
    timestamp: Date.now(),
    network: hyperliquidTestnetNetwork,
    warnings: spotResult.ok ? [] : [spotResult.warning],
  };
}

function toInternalSymbol(providerCoin: string) {
  return `${providerCoin.toUpperCase()}USDT`;
}

function toProviderCoin(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  return normalized.endsWith("USDT") ? normalized.slice(0, -4) : normalized;
}

function buildHyperliquidIconUrl(providerCoin: string) {
  const coin = String(providerCoin ?? "").trim();
  return /^[A-Za-z0-9:_-]+$/.test(coin) ? `${hyperliquidIconBaseUrl}/${encodeURIComponent(coin)}.svg` : null;
}

export function normalizeSymbolMarginCapabilities(item: { marginMode?: unknown; onlyIsolated?: unknown }) {
  const isolatedOnly = item.marginMode === "strictIsolated" || item.marginMode === "noCross" || item.onlyIsolated === true;
  return isolatedOnly
    ? {
      supportedMarginModes: ["isolated"] as Array<"cross" | "isolated">,
      marginModeConstraint: "isolated_only" as const,
    }
    : {
      supportedMarginModes: ["cross", "isolated"] as Array<"cross" | "isolated">,
      marginModeConstraint: "cross_and_isolated" as const,
    };
}

function normalizePositionMarginMode(value: unknown) {
  const normalized = typeof value === "string" ? value.toLowerCase() : value;
  if (normalized === "cross") return "cross";
  if (normalized === "isolated") return "isolated";
  return null;
}

function buildMarketContextsByCoin(universe: HyperliquidUniverseItem[], contexts: HyperliquidAssetContext[]) {
  const map = new Map<string, HyperliquidAssetContext>();
  universe.forEach((item, index) => {
    const coin = String(item.name ?? "").trim();
    const context = contexts[index];
    if (coin && context) {
      map.set(coin, context);
      map.set(coin.toUpperCase(), context);
    }
  });
  return map;
}

function getMarketContextForCoin(marketContextsByCoin: Map<string, HyperliquidAssetContext>, coin: string) {
  return marketContextsByCoin.get(coin) ?? marketContextsByCoin.get(coin.toUpperCase());
}

function inferPriceDecimals(context?: HyperliquidAssetContext) {
  const values = [context?.markPx, context?.oraclePx, context?.midPx].filter((value): value is string => typeof value === "string");
  const decimals = values.map((value) => value.split(".")[1]?.length ?? 0);
  return Math.max(0, Math.min(8, ...decimals, 2));
}

function toNullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toNullablePositiveNumber(value: unknown) {
  const number = toNullableNumber(value);
  return number !== null && number > 0 ? number : null;
}

function toRequiredNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toNullableBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function normalizeOptionalId(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function normalizeTradeSide(value: unknown) {
  const side = typeof value === "string" ? value.toLowerCase() : value;
  if (side === "b" || side === "buy") return "buy";
  if (side === "a" || side === "sell") return "sell";
  return "unknown";
}

function normalizeOrderSide(value: unknown) {
  const side = typeof value === "string" ? value.toLowerCase() : value;
  if (side === true || side === "b" || side === "buy") return "buy";
  if (side === false || side === "a" || side === "sell") return "sell";
  return "unknown";
}

function normalizeCandle(row: HyperliquidCandle, symbol: string, providerCoin: string, interval: CandleInterval): RealTradingCandle | null {
  const open = Number(row.o);
  const high = Number(row.h);
  const low = Number(row.l);
  const close = Number(row.c);
  const volume = Number(row.v);
  const time = Math.floor(Number(row.t) / 1000);
  if (![open, high, low, close, volume, time].every(Number.isFinite)) {
    return null;
  }
  return { symbol, providerCoin, interval, time, open, high, low, close, volume, network: hyperliquidTestnetNetwork };
}

function intervalDurationMs(interval: CandleInterval) {
  const unit = interval.at(-1);
  const value = Number(interval.slice(0, -1));
  if (unit === "m") return value * 60_000;
  if (unit === "h") return value * 60 * 60_000;
  if (unit === "d") return value * 24 * 60 * 60_000;
  if (unit === "w") return value * 7 * 24 * 60 * 60_000;
  return 30 * 24 * 60 * 60_000;
}

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message : "request failed";
}
