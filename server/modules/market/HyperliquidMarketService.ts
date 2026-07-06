import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Candle, CandleInterval, MarketStatus, MarketSymbol, MarketTick } from "../../types";
import { KlineStore } from "../kline/KlineStore";
import {
  HyperliquidRestClient,
  normalizeProviderCandle,
  type HyperliquidCandle,
  type HyperliquidPerpMarket,
} from "./HyperliquidRestClient";
import {
  getSupportedCryptoSymbols,
  getSupportedMarketSymbols,
  normalizeInterval,
  normalizeSymbol,
  setSupportedMarketSymbols,
  toHyperliquidCoin,
} from "./marketConfig";

type HyperliquidMarketEvents = {
  kline: [Candle];
  tick: [MarketTick];
  status: [string, MarketStatus];
};
type HyperliquidMessage = { channel?: string; data?: unknown };
type HyperliquidLevel = { px: string; sz: string; n: number };
type HyperliquidBbo = { coin: string; time: number; bbo: [HyperliquidLevel | null, HyperliquidLevel | null] };
type HyperliquidTrade = { coin: string; px: string; time: number };
type HyperliquidAllMids = { mids: Record<string, string> };
type BestBidOffer = { bid: number; ask: number; timestamp: number };

const defaultStreamUrl = process.env.HYPERLIQUID_STREAM_URL ?? "wss://api.hyperliquid.xyz/ws";
const staleAfterMs = 10_000;
const heartbeatMs = 30_000;

export class HyperliquidMarketService extends EventEmitter<HyperliquidMarketEvents> {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private manuallyStopped = false;
  private reconnectAttempts = 0;
  private latestTicks = new Map<string, MarketTick>();
  private latestTradePrices = new Map<string, { price: number; timestamp: number }>();
  private latestBbo = new Map<string, BestBidOffer>();
  private status = new Map<string, MarketStatus>();
  private subscriptionCounts = new Map<string, number>();

  constructor(
    private store: KlineStore,
    private restClient = new HyperliquidRestClient(),
    private streamUrl = defaultStreamUrl,
  ) {
    super();
  }

  async start() {
    this.manuallyStopped = false;
    const markets = await this.restClient.getPerpetualMarkets();
    setSupportedMarketSymbols(markets.map(toMarketSymbol));
    this.connect();
    this.statusTimer = setInterval(() => this.refreshStatuses(), 2000);
  }

  async stop() {
    this.manuallyStopped = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  getMarketSymbols() {
    return getSupportedMarketSymbols();
  }

  async getKlines(symbol: string, interval: CandleInterval, limit: number) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedInterval = normalizeInterval(interval);
    try {
      const candles = await this.restClient.getKlines(normalizedSymbol, normalizedInterval, limit);
      candles.forEach((candle) => this.store.upsertHistory(candle));
    } catch (error) {
      const cached = this.store.getCandles(normalizedSymbol, normalizedInterval, limit);
      if (cached.length > 0) return ensureNoDuplicateCandles(cached);
      throw error;
    }
    return ensureNoDuplicateCandles(this.store.getCandles(normalizedSymbol, normalizedInterval, limit));
  }

  getTicker(symbol: string) {
    const normalized = normalizeSymbol(symbol);
    return { symbol: normalized, status: this.getStatus(normalized), tick: this.latestTicks.get(normalized) };
  }

  getStatus(symbol: string) {
    return this.status.get(normalizeSymbol(symbol)) ?? "disconnected";
  }

  addTickerSubscription(symbol: string) {
    const normalized = normalizeSymbol(symbol);
    const coin = toHyperliquidCoin(normalized);
    return this.addSubscription(`ticker:${normalized}`, [{ type: "bbo", coin }, { type: "trades", coin }]);
  }

  addCandleSubscription(symbol: string, interval: CandleInterval) {
    const normalized = normalizeSymbol(symbol);
    const normalizedInterval = normalizeInterval(interval);
    return this.addSubscription(`candle:${normalized}:${normalizedInterval}`, [
      { type: "candle", coin: toHyperliquidCoin(normalized), interval: normalizedInterval },
    ]);
  }

  private connect() {
    this.socket = new WebSocket(this.streamUrl);
    this.socket.on("open", () => {
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.subscribe({ type: "allMids" });
      for (const [key, count] of this.subscriptionCounts) {
        if (count > 0) subscriptionsForKey(key).forEach((subscription) => this.subscribe(subscription));
      }
      console.log(`[market] Hyperliquid stream connected: ${getSupportedCryptoSymbols().length} active perpetuals`);
    });
    this.socket.on("message", (raw) => {
      try {
        this.handleMessage(JSON.parse(String(raw)) as HyperliquidMessage);
      } catch (error) {
        console.error("[market] invalid Hyperliquid message", error);
      }
    });
    this.socket.on("close", () => {
      this.clearHeartbeat();
      this.socket = null;
      getSupportedCryptoSymbols().forEach((symbol) => this.setStatus(symbol, "disconnected"));
      this.scheduleReconnect();
    });
    this.socket.on("error", (error) => {
      console.error("[market] Hyperliquid stream error", error.message);
    });
  }

  private subscribe(subscription: Record<string, string>) {
    this.socket?.send(JSON.stringify({ method: "subscribe", subscription }));
  }

