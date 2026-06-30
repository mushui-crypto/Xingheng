import type express from "express";
import type { BinanceMarketService } from "../market/BinanceMarketService";
import { defaultMarketSymbols, normalizeInterval, normalizeLimit, normalizeSymbol, supportedCryptoSymbols, supportedIntervals } from "../market/marketConfig";
import type { MarketSymbol, MarketTick } from "../../types";
import type { TradingStore } from "../../storage/TradingStore";

const editableMarketSymbols = new Map<string, MarketSymbol>(defaultMarketSymbols.map((symbol) => [symbol.symbol, { ...symbol }]));

export function registerMarketRoutes(app: express.Express, market: BinanceMarketService, store?: TradingStore) {
  loadPersistedMarketSymbols(store);

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
      getMarketSymbols().map((symbol) => ({
        ...symbol,
        status: market.getStatus(symbol.symbol),
      })),
    );
  });

  app.put("/api/market/symbols/config", (request, response) => {
    try {
      const nextSymbols = updateMarketSymbolsConfig(request.body?.symbols, store);
      response.json(
        nextSymbols.map((symbol) => ({
          ...symbol,
          status: market.getStatus(symbol.symbol),
        })),
      );
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
    }
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
      getMarketSymbols().map((symbol) => ({
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
  return getMarketSymbols().find((item) => item.symbol === symbol || item.apiSymbol === symbol) ?? null;
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

export function getEditableMarketSymbol(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  return editableMarketSymbols.get(normalized) ?? null;
}

function getMarketSymbols() {
  return supportedCryptoSymbols.map((symbol) => {
    const configured = editableMarketSymbols.get(symbol);
    const fallback = defaultMarketSymbols.find((item) => item.symbol === symbol);
    return configured ?? fallback;
  }).filter((symbol): symbol is MarketSymbol => Boolean(symbol));
}

function updateMarketSymbolsConfig(input: unknown, store?: TradingStore) {
  if (!Array.isArray(input)) {
    throw new Error("品种配置必须是 symbols 数组。");
  }
  if (input.length !== 1) {
    throw new Error("当前 MVP 只允许编辑 BTCUSDT，不允许新增其他品种。");
  }

  const incoming = input[0] as Partial<MarketSymbol>;
  const current = editableMarketSymbols.get("BTCUSDT") ?? defaultMarketSymbols[0];
  if (String(incoming.symbol ?? "").toUpperCase() !== current.symbol) {
    throw new Error("当前 MVP 只允许编辑 BTCUSDT，不允许新增或修改 symbol。");
  }
  if (String(incoming.apiSymbol ?? "").toUpperCase() !== current.apiSymbol) {
    throw new Error("apiSymbol 固定为 BTCUSDT，当前不允许修改。");
  }

  const next: MarketSymbol = {
    ...current,
    displayName: normalizeNonEmptyString(incoming.displayName, "displayName"),
    spread: normalizePositiveNumber(incoming.spread, "spread"),
    leverage: normalizePositiveNumber(incoming.leverage, "leverage"),
    contractSize: normalizePositiveNumber(incoming.contractSize, "contractSize"),
    minLot: normalizePositiveNumber(incoming.minLot, "minLot"),
    maxLot: normalizePositiveNumber(incoming.maxLot, "maxLot"),
    lotStep: normalizePositiveNumber(incoming.lotStep, "lotStep"),
    tradeStatus: normalizeTradeStatus(incoming.tradeStatus),
    isVisible: normalizeBoolean(incoming.isVisible, "isVisible"),
  };

  if (next.maxLot < next.minLot) {
    throw new Error("maxLot 不能小于 minLot。");
  }
  editableMarketSymbols.set(next.symbol, next);
  store?.upsertMarketSymbol(next);
  return getMarketSymbols();
}

function loadPersistedMarketSymbols(store?: TradingStore) {
  if (!store) {
    return;
  }

  const persisted = store.getMarketSymbol("BTCUSDT");
  if (!persisted) {
    return;
  }
  if (persisted.symbol !== "BTCUSDT" || persisted.apiSymbol !== "BTCUSDT") {
    return;
  }
  editableMarketSymbols.set(persisted.symbol, persisted);
}

function normalizeNonEmptyString(value: unknown, field: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${field} 不能为空。`);
  }
  return normalized;
}

function normalizePositiveNumber(value: unknown, field: string) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} 必须大于 0。`);
  }
  return normalized;
}

function normalizeTradeStatus(value: unknown): MarketSymbol["tradeStatus"] {
  if (value !== "enabled" && value !== "close_only" && value !== "disabled") {
    throw new Error("tradeStatus 必须是 enabled、close_only 或 disabled。");
  }
  return value;
}

function normalizeBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") {
    throw new Error(`${field} 必须是布尔值。`);
  }
  return value;
}
