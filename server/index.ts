import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { CandleAggregator, intervals } from "./market/CandleAggregator";
import { MarketDataService } from "./market/MarketDataService";
import { TradingService } from "./market/TradingService";
import { HybridCandleStore } from "./storage/HybridCandleStore";
import type { CandleInterval, MarketSymbol, MarketTick } from "./types";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.API_PORT ?? 8787);
const app = express();
app.use(cors());
app.use(express.json());

const store = new HybridCandleStore(path.resolve(__dirname, "data/candles.json"));
const aggregator = new CandleAggregator(store);
await aggregator.init();

const market = new MarketDataService(aggregator);
const trading = new TradingService(market);
await market.start();

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, source: process.env.TRADERMADE_API_KEY ? "tradermade" : "mock" });
});

app.get("/api/market/symbols", (_request, response) => {
  response.json(
    market.symbols.map((symbol) => ({
      ...symbol,
      status: market.getStatus(symbol.symbol),
    })),
  );
});

app.put("/api/market/symbols/config", async (request, response) => {
  const symbols = Array.isArray(request.body?.symbols) ? (request.body.symbols as MarketSymbol[]) : [];
  await market.configureSymbols(symbols);
  response.json(
    market.symbols.map((symbol) => ({
      ...symbol,
      status: market.getStatus(symbol.symbol),
    })),
  );
});

app.get("/api/market/ticker", (request, response) => {
  const symbol = String(request.query.symbol ?? "XAUUSD").toUpperCase();
  const ticker = market.getTicker(symbol);
  response.json({
    symbol,
    status: ticker.status,
    ...(ticker.tick ?? {}),
  });
});

app.get("/api/market/candles", async (request, response) => {
  const symbol = String(request.query.symbol ?? "XAUUSD").toUpperCase();
  const interval = normalizeInterval(String(request.query.interval ?? "1m"));
  const limit = Math.min(Number(request.query.limit ?? 500), 1000);
  const candles = await aggregator.getCandles(symbol, interval, limit);
  response.json(candles);
});

app.get("/api/trading/account", (request, response) => {
  response.json(trading.getAccount(getUserId(request), String(request.query.currency ?? "USD").toUpperCase()));
});

app.get("/api/trading/positions", (request, response) => {
  response.json(trading.listPositions(getUserId(request)));
});

app.get("/api/trading/orders", (request, response) => {
  response.json(trading.listOrders(getUserId(request)));
});

app.post("/api/trading/order", (request, response) => {
  try {
    const symbol = String(request.body.symbol ?? "XAUUSD").toUpperCase();
    const side = request.body.side === "sell" ? "sell" : "buy";
    const volume = Number(request.body.volume ?? 1);
    if (!Number.isFinite(volume) || volume <= 0) {
      response.status(400).json({ message: "volume must be greater than 0" });
      return;
    }
    response.json(trading.marketOrder(getUserId(request), symbol, side, volume));
  } catch (error) {
    response.status(409).json({ message: error instanceof Error ? error.message : "order rejected" });
  }
});

app.post("/api/trading/positions/:id/close", (request, response) => {
  try {
    response.json(trading.closePosition(getUserId(request), request.params.id));
  } catch (error) {
    response.status(409).json({ message: error instanceof Error ? error.message : "close rejected" });
  }
});

app.get("/api/admin/accounts", (_request, response) => {
  response.json(trading.listAccounts());
});

app.get("/api/admin/positions", (_request, response) => {
  response.json(trading.listPositions());
});

app.get("/api/admin/orders", (_request, response) => {
  response.json(trading.listOrders());
});

app.post("/api/admin/accounts/:id/adjust-balance", (request, response) => {
  try {
    const type = request.body.type === "withdraw" ? "withdraw" : request.body.type === "reset" ? "reset" : "deposit";
    const amount = Number(request.body.amount ?? 0);
    response.json(trading.adjustBalance(request.params.id, type, amount, String(request.body.note ?? "")));
  } catch (error) {
    response.status(400).json({ message: error instanceof Error ? error.message : "balance adjustment failed" });
  }
});

app.get("/api/admin/market/status", (_request, response) => {
  response.json(
    market.symbols.map((symbol) => ({
      symbol: symbol.symbol,
      apiSymbol: symbol.apiSymbol,
      displayName: symbol.displayName,
      tradeStatus: symbol.tradeStatus,
      status: market.getStatus(symbol.symbol),
      ticker: market.getTicker(symbol.symbol).tick ?? null,
    })),
  );
});

const server = app.listen(port, () => {
  console.log(`[api] listening on http://127.0.0.1:${port}`);
});

const wss = new WebSocketServer({ server, path: "/ws" });
const subscriptions = new Map<WebSocket, Set<string>>();

wss.on("connection", (socket) => {
  subscriptions.set(socket, new Set());
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw)) as Record<string, string>;
      if (message.type !== "subscribe") {
        return;
      }
      if (message.channel === "ticker") {
        subscriptions.get(socket)?.add(`ticker:${message.symbol?.toUpperCase() ?? "XAUUSD"}`);
      }
      if (message.channel === "candle") {
        const interval = normalizeInterval(message.interval ?? "1m");
        subscriptions.get(socket)?.add(`candle:${message.symbol?.toUpperCase() ?? "XAUUSD"}:${interval}`);
      }
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "invalid message" }));
    }
  });
  socket.on("close", () => subscriptions.delete(socket));
});

market.on("tick", (tick) => {
  broadcast(`ticker:${tick.symbol}`, {
    type: "ticker",
    symbol: tick.symbol,
    bid: tick.bid,
    ask: tick.ask,
    last: tick.last,
    spread: tick.spread,
    source: tick.source,
    status: market.getStatus(tick.symbol),
    timestamp: tick.timestamp,
  });
});

market.on("status", (symbol, status) => {
  const ticker = market.getTicker(symbol);
  broadcast(`ticker:${symbol}`, {
    type: "ticker",
    symbol,
    status,
    ...(ticker.tick ?? {}),
  });
});

aggregator.on("candle", (candle) => {
  broadcast(`candle:${candle.symbol}:${candle.interval}`, {
    type: "candle",
    symbol: candle.symbol,
    interval: candle.interval,
    data: {
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    },
  });
});

function broadcast(key: string, payload: unknown) {
  for (const [socket, keys] of subscriptions) {
    if (socket.readyState === socket.OPEN && keys.has(key)) {
      socket.send(JSON.stringify(payload));
    }
  }
}

function normalizeInterval(value: string): CandleInterval {
  return intervals.includes(value as CandleInterval) ? (value as CandleInterval) : "1m";
}

function getUserId(request: express.Request) {
  return String(request.header("x-user-id") ?? request.query.userId ?? request.body?.userId ?? "demo-user");
}

process.on("SIGINT", async () => {
  await market.stop();
  server.close();
  process.exit(0);
});
