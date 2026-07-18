import type { CandleInterval } from "../../types";
import { normalizeInterval, normalizeLimit } from "../market/marketConfig";
import { hyperliquidTestnetNetwork } from "./hyperliquidConfig";
import {
  getHyperliquidPerpDisplayPriceDecimals,
  normalizeHyperliquidPerpSzDecimals,
} from "./hyperliquidPrecision";
import type {
  HyperliquidAssetContext,
  HyperliquidUniverseItem,
  HyperliquidUniverseItemPayload,
  RealTradingAccountSummary,
  RealTradingCandle,
  RealTradingFees,
  RealTradingFill,
  RealTradingHistoricalOrder,
  RealTradingMarketCatalog,
  RealTradingMarketDefinition,
  RealTradingMarketSummary,
  RealTradingOpenOrder,
  RealTradingOrderbook,
  RealTradingPosition,
  RealTradingSpotBalance,
  RealTradingSymbol,
  RealTradingMarketCategory,
  RealTradingTrade,
} from "./hyperliquidTypes";

const requestTimeoutMs = 15_000;
const hyperliquidTestnetIconBaseUrl = "https://app.hyperliquid-testnet.xyz/coins";
const categoryCacheTtlMs = 5 * 60_000;
const marketCatalogCacheTtlMs = 5 * 60_000;
const hip3OrderbookValidationConcurrency = 4;
const metalProviderCoins = new Set(["GOLD", "SILVER", "PLATINUM", "PALLADIUM"]);
const defaultTrustedHyperliquidTestnetHip3Dexes = ["xyz"];
const indexProviderCoins = new Set(["SPX", "SPY", "NDX", "NASDAQ", "QQQ", "DOW", "DJI", "IWM", "RUT", "VIX"]);

