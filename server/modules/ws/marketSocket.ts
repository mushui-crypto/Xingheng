import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { toPublicKlineMessage } from "../kline/klineFormat";
import type { BinanceMarketService } from "../market/BinanceMarketService";
import { normalizeInterval, normalizeSymbol } from "../market/marketConfig";

export function registerMarketSocket(server: Server, market: BinanceMarketService) {
  const wss = new WebSocketServer({ server, path: "/ws/market", perMessageDeflate: false });
  const subscriptions = new Map<WebSocket, Set<string>>();

  wss.on("connection", (socket) => {
    subscriptions.set(socket, new Set());
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as Record<string, string>;
        if (message.type !== "subscribe") {
          return;
        }

        const symbol = normalizeSymbol(message.symbol ?? "BTCUSDT");
        const interval = normalizeInterval(message.interval ?? "1m");
        subscriptions.get(socket)?.add(`${symbol}:${interval}`);
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "invalid message" }));
      }
    });
    socket.on("close", () => subscriptions.delete(socket));
  });

  market.on("kline", (candle) => {
    const key = `${candle.symbol}:${candle.interval}`;
    const payload = JSON.stringify(toPublicKlineMessage(candle));
    for (const [socket, keys] of subscriptions) {
      if (socket.readyState === socket.OPEN && keys.has(key)) {
        socket.send(payload);
      }
    }
  });

  return wss;
}
