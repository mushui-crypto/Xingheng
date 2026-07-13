import type express from "express";
import type { MarketSymbol, MarketTick } from "../../types";
import type { TradingStore } from "../../storage/TradingStore";
import type { HyperliquidMarketService } from "../market/HyperliquidMarketService";
import { normalizeInterval, normalizeLimit, normalizeSymbol, supportedIntervals } from "../market/marketConfig";

const editableMarketSymbols = new Map<string, MarketSymbol>();

export function registerMarketRoutes(app: express.Express, market: HyperliquidMarketService, store?: TradingStore) {
  syncCatalog(market, store);

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      source: "hyperliquid",
      symbols: getMarketSymbols().map((symbol) => symbol.symbol),
      symbolCount: getMarketSymbols().length,
      intervals: supportedIntervals,
      storage: "memory",
    });
  });

  app.get("/api/market/symbols", (_request, response) => {
    response.json(getMarketSymbols().map((symbol) => withMarketIconUrl({ ...symbol, status: market.getStatus(symbol.symbol) })));
  });

  app.put("/api/admin/market/symbols/config", (request, response) => {
    try {
      response.json(updateMarketSymbolsConfig(request.body?.symbols, store).map((symbol) => withMarketIconUrl({
        ...symbol,
        status: market.getStatus(symbol.symbol),
      })));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
    }
  });

  app.get("/api/market/ticker", (request, response) => {
    try {
      const symbol = normalizeSymbol(String(request.query.symbol ?? "BTCUSDT"));
      const ticker = market.getTicker(symbol);
      const config = getEditableMarketSymbol(symbol);
      response.json({ symbol, status: ticker.status, ...(ticker.tick && config ? applyConfiguredSpread(ticker.tick, config) : ticker.tick) });
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
    }
  });

  app.get("/api/market/summary", async (request, response) => {
    try {
      const symbol = normalizeSymbol(String(request.query.symbol ?? "BTCUSDT"));
      response.json(await market.getSummary(symbol));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
    }
  });

  app.get("/api/market/orderbook", async (request, response) => {
    try {
      const symbol = normalizeSymbol(String(request.query.symbol ?? "BTCUSDT"));
      response.json(await market.getOrderbook(symbol));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
    }
  });

  app.get("/api/market/trades", async (request, response) => {
    try {
      const symbol = normalizeSymbol(String(request.query.symbol ?? "BTCUSDT"));
      response.json(await market.getTrades(symbol));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
    }
  });

  app.get("/api/market/candles", async (request, response) => {
    try {
      const symbol = normalizeSymbol(String(request.query.symbol ?? "BTCUSDT"));
      const candles = await market.getKlines(symbol, normalizeInterval(String(request.query.interval ?? "1m")), normalizeLimit(request.query.limit));
      response.json(candles);
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "bad request" });
    }
  });

  app.get("/api/admin/market/status", (_request, response) => {
    response.json(getMarketSymbols().map((symbol) => ({
      symbol: symbol.symbol,
      apiSymbol: symbol.apiSymbol,
      providerMarketId: symbol.providerMarketId,
      providerCoin: symbol.providerCoin,
      sourceDex: symbol.sourceDex,
      sourceType: symbol.sourceType,
      category: symbol.category,
      iconUrl: buildDemoMarketIconUrl(symbol.providerMarketId),
      displayName: symbol.displayName,
      tradeStatus: symbol.tradeStatus,
      status: market.getStatus(symbol.symbol),
      ticker: withConfiguredSpread(market.getTicker(symbol.symbol).tick ?? null, symbol),
    })));
  });
}

export function getEditableMarketSymbol(symbol: string) {
  return editableMarketSymbols.get(normalizeSymbol(symbol)) ?? null;
}

