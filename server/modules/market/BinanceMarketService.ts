import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Candle, CandleInterval, MarketStatus, MarketTick } from "../../types";
import { KlineStore } from "../kline/KlineStore";
import { BinanceRestClient } from "./BinanceRestClient";
import { normalizeInterval, normalizeSymbol, realtimeInterval, supportedCryptoSymbols, supportedIntervals } from "./marketConfig";

type BinanceMarketEvents = {
  kline: [Candle];
  tick: [MarketTick];
  status: [string, MarketStatus];
};

type BinanceKlinePayload = {
  stream?: string;
  data?: {
    e: "kline";
    E: number;
    s: string;
    k: {
      t: number;
      s: string;
      i: string;
      o: string;
      c: string;
      h: string;
      l: string;
      v: string;
      x: boolean;
    };
  };
};

const defaultStreamBaseUrl = process.env.BINANCE_STREAM_BASE_URL ?? "wss://fstream.binance.com/stream";
const staleAfterMs = 10_000;
const restPollMs = 5_000;

export class BinanceMarketService extends EventEmitter<BinanceMarketEvents> {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private restPollTimer: NodeJS.Timeout | null = null;
  private manuallyStopped = false;
  private latestTicks = new Map<string, MarketTick>();
  private status = new Map<string, MarketStatus>();

  constructor(
    private store: KlineStore,
    private restClient = new BinanceRestClient(),
    private symbols = [...supportedCryptoSymbols],
    private streamBaseUrl = defaultStreamBaseUrl,
  ) {
    super();
  }

  async start() {
    this.manuallyStopped = false;
    await this.seedHistory();
    this.connect();
    this.statusTimer = setInterval(() => this.refreshStatuses(), 2000);
    this.restPollTimer = setInterval(() => void this.pollRestCandles(), restPollMs);
  }

  async stop() {
    this.manuallyStopped = true;
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.restPollTimer) {
      clearInterval(this.restPollTimer);
      this.restPollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  async getKlines(symbol: string, interval: CandleInterval, limit: number) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedInterval = normalizeInterval(interval);
    let candles: Candle[];
    try {
      candles = await this.restClient.getKlines(normalizedSymbol, normalizedInterval, limit);
    } catch (error) {
      const stored = this.store.getCandles(normalizedSymbol, normalizedInterval, limit);
      if (stored.length > 0) {
        console.error(`[market] REST klines failed, using cached ${normalizedSymbol} ${normalizedInterval} candles`, error);
        return ensureNoDuplicateCandles(stored);
      }
      throw error;
    }

    for (const candle of candles) {
      this.store.upsertHistory(candle);
    }

    const stored = this.store.getCandles(normalizedSymbol, normalizedInterval, limit);
    return ensureNoDuplicateCandles(stored);
  }

  getStoredKlines(symbol: string, interval: CandleInterval, limit: number) {
    return ensureNoDuplicateCandles(this.store.getCandles(normalizeSymbol(symbol), normalizeInterval(interval), limit));
  }

  getTicker(symbol: string) {
    const normalized = normalizeSymbol(symbol);
    return {
      symbol: normalized,
      status: this.getStatus(normalized),
      tick: this.latestTicks.get(normalized),
    };
  }

  getStatus(symbol: string) {
    return this.status.get(normalizeSymbol(symbol)) ?? "disconnected";
  }

  private async seedHistory() {
    await Promise.all(
      this.symbols.flatMap((symbol) => supportedIntervals.map(async (interval) => {
        try {
          const candles = await this.restClient.getKlines(symbol, interval, 500);
          for (const candle of candles) {
            this.store.upsertHistory(candle);
          }
          if (interval === realtimeInterval) {
            this.seedTickFromCandle(candles.at(-1));
          }
          console.log(`[market] seeded ${candles.length} ${interval} klines for ${symbol}`);
        } catch (error) {
          console.error(`[market] failed to seed ${symbol} ${interval} klines`, error);
        }
      })),
    );
  }

  private seedTickFromCandle(candle: Candle | undefined) {
    if (!candle) {
      return;
    }

    const tick: MarketTick = {
      symbol: candle.symbol,
      bid: candle.close,
      ask: candle.close,
      last: candle.close,
      spread: 0,
      source: "binance",
      timestamp: Date.now(),
    };

    this.latestTicks.set(candle.symbol, tick);
    this.setStatus(candle.symbol, "connected");
    this.emit("tick", tick);
  }

