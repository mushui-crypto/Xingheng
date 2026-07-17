import dotenv from "dotenv";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { UserService } from "./auth/UserService";
import { loadRuntimeConfig } from "./config/runtimeConfig";
import { registerAuthRoutes, registerUserAuthMiddleware } from "./modules/auth/authRoutes";
import { registerAdminTradingRoutes } from "./modules/api/adminTradingRoutes";
import { registerAdminWalletRoutes } from "./modules/api/adminWalletRoutes";
import { getEditableMarketSymbol, registerMarketRoutes } from "./modules/api/marketRoutes";
import { registerRealTradingRoutes } from "./modules/api/realTradingRoutes";
import { registerStrategyRoutes } from "./modules/api/strategyRoutes";
import { registerUserTradingRoutes } from "./modules/api/userTradingRoutes";
import { registerUserWalletRoutes } from "./modules/api/userWalletRoutes";
import { EmailService } from "./modules/email/EmailService";
import { HyperliquidExchangeProxy } from "./modules/hyperliquid/HyperliquidExchangeProxy";
import { getHyperliquidRealTradingConfig } from "./modules/hyperliquid/hyperliquidConfig";
import { HyperliquidInfoClient } from "./modules/hyperliquid/HyperliquidInfoClient";
import { KlineStore } from "./modules/kline/KlineStore";
import { HyperliquidMarketService } from "./modules/market/HyperliquidMarketService";
import { normalizeInterval, normalizeSymbol } from "./modules/market/marketConfig";
import {
  createCorsMiddleware,
  createRejectCrossOriginMutation,
  createSecurityHeaders,
} from "./modules/security/httpSecurity";
import { TradingService } from "./market/TradingService";
import { TradingStore } from "./storage/TradingStore";
import { ForwardPaperWorker } from "./modules/strategy/runtime/ForwardPaperWorker";
import { IctStrategyRuntime } from "./modules/strategy/runtime/IctStrategyRuntime";
import { MartingaleGridPaperWorker } from "./modules/strategy/runtime/MartingaleGridPaperWorker";
import { StrategyEmailNotifier } from "./modules/strategy/runtime/StrategyEmailNotifier";
import { OnchainWalletService } from "./wallet/OnchainWalletService";
import { WalletService } from "./wallet/WalletService";
import type { MarketSymbol, MarketTick } from "./types";

dotenv.config();

const config = loadRuntimeConfig();
const { port } = config;
const app = express();
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}
app.disable("x-powered-by");
app.use(createSecurityHeaders(config.isProduction));
app.use(createCorsMiddleware(config.allowedOrigins));
app.use(createRejectCrossOriginMutation(config.allowedOrigins));
app.use(express.json({ limit: "64kb" }));

const klineStore = new KlineStore();
const market = new HyperliquidMarketService(klineStore);
await market.start();
const strategyRuntime = new IctStrategyRuntime(market, klineStore);
await strategyRuntime.start().catch((error) => {
  console.error("[strategy] ICT shadow runtime failed to start", error instanceof Error ? error.message : error);
});
const tradingStore = new TradingStore();

