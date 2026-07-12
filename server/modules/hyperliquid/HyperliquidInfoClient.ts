import type { CandleInterval } from "../../types";
import { normalizeInterval, normalizeLimit, normalizeSymbol } from "../market/marketConfig";
import { hyperliquidTestnetNetwork } from "./hyperliquidConfig";
import type {
  RealTradingAccountSummary,
  RealTradingCandle,
  RealTradingMarketSummary,
  RealTradingOrderbook,
  RealTradingPosition,
  RealTradingSymbol,
  RealTradingTrade,
} from "./hyperliquidTypes";

const requestTimeoutMs = 15_000;

type HyperliquidUniverseItem = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
};

type HyperliquidAssetContext = {
  markPx?: string;
  oraclePx?: string;
  midPx?: string;
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
    return universe.map((item, index) => ({
      symbol: toInternalSymbol(item.name),
      providerCoin: item.name,
      assetId: index,
      szDecimals: Number(item.szDecimals ?? 0),
      pxDecimals: inferPriceDecimals(contexts[index]),
      maxLeverage: Number(item.maxLeverage ?? 1),
      status: item.isDelisted ? "delisted" : "active",
      network: hyperliquidTestnetNetwork,
    }));
  }

  async getSummary(symbolInput: string): Promise<RealTradingMarketSummary> {
    const symbol = normalizeSymbol(symbolInput);
    const coin = toProviderCoin(symbol);
    const { universe, contexts } = await this.getMetaAndContexts();
    const index = universe.findIndex((item) => item.name === coin);
    if (index < 0) {
      throw new Error(`真实交易品种 ${symbol} 不存在。`);
    }
    const context = contexts[index] ?? {};
    return {
      symbol,
      providerCoin: coin,
      markPrice: toNullableNumber(context.markPx),
      oraclePrice: toNullableNumber(context.oraclePx),
      midPrice: toNullableNumber(context.midPx),
      dayNotionalVolume: toNullableNumber(context.dayNtlVlm),
      openInterest: toNullableNumber(context.openInterest),
      funding: toNullableNumber(context.funding),
      nextFundingTime: typeof context.nextFundingTime === "number" ? context.nextFundingTime : null,
      status: "connected",
      timestamp: Date.now(),
      network: hyperliquidTestnetNetwork,
    };
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
    const state = await this.getClearinghouseState(normalizedAddress);
    const marginSummary = state.marginSummary ?? {};
    const crossSummary = state.crossMarginSummary ?? {};
    const positions = normalizePositions(state.assetPositions);
    const totalUnrealizedPnl = positions.reduce((sum, position) => sum + (position.unrealizedPnl ?? 0), 0);
    const accountValue = toNullableNumber(marginSummary.accountValue);
    const usedMargin = toNullableNumber(marginSummary.totalMarginUsed);
    return {
      address: normalizedAddress,
      accountValue,
      withdrawable: toNullableNumber(state.withdrawable),
      usedMargin,
      availableMargin: accountValue !== null && usedMargin !== null ? Math.max(0, accountValue - usedMargin) : null,
      totalUnrealizedPnl,
      crossAccountValue: toNullableNumber(crossSummary.accountValue),
      isolatedAccountValue: null,
      timestamp: Date.now(),
      network: hyperliquidTestnetNetwork,
    };
  }

  async getPositions(address: string): Promise<RealTradingPosition[]> {
    const state = await this.getClearinghouseState(normalizeAddress(address));
    return normalizePositions(state.assetPositions);
  }

  async getOpenOrders(address: string) {
    return this.postInfo({ type: "openOrders", user: normalizeAddress(address) });
  }

  async getOrderHistory(address: string) {
    const user = normalizeAddress(address);
    const [orders, fills] = await Promise.all([
      this.postInfo({ type: "historicalOrders", user }).catch((error) => ({ error: sanitizeError(error) })),
      this.postInfo({ type: "userFills", user }).catch((error) => ({ error: sanitizeError(error) })),
    ]);
    return {
      orders: Array.isArray(orders) ? orders : [],
      fills: Array.isArray(fills) ? fills : [],
      nextCursor: null,
      warnings: [
        !Array.isArray(orders) && "historicalOrders unavailable",
        !Array.isArray(fills) && "userFills unavailable",
      ].filter(Boolean),
    };
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

function toInternalSymbol(providerCoin: string) {
  return `${providerCoin.toUpperCase()}USDT`;
}

function toProviderCoin(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  return normalized.endsWith("USDT") ? normalized.slice(0, -4) : normalized;
}

function inferPriceDecimals(context?: HyperliquidAssetContext) {
  const values = [context?.markPx, context?.oraclePx, context?.midPx].filter((value): value is string => typeof value === "string");
  const decimals = values.map((value) => value.split(".")[1]?.length ?? 0);
  return Math.max(0, Math.min(8, ...decimals, 2));
}

function toNullableNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeBookSide(levels: HyperliquidBookLevel[], direction: "asc" | "desc") {
  let cumulativeSize = 0;
  return levels
    .map((level) => ({
      price: Number(level.px),
      size: Number(level.sz),
      orderCount: typeof level.n === "number" ? level.n : null,
    }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size))
    .sort((left, right) => direction === "asc" ? left.price - right.price : right.price - left.price)
    .map((level) => {
      cumulativeSize += level.size;
      return { ...level, cumulativeSize };
    });
}

function normalizeTradeSide(value: unknown) {
  if (value === "B" || value === "buy") return "buy";
  if (value === "A" || value === "sell") return "sell";
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

function normalizePositions(value: unknown): RealTradingPosition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const position = entry?.position ?? {};
    const size = Number(position.szi ?? 0);
    if (!Number.isFinite(size) || size === 0) return [];
    const coin = String(position.coin ?? "");
    return [{
      coin,
      symbol: toInternalSymbol(coin),
      side: size >= 0 ? "long" : "short",
      size: Math.abs(size),
      entryPrice: toNullableNumber(position.entryPx),
      markPrice: toNullableNumber(position.markPx),
      liquidationPrice: toNullableNumber(position.liquidationPx),
      margin: toNullableNumber(position.marginUsed ?? position.positionValue),
      leverage: toNullableNumber(position.leverage?.value ?? position.leverage),
      unrealizedPnl: toNullableNumber(position.unrealizedPnl),
      rawStatus: typeof position.type === "string" ? position.type : null,
      network: hyperliquidTestnetNetwork,
    }];
  });
}

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message : "request failed";
}