  private async pollRestCandles() {
    await Promise.all(this.symbols.flatMap((symbol) => supportedIntervals.map(async (interval) => {
      try {
        const candles = await this.restClient.getKlines(symbol, interval, 2);
        const latest = candles.at(-1);
        if (!latest) {
          return;
        }

        this.store.updateCurrent(latest);
        if (interval === realtimeInterval) {
          this.seedTickFromCandle(latest);
        }
        this.emit("kline", latest);
      } catch (error) {
        console.error(`[market] REST candle poll failed for ${symbol} ${interval}`, error);
      }
    })));
  }

  private connect() {
    const streams = this.symbols
      .flatMap((symbol) => supportedIntervals.map((interval) => `${symbol.toLowerCase()}@kline_${interval}`))
      .join("/");
    const url = `${this.streamBaseUrl}?streams=${streams}`;
    this.socket = new WebSocket(url);

    this.socket.on("open", () => {
      for (const symbol of this.symbols) {
        this.setStatus(symbol, "connected");
      }
      console.log(`[market] Binance kline stream connected: ${this.symbols.join(", ")} (${supportedIntervals.join(", ")})`);
    });

    this.socket.on("message", (raw) => {
      try {
        this.handleMessage(JSON.parse(String(raw)) as BinanceKlinePayload);
      } catch (error) {
        console.error("[market] invalid Binance kline message", error);
      }
    });

    this.socket.on("close", () => {
      for (const symbol of this.symbols) {
        this.setStatus(symbol, "disconnected");
      }
      this.scheduleReconnect();
    });

    this.socket.on("error", (error) => {
      console.error("[market] Binance stream error", error.message);
      for (const symbol of this.symbols) {
        this.setStatus(symbol, "disconnected");
      }
    });
  }

  private handleMessage(payload: BinanceKlinePayload) {
    const kline = payload.data?.k;
    if (!kline) {
      return;
    }

    const symbol = normalizeSymbol(kline.s);
    const interval = normalizeInterval(kline.i);
    const candle = normalizeCandle({
      symbol,
      interval,
      time: Math.floor(kline.t / 1000),
      open: Number(kline.o),
      high: Number(kline.h),
      low: Number(kline.l),
      close: Number(kline.c),
      volume: Number(kline.v),
    });

    this.store.updateCurrent(candle);
    if (kline.x) {
      this.store.closeCurrent(candle);
    }

    this.setStatus(symbol, "connected");
    if (interval === realtimeInterval) {
      const tick: MarketTick = {
        symbol,
        bid: candle.close,
        ask: candle.close,
        last: candle.close,
        spread: 0,
        source: "binance",
        timestamp: payload.data?.E ?? Date.now(),
      };

      this.latestTicks.set(symbol, tick);
      this.emit("tick", tick);
    }
    this.emit("kline", candle);
    console.log(
      `[kline] ${symbol} ${candle.interval} ${new Date(candle.time * 1000).toISOString()} O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} V:${candle.volume}${kline.x ? " closed" : ""}`,
    );
  }

  private scheduleReconnect() {
    if (this.manuallyStopped || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  private refreshStatuses() {
    for (const symbol of this.symbols) {
      const tick = this.latestTicks.get(symbol);
      if (!tick) {
        this.setStatus(symbol, "disconnected");
        continue;
      }

      this.setStatus(symbol, Date.now() - tick.timestamp > staleAfterMs ? "stale" : "connected");
    }
  }

  private setStatus(symbol: string, next: MarketStatus) {
    const normalized = normalizeSymbol(symbol);
    const previous = this.status.get(normalized);
    this.status.set(normalized, next);
    if (previous !== next) {
      this.emit("status", normalized, next);
    }
  }
}

function normalizeCandle(candle: Candle): Candle {
  return {
    ...candle,
    high: Math.max(candle.high, candle.open, candle.close),
    low: Math.min(candle.low, candle.open, candle.close),
  };
}

function ensureNoDuplicateCandles(candles: Candle[]) {
  const byTime = new Map<number, Candle>();
  for (const candle of candles) {
    byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
