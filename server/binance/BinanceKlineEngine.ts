import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { isSupportedCryptoSymbol, supportedCryptoSymbols, type SupportedCryptoSymbol } from "../config/supportedSymbols";
import type { CandleStore } from "../storage/CandleStore";
import type { Candle, CandleInterval, MarketStatus, MarketTick } from "../types";
import { BinanceRestClient } from "./BinanceRestClient";

const supportedIntervals: CandleInterval[] = ["1m", "5m", "15m", "1h"];

type BinanceKlineEvents = {
  candle: [Candle];
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

const defaultStreamBaseUrl = "wss://stream.binance.com:9443/stream";

export class BinanceKlineEngine extends EventEmitter<BinanceKlineEvents> {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private manuallyStopped = false;
  private latestTicks = new Map<string, MarketTick>();
  private status = new Map<string, MarketStatus>();

  constructor(
    private store: CandleStore,
    private restClient = new BinanceRestClient(),
    private symbols: SupportedCryptoSymbol[] = [...supportedCryptoSymbols],
    private streamBaseUrl = defaultStreamBaseUrl,
  ) {
    super();
  }

  async start() {
    this.manuallyStopped = false;
    await this.store.init();
    await this.seedHistory();
    this.connect();
  }

  async stop() {
    this.manuallyStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  async getCandles(symbol: string, interval: CandleInterval, limit: number) {
    const normalized = this.normalizeSymbol(symbol);
    const history = await this.store.getHistory(normalized, interval, limit);
    const current = await this.store.getCurrent(normalized, interval);
    const combined = current ? [...history.filter((item) => item.time !== current.time), current] : history;
    return combined.sort((a, b) => a.time - b.time).slice(-limit);
  }

  getTicker(symbol: string) {
    const normalized = this.normalizeSymbol(symbol);
    return {
      symbol: normalized,
      status: this.getStatus(normalized),
      tick: this.latestTicks.get(normalized),
    };
  }

  getStatus(symbol: string) {
    return this.status.get(this.normalizeSymbol(symbol)) ?? "disconnected";
  }

  private async seedHistory() {
    await Promise.all(
      this.symbols.flatMap((symbol) => supportedIntervals.map(async (interval) => {
        try {
          const candles = await this.restClient.getHistoricalKlines(symbol, interval, 500);
          for (const candle of candles) {
            await this.store.saveClosed(candle);
          }
          console.log(`[binance] seeded ${candles.length} historical ${interval} candles for ${symbol}`);
        } catch (error) {
          console.error(`[binance] failed to seed ${symbol} ${interval} history`, error);
        }
      })),
    );
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
      console.log(`[binance] kline stream connected for ${this.symbols.join(", ")} (${supportedIntervals.join(", ")})`);
    });

    this.socket.on("message", (raw) => {
      try {
        void this.handleMessage(JSON.parse(String(raw)) as BinanceKlinePayload);
      } catch (error) {
        console.error("[binance] invalid kline message", error);
      }
    });

    this.socket.on("close", () => {
      for (const symbol of this.symbols) {
        this.setStatus(symbol, "disconnected");
      }
      this.scheduleReconnect();
    });

    this.socket.on("error", (error) => {
      console.error("[binance] stream error", error.message);
      for (const symbol of this.symbols) {
        this.setStatus(symbol, "disconnected");
      }
    });
  }

  private async handleMessage(payload: BinanceKlinePayload) {
    const kline = payload.data?.k;
    if (!kline || !isSupportedInterval(kline.i)) {
      return;
    }

    const symbol = this.normalizeSymbol(kline.s);
    const candle: Candle = {
      symbol,
      interval: kline.i,
      time: Math.floor(kline.t / 1000),
      open: Number(kline.o),
      high: Number(kline.h),
      low: Number(kline.l),
      close: Number(kline.c),
      volume: Number(kline.v),
    };

    await this.store.saveCurrent(candle);
    if (kline.x) {
      await this.store.saveClosed(candle);
    }

    this.setStatus(symbol, "connected");
    if (candle.interval === "1m") {
      const tick: MarketTick = {
        symbol,
        bid: candle.close,
        ask: candle.close,
        last: candle.close,
        spread: 0,
        source: "binance",
        timestamp: Date.now(),
      };
      this.latestTicks.set(symbol, tick);
      this.emit("tick", tick);
    }
    this.emit("candle", candle);
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

  private setStatus(symbol: string, next: MarketStatus) {
    const normalized = this.normalizeSymbol(symbol);
    const previous = this.status.get(normalized);
    this.status.set(normalized, next);
    if (previous !== next) {
      this.emit("status", normalized, next);
    }
  }

  private normalizeSymbol(symbol: string) {
    const normalized = symbol.toUpperCase();
    if (!isSupportedCryptoSymbol(normalized)) {
      throw new Error(`unsupported symbol: ${symbol}. supported symbols: ${supportedCryptoSymbols.join(", ")}`);
    }
    return normalized;
  }
}

function isSupportedInterval(value: string): value is CandleInterval {
  return supportedIntervals.includes(value as CandleInterval);
}
