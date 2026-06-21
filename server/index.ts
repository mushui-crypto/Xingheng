import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { registerMarketRoutes } from "./modules/api/marketRoutes";
import { toPublicKlineMessage } from "./modules/kline/klineFormat";
import { KlineStore } from "./modules/kline/KlineStore";
import { BinanceMarketService } from "./modules/market/BinanceMarketService";
import { defaultMarketSymbols, normalizeInterval, normalizeSymbol } from "./modules/market/marketConfig";
import { TradingService } from "./market/TradingService";
import type { MarketSymbol, MarketTick, TradeSide } from "./types";

dotenv.config();

const port = Number(process.env.API_PORT ?? 8787);
const app = express();
app.use(cors());
app.use(express.json());

const klineStore = new KlineStore();
const market = new BinanceMarketService(klineStore);
await market.start();

const tradingMarket = {
  getSymbol(symbol: string) {
    const normalized = symbol.toUpperCase();
    return defaultMarketSymbols.find((item) => item.symbol === normalized || item.apiSymbol === normalized) ?? null;
  },
  getTicker(symbol: string) {
    const normalized = normalizeSymbol(symbol);
    const config = this.getSymbol(normalized);
    const ticker = market.getTicker(normalized);
    return {
      ...ticker,
      tick: ticker.tick && config ? applyConfiguredSpread(ticker.tick, config) : ticker.tick,
    };
  },
};

const trading = new TradingService(tradingMarket);

registerMarketRoutes(app, market);

app.get("/api/trading/account", (request, response) => {
  response.json(trading.getAccount(getUserId(request), String(request.query.currency ?? "USD")));
});

app.get("/api/trading/positions", (request, response) => {
  response.json(trading.listPositions(getUserId(request)));
});

app.get("/api/trading/orders", (request, response) => {
  response.json(trading.listOrders(getUserId(request)));
});

app.post("/api/trading/order", (request, response) => {
  try {
    const symbol = normalizeSymbol(String(request.body?.symbol ?? "BTCUSDT"));
    const side = normalizeSide(request.body?.side);
    const volume = Number(request.body?.volume);
    response.json(trading.marketOrder(getUserId(request), symbol, side, volume));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

app.post("/api/trading/positions/:positionId/close", (request, response) => {
  try {
    response.json(trading.closePosition(getUserId(request), request.params.positionId));
  } catch (error) {
    sendBadRequest(response, error);
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

app.post("/api/admin/accounts/:userId/adjust-balance", (request, response) => {
  try {
    const type = request.body?.type;
    if (type !== "deposit" && type !== "withdraw" && type !== "reset") {
      throw new Error("资金调整类型不正确。");
    }
    response.json(trading.adjustBalance(request.params.userId, type, Number(request.body?.amount), request.body?.note));
  } catch (error) {
    sendBadRequest(response, error);
  }
});

const server = app.listen(port, () => {
  console.log(`[api] listening on http://127.0.0.1:${port}`);
});

registerSocketHub(server, market);

function registerSocketHub(httpServer: typeof server, marketService: BinanceMarketService) {
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
  const marketSubscriptions = new Map<WebSocket, Set<string>>();
  const legacySubscriptions = new Map<WebSocket, Set<string>>();

  wss.on("connection", (socket, request) => {
    const path = request.url?.split("?")[0] ?? "/ws/market";
    const isMarketSocket = path === "/ws/market";
    const subscriptions = isMarketSocket ? marketSubscriptions : legacySubscriptions;
    subscriptions.set(socket, new Set());
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as Record<string, string>;
        if (message.type !== "subscribe") {
          return;
        }

        if (isMarketSocket) {
          const symbol = normalizeSymbol(message.symbol ?? "BTCUSDT");
          const interval = normalizeInterval(message.interval ?? "1m");
          subscriptions.get(socket)?.add(`${symbol}:${interval}`);
          return;
        }

        if (message.channel === "ticker") {
          subscriptions.get(socket)?.add(`ticker:${normalizeSymbol(message.symbol ?? "BTCUSDT")}`);
        }
        if (message.channel === "candle") {
          const interval = normalizeInterval(message.interval ?? "1m");
          subscriptions.get(socket)?.add(`candle:${normalizeSymbol(message.symbol ?? "BTCUSDT")}:${interval}`);
        }
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "invalid message" }));
      }
    });
    socket.on("close", () => subscriptions.delete(socket));
  });

  marketService.on("tick", (tick) => {
    const config = tradingMarket.getSymbol(tick.symbol);
    const quote = config ? applyConfiguredSpread(tick, config) : tick;
    broadcast(legacySubscriptions, `ticker:${tick.symbol}`, {
      type: "ticker",
      symbol: quote.symbol,
      bid: quote.bid,
      ask: quote.ask,
      last: quote.last,
      spread: quote.spread,
      source: quote.source,
      status: marketService.getStatus(quote.symbol),
      timestamp: quote.timestamp,
    });
  });

  marketService.on("status", (symbol, status) => {
    const ticker = tradingMarket.getTicker(symbol);
    broadcast(legacySubscriptions, `ticker:${symbol}`, {
      type: "ticker",
      symbol,
      status,
      ...(ticker.tick ?? {}),
    });
  });

  marketService.on("kline", (candle) => {
    broadcast(marketSubscriptions, `${candle.symbol}:${candle.interval}`, toPublicKlineMessage(candle));
    broadcast(legacySubscriptions, `candle:${candle.symbol}:${candle.interval}`, {
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
}

function broadcast(subscriptions: Map<WebSocket, Set<string>>, key: string, payload: unknown) {
  for (const [socket, keys] of subscriptions) {
    if (socket.readyState === socket.OPEN && keys.has(key)) {
      socket.send(JSON.stringify(payload));
    }
  }
}

function normalizeSide(value: unknown): TradeSide {
  if (value !== "buy" && value !== "sell") {
    throw new Error("订单方向必须是 buy 或 sell。");
  }
  return value;
}

function applyConfiguredSpread(tick: MarketTick, config: MarketSymbol): MarketTick {
  const spread = config.spread;
  const halfSpread = spread / 2;
  return {
    ...tick,
    bid: Number((tick.last - halfSpread).toFixed(config.digits)),
    ask: Number((tick.last + halfSpread).toFixed(config.digits)),
    spread,
  };
}

function getUserId(request: express.Request) {
  const header = request.header("x-user-id");
  return header?.trim() || "demo-user";
}

function sendBadRequest(response: express.Response, error: unknown) {
  response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
}

process.on("SIGINT", async () => {
  await market.stop();
  server.close();
  process.exit(0);
});