function getMarketSymbols() {
  return [...editableMarketSymbols.values()].sort((a, b) => {
    if (a.isVisible !== b.isVisible) return a.isVisible ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
}

function withMarketIconUrl<T extends MarketSymbol>(symbol: T) {
  return {
    ...symbol,
    iconUrl: buildDemoMarketIconUrl(symbol.providerMarketId),
  };
}

export function buildDemoMarketIconUrl(providerMarketId: unknown) {
  const marketId = String(providerMarketId ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(marketId)) {
    return null;
  }
  return `https://app.hyperliquid.xyz/coins/${marketId}.svg`;
}

function syncCatalog(market: HyperliquidMarketService, store?: TradingStore) {
  const persisted = new Map((store?.listMarketSymbols() ?? []).map((symbol) => [symbol.symbol, symbol]));
  const activeSymbols = new Set<string>();
  for (const provider of market.getMarketSymbols()) {
    activeSymbols.add(provider.symbol);
    const saved = persisted.get(provider.symbol);
    const merged: MarketSymbol = saved
        ? {
          ...provider,
          displayName: saved.displayName,
          category: saved.category,
          spread: saved.spread,
          leverage: Math.min(saved.leverage, provider.leverage),
          contractSize: saved.contractSize,
          maxLot: saved.maxLot,
          tradeStatus: saved.tradeStatus,
          isVisible: saved.isVisible,
        }
      : provider;
    editableMarketSymbols.set(merged.symbol, merged);
    store?.upsertMarketSymbol(merged);
  }
  for (const saved of persisted.values()) {
    if (!activeSymbols.has(saved.symbol)) {
      const disabled = { ...saved, tradeStatus: "disabled" as const, isVisible: false };
      editableMarketSymbols.set(disabled.symbol, disabled);
      store?.upsertMarketSymbol(disabled);
    }
  }
}

function updateMarketSymbolsConfig(input: unknown, store?: TradingStore) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("品种配置必须是非空 symbols 数组。");
  for (const value of input) {
    const incoming = value as Partial<MarketSymbol>;
    const symbol = normalizeSymbol(String(incoming.symbol ?? ""));
    const current = editableMarketSymbols.get(symbol);
    if (!current) throw new Error(`品种 ${symbol} 不存在。`);
    if (String(incoming.apiSymbol ?? "") !== current.apiSymbol) throw new Error(`${symbol} 的 apiSymbol 不允许修改。`);
    if (
      incoming.providerMarketId !== undefined &&
      String(incoming.providerMarketId) !== current.providerMarketId
    ) {
      throw new Error(`${symbol} 的 providerMarketId 不允许修改。`);
    }
    if (incoming.sourceDex !== undefined && String(incoming.sourceDex) !== current.sourceDex) {
      throw new Error(`${symbol} 的 sourceDex 不允许修改。`);
    }
    if (incoming.sourceType !== undefined && String(incoming.sourceType) !== current.sourceType) {
      throw new Error(`${symbol} 的 sourceType 不允许修改。`);
    }
    const next: MarketSymbol = {
      ...current,
      displayName: normalizeNonEmptyString(incoming.displayName, "displayName"),
      category: normalizeCategory(incoming.category ?? current.category),
      spread: normalizePositiveNumber(incoming.spread, "spread"),
      leverage: normalizePositiveNumber(incoming.leverage, "leverage"),
      contractSize: normalizePositiveNumber(incoming.contractSize, "contractSize"),
      minLot: current.minLot,
      maxLot: normalizePositiveNumber(incoming.maxLot, "maxLot"),
      lotStep: current.lotStep,
      tradeStatus: normalizeTradeStatus(incoming.tradeStatus),
      isVisible: normalizeBoolean(incoming.isVisible, "isVisible"),
    };
    if (next.maxLot < next.minLot) throw new Error("maxLot 不能小于 minLot。");
    editableMarketSymbols.set(symbol, next);
    store?.upsertMarketSymbol(next);
  }
  return getMarketSymbols();
}

function withConfiguredSpread(tick: MarketTick | null, config: MarketSymbol) {
  return tick ? applyConfiguredSpread(tick, config) : null;
}

function applyConfiguredSpread(tick: MarketTick, config: MarketSymbol): MarketTick {
  const halfSpread = config.spread / 2;
  return {
    ...tick,
    bid: Number((tick.last - halfSpread).toFixed(config.digits)),
    ask: Number((tick.last + halfSpread).toFixed(config.digits)),
    spread: config.spread,
  };
}

function normalizeNonEmptyString(value: unknown, field: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${field} 不能为空。`);
  return normalized;
}
function normalizePositiveNumber(value: unknown, field: string) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) throw new Error(`${field} 必须大于 0。`);
  return normalized;
}
function normalizeTradeStatus(value: unknown): MarketSymbol["tradeStatus"] {
  if (value !== "enabled" && value !== "close_only" && value !== "disabled") throw new Error("tradeStatus 不正确。");
  return value;
}
function normalizeCategory(value: unknown): MarketSymbol["category"] {
  if (value !== "crypto" && value !== "metals" && value !== "us_equities" && value !== "indices" && value !== "other") {
    throw new Error("category 不正确。");
  }
  return value;
}
function normalizeBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") throw new Error(`${field} 必须是布尔值。`);
  return value;
}
