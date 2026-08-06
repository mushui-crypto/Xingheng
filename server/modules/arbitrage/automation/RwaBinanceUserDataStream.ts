import { createHmac, randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { RwaBinanceCredentials } from "./RwaBinanceAutomationTypes";
import {
  RwaBinanceActivityGuard,
  RwaBinanceActivityUnsafeError,
  type RwaBinanceActivityLeg,
} from "./RwaBinanceActivityGuard";

const SPOT_WS_URL = "wss://ws-api.binance.com:443/ws-api/v3";
const FUTURES_WS_URL = "wss://fstream.binance.com/ws";
const FUTURES_REST_URL = "https://fapi.binance.com";
const FUTURES_KEEPALIVE_MS = 50 * 60_000;

export class RwaBinanceUserDataStream {
  private spot: WebSocket | null = null;
  private futures: WebSocket | null = null;
  private futuresListenKey: string | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private startInFlight: Promise<void> | null = null;

  constructor(
    private readonly guard: RwaBinanceActivityGuard,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
    private readonly now: () => number = Date.now,
  ) {}

  ensureStarted(credentials: RwaBinanceCredentials) {
    if (this.spot?.readyState === WebSocket.OPEN && this.futures?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (!this.startInFlight) {
      this.startInFlight = this.start(credentials).finally(() => {
        this.startInFlight = null;
      });
    }
    return this.startInFlight;
  }

  close() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    this.spot?.close();
    this.futures?.close();
    this.spot = null;
    this.futures = null;
    this.futuresListenKey = null;
    this.guard.resetForRestart();
  }

  private async start(credentials: RwaBinanceCredentials) {
    this.closeSocketsOnly();
    try {
      await Promise.all([
        this.startSpot(credentials),
        this.startFutures(credentials),
      ]);
    } catch {
      this.guard.markDisconnected("spot", "spot_or_futures_stream_start_failed");
      this.guard.markDisconnected("futures", "spot_or_futures_stream_start_failed");
      throw new RwaBinanceActivityUnsafeError(
        "stream_not_continuous",
        "Binance Spot/USD-M 用户流未能同时建立。",
      );
    }
  }

  private startSpot(credentials: RwaBinanceCredentials) {
    return new Promise<void>((resolve, reject) => {
      const socket = this.createSocket(SPOT_WS_URL);
      this.spot = socket;
      const requestId = randomUUID();
      const timestamp = this.now();
      const signature = createHmac("sha256", credentials.apiSecret)
        .update(`apiKey=${credentials.apiKey}&timestamp=${timestamp}`)
        .digest("hex");
      socket.once("open", () => {
        socket.send(JSON.stringify({
          id: requestId,
          method: "userDataStream.subscribe.signature",
          params: { apiKey: credentials.apiKey, timestamp, signature },
        }));
      });
      socket.on("message", (data) => {
        try {
          const payload = JSON.parse(String(data)) as Record<string, unknown>;
          if (payload.id === requestId) {
            if (payload.status !== 200) throw new Error("Spot user stream subscription was rejected.");
            this.guard.markConnected("spot");
            resolve();
            return;
          }
          this.handleSpotEvent(record(payload.event));
        } catch (error) {
          this.guard.observeUnknownEvent("spot_invalid_payload");
          reject(error);
        }
      });
      this.bindFailure(socket, "spot", reject);
    });
  }

  private async startFutures(credentials: RwaBinanceCredentials) {
    const response = await this.fetchFn(`${FUTURES_REST_URL}/fapi/v1/listenKey`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });
    if (!response.ok) throw new Error(`USD-M user stream listenKey failed with HTTP ${response.status}.`);
    const listenKey = String(record(await response.json()).listenKey ?? "");
    if (!listenKey) throw new Error("USD-M user stream did not return a listenKey.");
    this.futuresListenKey = listenKey;
    await new Promise<void>((resolve, reject) => {
      const socket = this.createSocket(`${FUTURES_WS_URL}/${encodeURIComponent(listenKey)}`);
      this.futures = socket;
      socket.once("open", () => {
        this.guard.markConnected("futures");
        resolve();
      });
      socket.on("message", (data) => {
        try {
          this.handleFuturesEvent(record(JSON.parse(String(data))));
        } catch (error) {
          this.guard.observeUnknownEvent("futures_invalid_payload");
          reject(error);
        }
      });
      this.bindFailure(socket, "futures", reject);
    });
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = setInterval(() => {
      void this.keepFuturesAlive(credentials);
    }, FUTURES_KEEPALIVE_MS);
    this.keepalive.unref();
  }

  private async keepFuturesAlive(credentials: RwaBinanceCredentials) {
    if (!this.futuresListenKey) return;
    try {
      const response = await this.fetchFn(`${FUTURES_REST_URL}/fapi/v1/listenKey`, {
        method: "PUT",
        headers: { "X-MBX-APIKEY": credentials.apiKey },
      });
      if (!response.ok) this.guard.markDisconnected("futures", `futures_keepalive_http_${response.status}`);
    } catch {
      this.guard.markDisconnected("futures", "futures_keepalive_failed");
    }
  }

  private handleSpotEvent(event: Record<string, unknown>) {
    const type = String(event.e ?? "");
    if (type === "executionReport") {
      return this.guard.observeOrder({
        leg: "spot",
        clientOrderId: String(event.c ?? ""),
        providerOrderId: String(event.i ?? ""),
        eventTime: Number(event.T ?? event.E),
        terminal: ["FILLED", "CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"].includes(String(event.X ?? "")),
        accountChangeExpected: Number(event.l ?? 0) > 0,
      });
    }
    if (["outboundAccountPosition", "balanceUpdate", "externalLockUpdate"].includes(type)) {
      return this.guard.observeAccountChange("spot", `spot_${type}`, Number(event.u ?? event.T ?? event.E));
    }
    if (["eventStreamTerminated", "listenKeyExpired"].includes(type)) {
      return this.guard.markDisconnected("spot", `spot_${type}`);
    }
    this.guard.observeUnknownEvent(`spot_${type}`);
  }

  private handleFuturesEvent(event: Record<string, unknown>) {
    const type = String(event.e ?? "");
    if (type === "ORDER_TRADE_UPDATE") {
      const order = record(event.o);
      return this.guard.observeOrder({
        leg: "futures",
        clientOrderId: String(order.c ?? ""),
        providerOrderId: String(order.i ?? ""),
        eventTime: Number(event.T ?? event.E),
        terminal: ["FILLED", "CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"].includes(String(order.X ?? "")),
        accountChangeExpected: Number(order.l ?? 0) > 0,
      });
    }
    if (type === "ACCOUNT_UPDATE") {
      return this.guard.observeAccountChange("futures", `futures_${type}`, Number(event.T ?? event.E));
    }
    if (type === "ACCOUNT_CONFIG_UPDATE") {
      const config = record(event.ac);
      return this.guard.observeAccountConfigUpdate(String(config.s ?? ""), Number(config.l));
    }
    if (type === "MARGIN_CALL") {
      return this.guard.observeAccountChange("futures", `futures_${type}`, Number(event.T ?? event.E));
    }
    if (type === "listenKeyExpired") return this.guard.markDisconnected("futures", "futures_listenKeyExpired");
    this.guard.observeUnknownEvent(`futures_${type}`);
  }

  private bindFailure(socket: WebSocket, leg: RwaBinanceActivityLeg, reject: (error: Error) => void) {
    socket.once("error", (error) => {
      this.guard.markDisconnected(leg, `${leg}_stream_error`);
      reject(error);
    });
    socket.once("close", () => this.guard.markDisconnected(leg));
  }

  private closeSocketsOnly() {
    const hadActiveStream = this.spot !== null || this.futures !== null;
    this.spot?.close();
    this.futures?.close();
    this.spot = null;
    this.futures = null;
    if (hadActiveStream) this.guard.resetForRestart();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