  private addSubscription(key: string, subscriptions: Array<Record<string, string>>) {
    const previous = this.subscriptionCounts.get(key) ?? 0;
    this.subscriptionCounts.set(key, previous + 1);
    if (previous === 0 && this.socket?.readyState === WebSocket.OPEN) {
      subscriptions.forEach((subscription) => this.subscribe(subscription));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.subscriptionCounts.get(key) ?? 1) - 1;
      if (next > 0) {
        this.subscriptionCounts.set(key, next);
        return;
      }
      this.subscriptionCounts.delete(key);
      if (this.socket?.readyState === WebSocket.OPEN) {
        subscriptions.forEach((subscription) => {
          this.socket?.send(JSON.stringify({ method: "unsubscribe", subscription }));
        });
      }
    };
  }

  private handleMessage(payload: HyperliquidMessage) {
    if (payload.channel === "allMids") return this.handleAllMids(payload.data as HyperliquidAllMids);
    if (payload.channel === "bbo") return this.handleBbo(payload.data as HyperliquidBbo);
    if (payload.channel === "trades") return this.handleTrades(payload.data as HyperliquidTrade[]);
    if (payload.channel === "candle") {
      const rows = Array.isArray(payload.data) ? payload.data : [payload.data];
      rows.forEach((row) => this.handleCandle(row as HyperliquidCandle));
    }
  }

  private handleAllMids(data: HyperliquidAllMids) {
    const timestamp = Date.now();
    for (const [coin, rawPrice] of Object.entries(data?.mids ?? {})) {
      let symbol: string;
      try {
        symbol = normalizeSymbol(coin);
      } catch {
        continue;
      }
      const price = Number(rawPrice);
      if (!Number.isFinite(price) || price <= 0) continue;
      const current = this.latestTicks.get(symbol);
      const tick: MarketTick = {
        symbol,
        bid: current?.bid ?? price,
        ask: current?.ask ?? price,
        last: price,
        spread: current?.spread ?? 0,
        source: "hyperliquid",
        timestamp,
      };
      this.latestTradePrices.set(symbol, { price, timestamp });
      this.latestTicks.set(symbol, tick);
      this.setStatus(symbol, "connected");
      this.emit("tick", tick);
    }
  }

  private handleBbo(data: HyperliquidBbo) {
    const symbol = normalizeSymbol(data.coin);
    const bid = Number(data.bbo?.[0]?.px);
    const ask = Number(data.bbo?.[1]?.px);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= bid) return;
    this.latestBbo.set(symbol, { bid, ask, timestamp: Number(data.time) });
    this.emitTick(symbol);
  }

  private handleTrades(data: HyperliquidTrade[]) {
    if (!Array.isArray(data)) return;
    for (const trade of data) {
      const symbol = normalizeSymbol(trade.coin);
      const price = Number(trade.px);
      const timestamp = Number(trade.time);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) continue;
      this.latestTradePrices.set(symbol, { price, timestamp });
      this.emitTick(symbol);
    }
  }

  private emitTick(symbol: string) {
    const bbo = this.latestBbo.get(symbol);
    const trade = this.latestTradePrices.get(symbol);
    if (!bbo || !trade) return;
    const tick: MarketTick = {
      symbol,
      bid: bbo.bid,
      ask: bbo.ask,
      last: trade.price,
      spread: bbo.ask - bbo.bid,
      source: "hyperliquid",
      timestamp: Math.max(bbo.timestamp, trade.timestamp),
    };
    this.latestTicks.set(symbol, tick);
    this.setStatus(symbol, "connected");
    this.emit("tick", tick);
  }

  private handleCandle(row: HyperliquidCandle) {
    if (!row) return;
    const candle = normalizeProviderCandle(row, normalizeSymbol(row.s));
    if (!candle) return;
    Number(row.T) <= Date.now() ? this.store.closeCurrent(candle) : this.store.updateCurrent(candle);
    this.emit("kline", candle);
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ method: "ping" }));
    }, heartbeatMs);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect() {
    if (this.manuallyStopped || this.reconnectTimer) return;
    const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private refreshStatuses() {
    for (const symbol of getSupportedCryptoSymbols()) {
      const tick = this.latestTicks.get(symbol);
      this.setStatus(symbol, !tick ? "disconnected" : Date.now() - tick.timestamp > staleAfterMs ? "stale" : "connected");
    }
  }

  private setStatus(symbol: string, next: MarketStatus) {
    const normalized = normalizeSymbol(symbol);
    const previous = this.status.get(normalized);
    this.status.set(normalized, next);
    if (previous !== next) this.emit("status", normalized, next);
  }
}

function toMarketSymbol(market: HyperliquidPerpMarket): MarketSymbol {
  const symbol = `${market.coin.toUpperCase()}USDT`;
  const maxPriceDecimals = Math.max(0, 6 - market.szDecimals);
  const significantDecimals = Math.max(0, 4 - Math.floor(Math.log10(market.markPrice)));
  const digits = Math.min(maxPriceDecimals, significantDecimals);
  const lotStep = roundToDecimals(10 ** -market.szDecimals, market.szDecimals);
  const maxLot = roundToDecimals(Math.floor(1_000_000 / market.markPrice / lotStep) * lotStep, market.szDecimals);
  return {
    symbol,
    displayName: `${market.coin} Perpetual`,
    apiSymbol: market.coin,
    category: "crypto",
    digits,
    spread: 10 ** -digits,
    leverage: market.maxLeverage,
    contractSize: 1,
    minLot: lotStep,
    maxLot: Math.max(lotStep, maxLot),
    lotStep,
    tradeStatus: "enabled",
    isVisible: true,
  };
}

function roundToDecimals(value: number, decimals: number) {
  return Number(value.toFixed(Math.max(0, decimals)));
}

function subscriptionsForKey(key: string) {
  const [channel, symbol, interval] = key.split(":");
  const coin = toHyperliquidCoin(symbol);
  return channel === "ticker"
    ? [{ type: "bbo", coin }, { type: "trades", coin }]
    : [{ type: "candle", coin, interval }];
}

function ensureNoDuplicateCandles(candles: Candle[]) {
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((a, b) => a.time - b.time);
}