export const trustedHyperliquidTestnetHip3Dexes = parseTrustedHyperliquidTestnetHip3Dexes();

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
  private categoryCache: { expiresAt: number; value: Map<string, RealTradingMarketCategory> } | null = null;
  private categoryRequest: Promise<Map<string, RealTradingMarketCategory>> | null = null;
  private marketCatalogCache: { expiresAt: number; value: RealTradingMarketCatalog } | null = null;
  private marketCatalogRequest: Promise<RealTradingMarketCatalog> | null = null;

  constructor(private baseUrl: string) {}

  async getSymbols(): Promise<RealTradingSymbol[]> {
    const catalog = await this.getMarketCatalog();
    return catalog.markets.map((market) => {
      const item = market.universeItem;
      const marginCapabilities = normalizeSymbolMarginCapabilities(item);
      return {
        symbol: market.symbol,
        providerMarketId: market.providerMarketId,
        providerCoin: market.providerCoin,
        sourceDex: market.sourceDex,
        sourceType: market.sourceType,
        category: market.category,
        iconUrl: buildRealTradingIconUrl(market.providerMarketId),
        assetId: market.assetId,
        szDecimals: item.szDecimals,
        pxDecimals: getHyperliquidPerpDisplayPriceDecimals(item.szDecimals),
        maxLeverage: Number(item.maxLeverage ?? 1),
        supportedMarginModes: marginCapabilities.supportedMarginModes,
        marginModeConstraint: marginCapabilities.marginModeConstraint,
        status: "active",
        network: hyperliquidTestnetNetwork,
      };
    });
  }

  async getSummary(symbolInput: string): Promise<RealTradingMarketSummary> {
    const market = await this.resolveMarket(symbolInput);
    // Catalog metadata may be cached, but risk decisions require a newly collected context.
    const fresh = await this.getMetaAndContexts(market.sourceType === "hip3" ? market.sourceDex : undefined);
    const context = fresh.contexts[market.universeIndex];
    if (!context) throw new Error("Hyperliquid market context is unavailable.");
    return normalizeMarketSummary(market.symbol, market.providerCoin, context);
  }

  async getOrderbook(symbolInput: string): Promise<RealTradingOrderbook> {
    const market = await this.resolveMarket(symbolInput);
    const payload = await this.postInfo({ type: "l2Book", coin: market.providerMarketId });
    const levels = Array.isArray(payload?.levels) ? payload.levels : [];
    const bids = normalizeBookSide(Array.isArray(levels[0]) ? levels[0] : [], "desc");
    const asks = normalizeBookSide(Array.isArray(levels[1]) ? levels[1] : [], "asc");
    return {
      symbol: market.symbol,
      providerCoin: market.providerCoin,
      bids,
      asks,
      timestamp: Number(payload?.time ?? Date.now()),
      network: hyperliquidTestnetNetwork,
    };
  }

  async getTrades(symbolInput: string): Promise<RealTradingTrade[]> {
    const market = await this.resolveMarket(symbolInput);
    const payload = await this.postInfo({ type: "recentTrades", coin: market.providerMarketId });
    if (!Array.isArray(payload)) {
      throw new Error("Hyperliquid recentTrades returned an invalid payload.");
    }
    return payload.map((trade): RealTradingTrade => ({
      symbol: market.symbol,
      providerCoin: market.providerCoin,
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
    const market = await this.resolveMarket(symbolInput);
    const interval = normalizeInterval(intervalInput);
    const limit = normalizeLimit(limitInput);
    const endTime = Date.now();
    const startTime = endTime - intervalDurationMs(interval) * (limit + 2);
    const payload = await this.postInfo({
      type: "candleSnapshot",
      req: { coin: market.providerMarketId, interval, startTime, endTime },
    });
    if (!Array.isArray(payload)) {
      throw new Error("Hyperliquid candleSnapshot returned an invalid payload.");
    }
    return payload
      .map((row) => normalizeCandle(row as HyperliquidCandle, market.symbol, market.providerCoin, interval))
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

  async getOrderStatus(address: string, cloidInput: unknown) {
    const user = normalizeAddress(address);
    const cloid = normalizeCloid(cloidInput);
    const payload = await this.postInfo({ type: "orderStatus", user, oid: cloid });
    if (payload?.status === "unknownOid") {
      return {
        authoritative: true as const,
        cloid,
        network: hyperliquidTestnetNetwork,
        order: null,
        status: "unknown" as const,
        timestamp: Date.now(),
      };
    }
    if (payload?.status !== "order" || !payload.order) {
      throw new Error("Hyperliquid orderStatus returned an invalid payload.");
    }
    return {
      authoritative: true as const,
      cloid,
      network: hyperliquidTestnetNetwork,
      order: normalizeHistoricalOrder(payload.order),
      status: "order" as const,
      timestamp: Date.now(),
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

  async getUserRole(address: string): Promise<string> {
    const user = normalizeAddress(address);
    const payload = await this.postInfo({ type: "userRole", user });
    const role = String(payload?.role ?? "").trim().toLowerCase();
    if (!role) {
      throw new Error("Hyperliquid userRole returned an invalid payload.");
    }
    return role;
  }

  private async getMarketCatalog(): Promise<RealTradingMarketCatalog> {
    const now = Date.now();
    if (this.marketCatalogCache && this.marketCatalogCache.expiresAt > now) {
      return this.marketCatalogCache.value;
    }
    if (this.marketCatalogRequest) {
      return this.marketCatalogRequest;
    }
    this.marketCatalogRequest = this.fetchMarketCatalog()
      .then((value) => {
        this.marketCatalogCache = { expiresAt: Date.now() + marketCatalogCacheTtlMs, value };
        return value;
      })
      .finally(() => {
        this.marketCatalogRequest = null;
      });
    return this.marketCatalogRequest;
  }

  private async resolveMarket(symbolInput: string): Promise<RealTradingMarketDefinition> {
    const symbol = normalizeRealTradingSymbol(symbolInput);
    const catalog = await this.getMarketCatalog();
    const market = catalog.bySymbol.get(symbol);
    if (!market) {
      throw new Error(`真实交易品种 ${symbol} 不存在。`);
    }
    return market;
  }

  private async fetchMarketCatalog(): Promise<RealTradingMarketCatalog> {
    const [mainMarketData, categoryMap, perpDexs] = await Promise.all([
      this.getMetaAndContexts(),
      this.getPerpCategoryMap().catch(() => new Map<string, RealTradingMarketCategory>()),
      this.getPerpDexs().catch((error) => {
        console.warn(`[real-trading] Hyperliquid perpDexs discovery unavailable; HIP-3 markets skipped: ${sanitizeError(error)}`);
        return [];
      }),
    ]);
    const markets: RealTradingMarketDefinition[] = [];
    const bySymbol = new Map<string, RealTradingMarketDefinition>();
    const byProviderMarketId = new Map<string, RealTradingMarketDefinition>();

    const buildMarkets = (
      universe: HyperliquidUniverseItemPayload[],
      contexts: HyperliquidAssetContext[],
      sourceDex: string,
      sourceType: "main" | "hip3",
      perpDexIndex: number | null,
    ) => universe.flatMap((item, universeIndex): RealTradingMarketDefinition[] => {
        const context = contexts[universeIndex];
        const providerMarketId = String(item?.name ?? "").trim();
        if (
          item?.isDelisted
          || !context
          || !isValidProviderMarketId(providerMarketId, sourceDex, sourceType)
          || (sourceType === "main" && toNullablePositiveNumber(context.midPx) === null)
          || (sourceType === "hip3" && !hasReliableHip3Quote(context))
        ) {
          return [];
        }
        const szDecimals = normalizeHyperliquidPerpSzDecimals(item?.szDecimals);
        if (szDecimals === null) {
          console.warn(
            `[real-trading] Hyperliquid market ${providerMarketId || "<unknown>"} has invalid szDecimals metadata; skipped.`,
          );
          return [];
        }
        const providerCoin = getProviderCoinFromMarketId(providerMarketId);
        const symbol = toInternalMarketSymbol(providerCoin, sourceDex, sourceType);
        if (!symbol) return [];
        return [{
          symbol,
          providerMarketId,
          providerCoin,
          sourceDex,
          sourceType,
          category: resolveRealTradingSymbolCategory(providerMarketId, categoryMap),
          assetId: calculateHyperliquidAssetId(universeIndex, perpDexIndex),
          universeIndex,
          universeItem: { ...item, szDecimals },
          context,
        }];
      });

    const addMarkets = (candidates: RealTradingMarketDefinition[]) => {
      candidates.forEach((market) => {
        if (bySymbol.has(market.symbol) || byProviderMarketId.has(market.providerMarketId)) return;
        markets.push(market);
        bySymbol.set(market.symbol, market);
        byProviderMarketId.set(market.providerMarketId, market);
      });
    };

    addMarkets(buildMarkets(mainMarketData.universe, mainMarketData.contexts, "main", "main", null));

    for (const dex of perpDexs) {
      if (!trustedHyperliquidTestnetHip3Dexes.some((trustedDex) => trustedDex.toLowerCase() === dex.name.toLowerCase())) {
        continue;
      }
      try {
        const marketData = await this.getMetaAndContexts(dex.name);
        const hip3Candidates = buildMarkets(marketData.universe, marketData.contexts, dex.name, "hip3", dex.index);
        const tradableHip3Markets = await filterWithConcurrency(
          hip3Candidates,
          hip3OrderbookValidationConcurrency,
          (market) => this.hasTwoSidedOrderbook(market.providerMarketId),
        );
        addMarkets(tradableHip3Markets);
      } catch (error) {
        console.warn(`[real-trading] Hyperliquid HIP-3 DEX ${dex.name} unavailable; skipped: ${sanitizeError(error)}`);
      }
    }

    return { markets, bySymbol, byProviderMarketId };
  }

  private async hasTwoSidedOrderbook(providerMarketId: string) {
    try {
      const payload = await this.postInfo({ type: "l2Book", coin: providerMarketId });
      const levels = Array.isArray(payload?.levels) ? payload.levels : [];
      return Array.isArray(levels[0]) && levels[0].length > 0
        && Array.isArray(levels[1]) && levels[1].length > 0;
    } catch (error) {
      console.warn(`[real-trading] Hyperliquid HIP-3 market ${providerMarketId} orderbook unavailable; skipped: ${sanitizeError(error)}`);
      return false;
    }
  }

  private async getPerpDexs() {
    const payload = await this.postInfo({ type: "perpDexs" });
    if (!Array.isArray(payload)) {
      throw new Error("Hyperliquid perpDexs returned an invalid payload.");
    }
    return payload.flatMap((item, index) => {
      const name = item && typeof item === "object" ? String(item.name ?? "").trim() : "";
      const explicitIndex = item && typeof item === "object"
        ? Number((item as { index?: unknown; perpDexIndex?: unknown }).perpDexIndex ?? (item as { index?: unknown }).index)
        : NaN;
      const perpDexIndex = Number.isSafeInteger(explicitIndex) && explicitIndex >= 0 ? explicitIndex : index;
      return name ? [{ name, index: perpDexIndex }] : [];
    });
  }

  private async getMetaAndContexts(dex?: string) {
    const payload = await this.postInfo({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) });
    if (!Array.isArray(payload) || !payload[0] || !Array.isArray(payload[0].universe) || !Array.isArray(payload[1])) {
      throw new Error("Hyperliquid metaAndAssetCtxs returned an invalid payload.");
    }
    return {
      universe: payload[0].universe as HyperliquidUniverseItemPayload[],
      contexts: payload[1] as HyperliquidAssetContext[],
    };
  }

  private async getClearinghouseState(address: string) {
    return this.postInfo({ type: "clearinghouseState", user: address });
  }

  private async getSpotClearinghouseState(address: string) {
    return this.postInfo({ type: "spotClearinghouseState", user: address });
  }

  private async getPerpCategoryMap() {
    const now = Date.now();
    if (this.categoryCache && this.categoryCache.expiresAt > now) {
      return this.categoryCache.value;
    }
    if (this.categoryRequest) {
      return this.categoryRequest;
    }
    this.categoryRequest = this.fetchPerpCategoryMap()
      .then((value) => {
        this.categoryCache = { expiresAt: Date.now() + categoryCacheTtlMs, value };
        return value;
      })
      .finally(() => {
        this.categoryRequest = null;
      });
    return this.categoryRequest;
  }

  private async fetchPerpCategoryMap() {
    const [categories, conciseAnnotations] = await Promise.all([
      this.postInfo({ type: "perpCategories" }).catch(() => null),
      this.postInfo({ type: "perpConciseAnnotations" }).catch(() => null),
    ]);
    return buildRealTradingCategoryMap(categories, conciseAnnotations);
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
  const symbol = String(value ?? "BTCUSDT").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]*USDT$/.test(symbol)) {
    throw new Error(`真实交易品种 ${symbol || "(empty)"} 不合法。`);
  }
  return symbol;
}

export function normalizeAddress(value: unknown) {
  const address = String(value ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("请输入有效的 Hyperliquid 账户地址。");
  }
  return address;
}

export function normalizeCloid(value: unknown) {
  const cloid = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{32}$/.test(cloid)) throw new Error("请输入有效的 Hyperliquid cloid。");
  return cloid;
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
  const direction = value.dir !== undefined && value.dir !== null
    ? String(value.dir)
    : value.direction !== undefined && value.direction !== null ? String(value.direction) : null;
  return {
    coin,
    symbol: coin ? toInternalSymbol(coin) : null,
    side: normalizeTradeSide(value.side ?? value.crossed ?? direction),
    price: toNullableNumber(value.px ?? value.price),
    size: toNullableNumber(value.sz ?? value.size),
    timestamp: toNullableNumber(value.time ?? value.timestamp),
    oid: normalizeOptionalId(value.oid),
    tid: normalizeOptionalId(value.tid),
    closedPnl: toNullableNumber(value.closedPnl),
    fee: toNullableNumber(value.fee),
    feeToken: value.feeToken !== undefined && value.feeToken !== null ? String(value.feeToken) : null,
    hash: value.hash !== undefined && value.hash !== null ? String(value.hash) : null,
    direction,
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
    status: "connected",
    network: hyperliquidTestnetNetwork,
    warnings: spotResult.ok ? [] : [spotResult.warning],
  };
}

function toInternalSymbol(providerCoin: string) {
  const marketId = String(providerCoin ?? "").trim();
  const separatorIndex = marketId.indexOf(":");
  if (separatorIndex > 0) {
    return toInternalMarketSymbol(
      marketId.slice(separatorIndex + 1),
      marketId.slice(0, separatorIndex),
      "hip3",
    );
  }
  return toInternalMarketSymbol(marketId, "main", "main");
}

function toInternalMarketSymbol(providerCoin: string, sourceDex: string, sourceType: "main" | "hip3") {
  const coin = providerCoin.trim().toUpperCase();
  if (!coin) return "";
  return sourceType === "hip3"
    ? `${sourceDex.trim().toUpperCase()}-${coin}USDT`
    : `${coin}USDT`;
}

function hasReliableHip3Quote(context: HyperliquidAssetContext) {
  const markPrice = toNullablePositiveNumber(context.markPx);
  const midPrice = toNullablePositiveNumber(context.midPx);
  const oraclePrice = toNullablePositiveNumber(context.oraclePx);
  return markPrice !== null && (midPrice !== null || oraclePrice !== null);
}

function isValidProviderMarketId(providerMarketId: string, sourceDex: string, sourceType: "main" | "hip3") {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(providerMarketId)) return false;
  if (sourceType === "main") return !providerMarketId.includes(":");
  const separatorIndex = providerMarketId.indexOf(":");
  return separatorIndex > 0
    && providerMarketId.slice(0, separatorIndex).toLowerCase() === sourceDex.toLowerCase()
    && providerMarketId.slice(separatorIndex + 1).length > 0;
}

export function calculateHyperliquidAssetId(universeIndex: number, perpDexIndex: number | null) {
  if (!Number.isSafeInteger(universeIndex) || universeIndex < 0) {
    throw new Error("Hyperliquid universe index is invalid.");
  }
  if (perpDexIndex === null) return universeIndex;
  if (!Number.isSafeInteger(perpDexIndex) || perpDexIndex < 0) {
    throw new Error("Hyperliquid perpetual DEX index is invalid.");
  }
  return 100_000 + perpDexIndex * 10_000 + universeIndex;
}

function getProviderCoinFromMarketId(providerMarketId: string) {
  return providerMarketId.includes(":") ? providerMarketId.split(":").at(-1) ?? providerMarketId : providerMarketId;
}

async function filterWithConcurrency<T>(
  values: T[],
  concurrency: number,
  predicate: (value: T) => Promise<boolean>,
) {
  if (values.length === 0) return [];
  const accepted = new Array<boolean>(values.length).fill(false);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      accepted[currentIndex] = await predicate(values[currentIndex]);
    }
  }));
  return values.filter((_, index) => accepted[index]);
}

