import type express from "express";
import { sendBadRequest } from "./httpResponses";
import { normalizeAddress, normalizeRealTradingSymbol } from "../hyperliquid/HyperliquidInfoClient";
import type { HyperliquidExchangeProxy } from "../hyperliquid/HyperliquidExchangeProxy";
import type { HyperliquidInfoClient } from "../hyperliquid/HyperliquidInfoClient";

type RealTradingRouteDependencies = {
  app: express.Express;
  info: HyperliquidInfoClient;
  exchange: HyperliquidExchangeProxy;
};

export function registerRealTradingRoutes({ app, info, exchange }: RealTradingRouteDependencies) {
  const exchangeRateLimit = createRealTradingRateLimiter();

  app.get("/api/real-trading/market/symbols", async (_request, response) => {
    try {
      response.json(await info.getSymbols());
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/market/summary", async (request, response) => {
    try {
      response.json(await info.getSummary(normalizeRealTradingSymbol(request.query.symbol)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/market/orderbook", async (request, response) => {
    try {
      response.json(await info.getOrderbook(normalizeRealTradingSymbol(request.query.symbol)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/market/trades", async (request, response) => {
    try {
      response.json(await info.getTrades(normalizeRealTradingSymbol(request.query.symbol)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/market/candles", async (request, response) => {
    try {
      response.json(await info.getCandles(
        normalizeRealTradingSymbol(request.query.symbol),
        String(request.query.interval ?? "1m"),
        request.query.limit,
      ));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/account/summary", async (request, response) => {
    try {
      response.json(await info.getAccountSummary(normalizeAddress(request.query.address)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/account/fees", async (request, response) => {
    try {
      response.json(await info.getFees(normalizeAddress(request.query.address)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/positions", async (request, response) => {
    try {
      response.json(await info.getPositions(normalizeAddress(request.query.address)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/orders/open", async (request, response) => {
    try {
      response.json(await info.getOpenOrders(normalizeAddress(request.query.address)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/real-trading/orders/history", async (request, response) => {
    try {
      response.json(await info.getOrderHistory(normalizeAddress(request.query.address)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/real-trading/exchange", exchangeRateLimit, async (request, response) => {
    try {
      response.json(await exchange.forward(request.body));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });
}

function createRealTradingRateLimiter() {
  const windowMs = 60_000;
  const max = Number(process.env.REAL_TRADING_EXCHANGE_RATE_LIMIT_MAX ?? 30);
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    const key = `${request.user?.id ?? "anonymous"}:${request.ip || request.socket.remoteAddress || "unknown"}`;
    const current = attempts.get(key);
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    entry.count += 1;
    attempts.set(key, entry);
    if (entry.count > Math.max(1, Math.floor(max))) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      response.setHeader("Retry-After", String(retryAfter));
      response.status(429).json({ message: "真实交易请求过于频繁，请稍后再试。" });
      return;
    }
    next();
  };
}
