import WebSocket from "ws";
import type { MarketDataAdapter, TickCallback } from "./MarketDataAdapter";
import type { MarketTick } from "../types";

type TraderMadeOptions = {
  apiKey: string;
  reconnectMs?: number;
};

export class TraderMadeAdapter implements MarketDataAdapter {
  private ws: WebSocket | null = null;
  private callbacks = new Set<TickCallback>();
  private symbols = new Set<string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private intentionalClose = false;

  constructor(private options: TraderMadeOptions) {}

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this.intentionalClose = false;
    this.ws = new WebSocket("wss://stream.tradermade.com/feedAdv");

    this.ws.on("open", () => {
      this.send({ action: "login", key: this.options.apiKey, fmt: "JSON" });
    });

    this.ws.on("message", (raw) => this.handleMessage(String(raw)));
    this.ws.on("close", () => this.scheduleReconnect());
    this.ws.on("error", (error) => {
      console.error("[market] TraderMade websocket error", error.message);
    });
  }

  async disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  async subscribe(symbols: string[]) {
    symbols.forEach((symbol) => this.symbols.add(symbol));
    this.sendSubscribe(symbols);
  }

  async unsubscribe(symbols: string[]) {
    symbols.forEach((symbol) => this.symbols.delete(symbol));
    this.send({ action: "unsubscribe", symbols: symbols.map(toTraderMadeSymbol) });
  }

  onTick(callback: TickCallback) {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  async reconnect() {
    await this.disconnect();
    this.intentionalClose = false;
    await this.connect();
  }

  private send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect() {
    if (this.intentionalClose || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.options.reconnectMs ?? 3000);
  }

  private handleMessage(raw: string) {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (data.type === "login_ok") {
        this.sendSubscribe([...this.symbols]);
        return;
      }
      if (data.type === "login_reject" || data.type === "error") {
        console.error("[market] TraderMade control message", data);
        return;
      }
      if (data.type === "sub_ack" || data.type === "unsub_ack" || data.type === "logout") {
        console.log("[market] TraderMade control message", data);
        return;
      }
      const tick = this.toTick(data);
      if (!tick) {
        return;
      }
      this.callbacks.forEach((callback) => callback(tick));
    } catch (error) {
      console.error("[market] invalid TraderMade message", raw, error);
    }
  }

  private toTick(data: Record<string, unknown>): MarketTick | null {
    const symbol = String(data.symbol ?? data.instrument ?? data.s ?? "")
      .replace(":QUOTE", "")
      .replace("/", "")
      .toUpperCase();
    const bid = Number(data.bid ?? data.b);
    const ask = Number(data.ask ?? data.a);
    const mid = Number(data.mid ?? data.last ?? data.price ?? data.m);
    const timestamp = parseTraderMadeTimestamp(data.ts ?? data.timestamp) ?? Date.now();

    if (!symbol || !Number.isFinite(bid) || !Number.isFinite(ask)) {
      return null;
    }

    const last = Number.isFinite(mid) ? mid : (bid + ask) / 2;

    return {
      symbol,
      bid,
      ask,
      last: Number(last.toFixed(2)),
      spread: Number((ask - bid).toFixed(2)),
      source: "tradermade",
      timestamp,
    };
  }

  private sendSubscribe(symbols: string[]) {
    if (symbols.length === 0) {
      return;
    }
    this.send({
      action: "subscribe",
      send_last: true,
      symbols: symbols.map(toTraderMadeSymbol),
    });
  }
}

function toTraderMadeSymbol(symbol: string) {
  return `${symbol.replace("/", "").toUpperCase()}:QUOTE`;
}

function parseTraderMadeTimestamp(value: unknown) {
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  const match = value.match(/^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, ms = "0"] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(ms.padEnd(3, "0").slice(0, 3)),
  );
}