export function buildRealTradingIconUrl(providerMarketId: unknown) {
  const marketId = String(providerMarketId ?? "").trim();
  return /^[A-Za-z0-9:_-]+$/.test(marketId) ? `${hyperliquidTestnetIconBaseUrl}/${marketId}.svg` : null;
}

export function buildRealTradingCategoryMap(...payloads: unknown[]) {
  const map = new Map<string, RealTradingMarketCategory>();
  for (const payload of payloads) {
    if (!Array.isArray(payload)) continue;
    for (const row of payload) {
      if (!Array.isArray(row) || typeof row[0] !== "string") continue;
      const marketId = row[0].trim();
      if (!marketId) continue;
      const value = row[1];
      const rawCategory = typeof value === "string"
        ? value
        : value && typeof value === "object"
          ? (value as { category?: unknown }).category
          : undefined;
      const normalizedCategory = normalizeRealTradingMarketCategory(rawCategory, marketId);
      map.set(marketId, normalizedCategory);
      map.set(marketId.toUpperCase(), normalizedCategory);
    }
  }
  return map;
}

export function resolveRealTradingSymbolCategory(
  providerMarketId: unknown,
  categoryMap = new Map<string, RealTradingMarketCategory>(),
): RealTradingMarketCategory {
  const marketId = String(providerMarketId ?? "").trim();
  if (!marketId) return "other";
  return categoryMap.get(marketId)
    ?? categoryMap.get(marketId.toUpperCase())
    ?? normalizeRealTradingMarketCategory(null, marketId);
}

