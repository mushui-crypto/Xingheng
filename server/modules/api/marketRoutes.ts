import type express from "express";
import { toPublicKline } from "../kline/klineFormat";
import type { BinanceMarketService } from "../market/BinanceMarketService";
import { defaultMarketSymbols, normalizeInterval, normalizeLimit, normalizeSymbol, supportedCryptoSymbols, supportedIntervals } from "../market/marketConfig";
import type { MarketSymbol, MarketTick } from "../../types";

export function registerMarketRoutes(app: express.Express, market: BinanceMarketService) {
  app.get("/symbols", (_request, response) => {
    response.json({
      symbols: supportedCryptoSymbols,
      items: defaultMarketSymbols.map((symbol) => ({
        symbol: symbol.symbol,
        displayName: symbol.displayName,
        status: market.getStatus(symbol.symbol),
      })),
    });
  });

  app.get("/klines", async (request, response) => {
    try {
      const symbol = normalizeSymbol(String(request.query.symbol ?? "BTCUSDT"));
      const interval = normalizeInterval(String(request.query.interval ?? "1m"));
      const limit = normalizeLimit(request.query.limit);
      const candles = await market.getKlines(symbol, interval, limit);
      response.json(candles.map(toPublicKline));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
    }
  });

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      source: "binance",
      symbols: supportedCryptoSymbols,
      intervals: supportedIntervals,
      storage: "memory",
    });
  });

  app.get("/api/market/symbols", (_request, response) => {
    response.json(
      defaultMarketSymbols.map((symbol) => ({
        ...symbol,
        status: market.getStatus(symbol.symbol),
      })),
    );
  });

  app.put("/api/market/symbols/config", (_request, response) => {
    response.json(
      defaultMarketSymbols.map((symbol) => ({
        ...symbol,
        status: market.getStatus(symbol.symbol),
      })),
    );
  });

  app.get("/api/market/ticker", (request, response) => {
    try {
      const symbol = normalizeSymbol(String(request.query.symbol ?? "BTCUSDT"));
      const ticker = market.getTicker(symbol);
      const config = getSymbolConfig(symbol);
      const tick = ticker.tick && config ? applyConfiguredSpread(ticker.tick, config) : ticker.tick;
      response.json({
        symbol,
        status: ticker.status,
        ...(tick ?? {}),
      });
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
    }
  });

  app.get("/api/market/candles", async (request, response) => {
    try {
      const symbol = normalizeSymbol(String(request.query.symbol ?? "BTCUSDT"));
      const interval = normalizeInterval(String(request.query.interval ?? "1m"));
      const limit = normalizeLimit(request.query.limit);
      const candles = await market.getKlines(symbol, interval, limit);
      response.json(candles);
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
    }
  });

  app.get("/api/admin/market/status", (_request, response) => {
    response.json(
      defaultMarketSymbols.map((symbol) => ({
        symbol: symbol.symbol,
        apiSymbol: symbol.apiSymbol,
        displayName: symbol.displayName,
        tradeStatus: symbol.tradeStatus,
        status: market.getStatus(symbol.symbol),
        ticker: withConfiguredSpread(market.getTicker(symbol.symbol).tick ?? null, symbol),
      })),
    );
  });
}

function getSymbolConfig(symbol: string) {
  return defaultMarketSymbols.find((item) => item.symbol === symbol || item.apiSymbol === symbol) ?? null;
}

function withConfiguredSpread(tick: MarketTick | null, config: MarketSymbol) {
  return tick ? applyConfiguredSpread(tick, config) : null;
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
