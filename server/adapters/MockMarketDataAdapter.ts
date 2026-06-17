import type { MarketDataAdapter, TickCallback } from "./MarketDataAdapter";
import type { MarketTick } from "../types";

export class MockMarketDataAdapter implements MarketDataAdapter {
  private callbacks = new Set<TickCallback>();
  private symbols = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private prices = new Map<string, number>();
  private connected = false;

  async connect() {
    this.connected = true;
    for (const symbol of this.symbols) {
      this.startSymbol(symbol);
    }
  }

  async disconnect() {
    this.connected = false;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  async subscribe(symbols: string[]) {
    symbols.forEach((symbol) => {
      this.symbols.add(symbol);
      this.prices.set(symbol, this.prices.get(symbol) ?? initialPrice(symbol));
      if (this.connected) {
        this.startSymbol(symbol);
      }
    });
  }

  async unsubscribe(symbols: string[]) {
    symbols.forEach((symbol) => {
      this.symbols.delete(symbol);
      const timer = this.timers.get(symbol);
      if (timer) {
        clearInterval(timer);
        this.timers.delete(symbol);
      }
    });
  }

  onTick(callback: TickCallback) {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  async reconnect() {
    await this.disconnect();
    await this.connect();
  }

  private startSymbol(symbol: string) {
    if (this.timers.has(symbol)) {
      return;
    }

    const emit = () => {
      const current = this.prices.get(symbol) ?? initialPrice(symbol);
      const digits = priceDigits(symbol);
      const minPrice = symbol.includes("BTC") ? 1_000 : symbol.includes("JPY") ? 50 : symbol.includes("USD") && !symbol.includes("XAU") ? 0.5 : 1_800;
      const next = Math.max(minPrice, current + (Math.random() - 0.5) * volatility(symbol));
      const spread = mockSpread(symbol);
      const bid = Number((next - spread / 2).toFixed(digits));
      const ask = Number((next + spread / 2).toFixed(digits));
      const tick: MarketTick = {
        symbol,
        bid,
        ask,
        last: Number(((bid + ask) / 2).toFixed(digits)),
        spread: Number((ask - bid).toFixed(digits)),
        source: "mock",
        timestamp: Date.now(),
      };
      this.prices.set(symbol, tick.last);
      this.callbacks.forEach((callback) => callback(tick));
    };

    emit();
    this.timers.set(symbol, setInterval(emit, 1000));
  }
}

function initialPrice(symbol: string) {
  if (symbol.includes("BTC")) {
    return 104_000 + Math.random() * 500;
  }
  if (symbol.includes("EUR")) {
    return 1.08 + Math.random() * 0.004;
  }
  if (symbol.includes("XAU") || symbol.includes("GOLD")) {
    return 2320 + Math.random() * 8;
  }
  return 100 + Math.random() * 2;
}

function priceDigits(symbol: string) {
  return symbol.includes("EUR") ? 5 : 2;
}

function volatility(symbol: string) {
  if (symbol.includes("BTC")) {
    return 90;
  }
  if (symbol.includes("EUR")) {
    return 0.00035;
  }
  return 0.7;
}

function mockSpread(symbol: string) {
  if (symbol.includes("BTC")) {
    return 8 + Math.random() * 4;
  }
  if (symbol.includes("EUR")) {
    return 0.0001 + Math.random() * 0.00004;
  }
  return 0.1 + Math.random() * 0.08;
}