export function normalizeRealTradingMarketCategory(
  value: unknown,
  providerMarketId: unknown,
): RealTradingMarketCategory {
  const marketId = String(providerMarketId ?? "").trim();
  const providerCoin = getProviderCoinFromMarketId(marketId).toUpperCase();
  const category = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (category === "crypto" || category === "cryptocurrency" || category === "cryptocurrencies") {
    return "crypto";
  }
  if (["stock", "stocks", "equity", "equities", "us_equity", "us_equities", "share", "shares"].includes(category)) {
    return "us_equities";
  }
  if (category === "index" || category === "indices") {
    return "indices";
  }
  if (category === "metal" || category === "metals") {
    return "metals";
  }
  if ((category === "commodity" || category === "commodities") && metalProviderCoins.has(providerCoin)) {
    return "metals";
  }
  if (!marketId.includes(":")) {
    return "crypto";
  }
  if (!category && indexProviderCoins.has(providerCoin)) {
    return "indices";
  }
  if (!category && /^[A-Z]{1,5}$/.test(providerCoin) && !metalProviderCoins.has(providerCoin) && !indexProviderCoins.has(providerCoin)) {
    return "us_equities";
  }
  if (!category && metalProviderCoins.has(providerCoin)) {
    return "metals";
  }
  return "other";
}

function parseTrustedHyperliquidTestnetHip3Dexes() {
  const raw = process.env.HYPERLIQUID_TESTNET_HIP3_DEX_ALLOWLIST;
  const values = String(raw || defaultTrustedHyperliquidTestnetHip3Dexes.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
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

function buildMarketContextsByCoin(
  universe: Array<Pick<HyperliquidUniverseItemPayload, "name">>,
  contexts: HyperliquidAssetContext[],
) {
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
  if (side === "b" || side === "buy" || side === true || side === "open long" || side === "close short") return "buy";
  if (side === "a" || side === "sell" || side === false || side === "open short" || side === "close long") return "sell";
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
