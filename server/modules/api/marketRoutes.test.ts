import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { MarketSymbol, MarketTick } from "../../types";
import { registerMarketRoutes } from "./marketRoutes";

test("market catalog responses keep stale persisted symbols disabled without failing active status reads", async () => {
  const active = marketSymbol("BTCUSDT", { tradeStatus: "enabled", isVisible: true });
  const stale = marketSymbol("HYNA-BCHUSDT", { tradeStatus: "enabled", isVisible: true });
  const store = new StoreStub([stale]);
  const market = {
    getMarketSymbols: () => [active],
    getStatus(symbol: string) {
      if (symbol !== active.symbol) throw new Error(`unsupported symbol: ${symbol}`);
      return "connected" as const;
    },
    getTicker(symbol: string) {
      if (symbol !== active.symbol) throw new Error(`unsupported symbol: ${symbol}`);
      return {
        symbol,
        status: "connected" as const,
        tick: {
          symbol,
          bid: 60_000,
          ask: 60_001,
          last: 60_000.5,
          spread: 1,
          source: "hyperliquid" as const,
          timestamp: 1_700_000_000_000,
        } satisfies MarketTick,
      };
    },
  };
  const app = express();
  app.use(express.json());
  registerMarketRoutes(app, market as any, store as any);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const symbolsResponse = await fetch(`${base}/api/market/symbols`);
    assert.equal(symbolsResponse.status, 200);
    const symbols = await symbolsResponse.json() as any[];
    assert.equal(symbols.find((symbol) => symbol.symbol === active.symbol)?.status, "connected");
    const staleSymbol = symbols.find((symbol) => symbol.symbol === stale.symbol);
    assert.equal(staleSymbol?.status, "disconnected");
    assert.equal(staleSymbol?.tradeStatus, "disabled");
    assert.equal(staleSymbol?.isVisible, false);

    const adminStatusResponse = await fetch(`${base}/api/admin/market/status`);
    assert.equal(adminStatusResponse.status, 200);
    const adminStatus = await adminStatusResponse.json() as any[];
    const staleStatus = adminStatus.find((symbol) => symbol.symbol === stale.symbol);
    assert.equal(staleStatus?.status, "disconnected");
    assert.equal(staleStatus?.ticker, null);

    const configResponse = await fetch(`${base}/api/admin/market/symbols/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: [active] }),
    });
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json() as any[];
    assert.equal(config.find((symbol) => symbol.symbol === stale.symbol)?.status, "disconnected");

    const unknownTickerResponse = await fetch(`${base}/api/market/ticker?symbol=${encodeURIComponent(stale.symbol)}`);
    assert.equal(unknownTickerResponse.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function marketSymbol(symbol: string, overrides: Partial<MarketSymbol> = {}): MarketSymbol {
  return {
    symbol,
    displayName: symbol.replace(/USDT$/, "/USDT"),
    apiSymbol: symbol,
    providerMarketId: symbol.replace(/USDT$/, ""),
    providerCoin: symbol.replace(/USDT$/, ""),
    sourceDex: "main",
    sourceType: "main",
    category: "crypto",
    digits: 2,
    spread: 1,
    leverage: 20,
    contractSize: 1,
    minLot: 0.001,
    maxLot: 10,
    lotStep: 0.001,
    tradeStatus: "enabled",
    isVisible: true,
    ...overrides,
  };
}

class StoreStub {
  private symbols: MarketSymbol[];

  constructor(symbols: MarketSymbol[]) {
    this.symbols = [...symbols];
  }

  listMarketSymbols() {
    return [...this.symbols];
  }

  upsertMarketSymbol(symbol: MarketSymbol) {
    const index = this.symbols.findIndex((value) => value.symbol === symbol.symbol);
    if (index >= 0) {
      this.symbols[index] = symbol;
    } else {
      this.symbols.push(symbol);
    }
  }
}
