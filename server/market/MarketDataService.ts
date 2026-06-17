import { EventEmitter } from "node:events";
import type { MarketDataAdapter } from "../adapters/MarketDataAdapter";
import { MockMarketDataAdapter } from "../adapters/MockMarketDataAdapter";
import { TraderMadeAdapter } from "../adapters/TraderMadeAdapter";
import type { CandleAggregator } from "./CandleAggregator";
import type { MarketStatus, MarketSymbol, MarketTick } from "../types";

type MarketEvents = {
  tick: [MarketTick];
  status: [string, MarketStatus];
};

const staleAfterMs = 10_000;

export const defaultMarketSymbols: MarketSymbol[] = [
  {
    symbol: "XAUUSD",
    displayName: "Gold",
    apiSymbol: "XAUUSD",
    category: "metal",
    digits: 2,
    spread: 0.3,
    leverage: 100,
    contractSize: 100,
    minLot: 0.01,
    maxLot: 10,
    lotStep: 0.01,
    tradeStatus: "enabled",
    isVisible: true,
  },
  {
    symbol: "EURUSD",
    displayName: "Euro / US Dollar",
    apiSymbol: "EURUSD",
    category: "forex",
    digits: 5,
    spread: 0.00012,
    leverage: 100,
    contractSize: 100000,
    minLot: 0.01,
    maxLot: 20,
    lotStep: 0.01,
    tradeStatus: "enabled",
    isVisible: true,
  },
  {
    symbol: "BTCUSDT",
    displayName: "Bitcoin / USDT",
    apiSymbol: "BTCUSDT",
    category: "crypto",
    digits: 2,
    spread: 10,
    leverage: 20,
    contractSize: 1,
    minLot: 0.01,
    maxLot: 5,
    lotStep: 0.01,
    tradeStatus: "enabled",
    isVisible: true,
  },
];

export class MarketDataService extends EventEmitter<MarketEvents> {
  private adapter: MarketDataAdapter;
  private latestTicks = new Map<string, MarketTick>();
  private status = new Map<string, MarketStatus>();
  private statusTimer: NodeJS.Timeout | null = null;
  private symbolConfigs = new Map<string, MarketSymbol>();

  get symbols() {
    return [...this.symbolConfigs.values()];
  }

  constructor(private aggregator: CandleAggregator) {
    super();
    this.setInitialSymbols(defaultMarketSymbols);
    this.adapter = this.createAdapter();
  }

  async start() {
    this.adapter.onTick((tick) => void this.handleTick(tick));
    await this.adapter.subscribe(this.symbols.map((symbol) => symbol.apiSymbol));
    await this.adapter.connect();
    this.statusTimer = setInterval(() => this.refreshStatuses(), 2000);
  }

  async stop() {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    await this.adapter.disconnect();
  }

  getTicker(symbol: string) {
    const normalized = symbol.toUpperCase();
    const config = this.getSymbol(normalized);
    const tick = this.latestTicks.get(config?.symbol ?? normalized);
    return {
      symbol: config?.symbol ?? normalized,
      status: this.getStatus(config?.symbol ?? normalized),
      tick,
    };
  }

  getStatus(symbol: string) {
    return this.status.get(symbol.toUpperCase()) ?? "disconnected";
  }

  getSymbol(symbol: string) {
    const normalized = symbol.toUpperCase();
    return (
      this.symbolConfigs.get(normalized) ??
      this.symbols.find((item) => item.apiSymbol.toUpperCase() === normalized) ??
      null
    );
  }

  async configureSymbols(symbols: MarketSymbol[]) {
    const next = normalizeSymbols(symbols);
    const previousApiSymbols = new Set(this.symbols.map((symbol) => symbol.apiSymbol));
    const nextApiSymbols = new Set(next.filter((symbol) => symbol.isVisible).map((symbol) => symbol.apiSymbol));
    this.setInitialSymbols(next);

    const toSubscribe = [...nextApiSymbols].filter((symbol) => !previousApiSymbols.has(symbol));
    const toUnsubscribe = [...previousApiSymbols].filter((symbol) => !nextApiSymbols.has(symbol));
    if (toSubscribe.length > 0) {
      await this.adapter.subscribe(toSubscribe);
    }
    if (toUnsubscribe.length > 0) {
      await this.adapter.unsubscribe(toUnsubscribe);
    }
  }

  async reconnect() {
    await this.adapter.reconnect();
  }

  private async handleTick(tick: MarketTick) {
    const config = this.getSymbol(tick.symbol);
    const normalizedTick = {
      ...tick,
      symbol: config?.symbol ?? tick.symbol,
    };
    const previous = this.latestTicks.get(normalizedTick.symbol);
    if (previous) {
      const change = Math.abs(normalizedTick.last - previous.last) / previous.last;
      if (change > 0.02) {
        console.warn("[market] abnormal tick jump", { previous, tick: normalizedTick });
      }
    }

    this.latestTicks.set(normalizedTick.symbol, normalizedTick);
    this.setStatus(normalizedTick.symbol, "connected");
    await this.aggregator.handleTick(normalizedTick);
    this.emit("tick", normalizedTick);
  }

  private refreshStatuses() {
    for (const symbol of this.symbols) {
      const tick = this.latestTicks.get(symbol.symbol);
      if (!tick) {
        this.setStatus(symbol.symbol, "disconnected");
        continue;
      }
      const next = Date.now() - tick.timestamp > staleAfterMs ? "stale" : "connected";
      this.setStatus(symbol.symbol, next);
    }
  }

  private setStatus(symbol: string, next: MarketStatus) {
    const previous = this.status.get(symbol);
    this.status.set(symbol, next);
    if (previous !== next) {
      this.emit("status", symbol, next);
    }
  }

  private createAdapter() {
    const key = process.env.TRADERMADE_API_KEY;
    if (key) {
      console.log("[market] using TraderMade adapter");
      return new TraderMadeAdapter({ apiKey: key });
    }

    console.log("[market] TRADERMADE_API_KEY missing, using mock market data");
    return new MockMarketDataAdapter();
  }

  private setInitialSymbols(symbols: MarketSymbol[]) {
    this.symbolConfigs = new Map(normalizeSymbols(symbols).map((symbol) => [symbol.symbol, symbol]));
  }
}

function normalizeSymbols(symbols: MarketSymbol[]) {
  const normalized = symbols
    .filter((symbol) => symbol.symbol && symbol.apiSymbol && symbol.isVisible)
    .map((symbol) => ({
      ...symbol,
      symbol: symbol.symbol.trim().toUpperCase(),
      apiSymbol: symbol.apiSymbol.trim().toUpperCase(),
      digits: clampNumber(symbol.digits, 0, 8, 2),
      spread: positiveNumber(symbol.spread, 0.01),
      leverage: positiveNumber(symbol.leverage, 100),
      contractSize: positiveNumber(symbol.contractSize, 1),
      minLot: positiveNumber(symbol.minLot, 0.01),
      maxLot: positiveNumber(symbol.maxLot, 1),
      lotStep: positiveNumber(symbol.lotStep, 0.01),
      tradeStatus: symbol.tradeStatus ?? "enabled",
      isVisible: symbol.isVisible !== false,
    }));

  return normalized.length > 0 ? normalized : defaultMarketSymbols;
}

function positiveNumber(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}