const tradingMarket = {
  getSymbol(symbol: string) {
    return getEditableMarketSymbol(symbol);
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

const trading = new TradingService(tradingMarket, tradingStore);
const onchainWallet = new OnchainWalletService(tradingStore);
const wallet = new WalletService(tradingStore, trading, onchainWallet);
const email = new EmailService(config);
const strategyNotifier = new StrategyEmailNotifier({ email });
const forwardPaperWorker = new ForwardPaperWorker({ notifier: strategyNotifier });
forwardPaperWorker.start();
const martingaleGridPaperWorker = new MartingaleGridPaperWorker();
martingaleGridPaperWorker.start();
const users = new UserService(tradingStore, email, config.appPublicUrl);
const realTradingConfig = getHyperliquidRealTradingConfig();
const realTradingInfo = new HyperliquidInfoClient(realTradingConfig.baseUrl);
const realTradingExchange = new HyperliquidExchangeProxy(realTradingConfig.baseUrl);
registerAuthRoutes({ app, users, wallet, tradingStore, config });

registerMarketRoutes(app, market, tradingStore);

registerUserAuthMiddleware(app, users);
registerStrategyRoutes(app, strategyRuntime, { forwardPaperWorker, martingaleGridPaperWorker });
registerRealTradingRoutes({ app, info: realTradingInfo, exchange: realTradingExchange });
registerUserTradingRoutes(app, trading);
registerAdminTradingRoutes({ app, trading, users, wallet });
registerUserWalletRoutes(app, wallet);
registerAdminWalletRoutes(app, wallet);

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`[api] listening on http://127.0.0.1:${port}`);
});

const socketHub = registerSocketHub(server, market);

function registerSocketHub(httpServer: typeof server, marketService: HyperliquidMarketService) {
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
  const subscriptions = new Map<WebSocket, Set<string>>();
  const releases = new Map<WebSocket, Map<string, () => void>>();

  wss.on("connection", (socket) => {
    subscriptions.set(socket, new Set());
    releases.set(socket, new Map());
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as Record<string, string>;
        if (message.type !== "subscribe") {
          return;
        }

        if (message.channel === "ticker") {
          const symbol = normalizeSymbol(message.symbol ?? "BTCUSDT");
          const key = `ticker:${symbol}`;
          subscriptions.get(socket)?.add(key);
          if (!releases.get(socket)?.has(key)) {
            releases.get(socket)?.set(key, marketService.addTickerSubscription(symbol));
          }
        }
        if (message.channel === "candle") {
          const interval = normalizeInterval(message.interval ?? "1m");
          const symbol = normalizeSymbol(message.symbol ?? "BTCUSDT");
          const key = `candle:${symbol}:${interval}`;
          subscriptions.get(socket)?.add(key);
          if (!releases.get(socket)?.has(key)) {
            releases.get(socket)?.set(key, marketService.addCandleSubscription(symbol, interval));
          }
        }
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "invalid message" }));
      }
    });
    socket.on("close", () => {
      releases.get(socket)?.forEach((release) => release());
      releases.delete(socket);
      subscriptions.delete(socket);
    });
  });

  marketService.on("tick", (tick) => {
    const config = tradingMarket.getSymbol(tick.symbol);
    const quote = config ? applyConfiguredSpread(tick, config) : tick;
    broadcast(subscriptions, `ticker:${tick.symbol}`, {
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
    broadcast(subscriptions, `ticker:${symbol}`, {
      type: "ticker",
      symbol,
      status,
      ...(ticker.tick ?? {}),
    });
  });

  marketService.on("kline", (candle) => {
    broadcast(subscriptions, `candle:${candle.symbol}:${candle.interval}`, {
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

  return wss;
}

function broadcast(subscriptions: Map<WebSocket, Set<string>>, key: string, payload: unknown) {
  for (const [socket, keys] of subscriptions) {
    if (socket.readyState === socket.OPEN && keys.has(key)) {
      socket.send(JSON.stringify(payload));
    }
  }
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

let shutdownStarted = false;
async function shutdown(signal: string) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[api] received ${signal}, shutting down`);

  const forceExit = setTimeout(() => {
    console.error("[api] graceful shutdown timed out");
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  try {
    forwardPaperWorker.stop();
    martingaleGridPaperWorker.stop();
    strategyRuntime.stop();
    await market.stop();
    for (const client of socketHub.clients) client.terminate();
    await new Promise<void>((resolve, reject) => {
      socketHub.close((socketError) => {
        if (socketError) reject(socketError);
        else resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.close((serverError) => {
        if (serverError) reject(serverError);
        else resolve();
      });
    });
    tradingStore.close();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    console.error("[api] graceful shutdown failed", error);
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
