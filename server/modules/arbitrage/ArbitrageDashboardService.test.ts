import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ArbitrageDashboardService,
  ArbitrageRefreshCooldownError,
  ORDERBOOK_CACHE_TTL_MS,
  orderbookCacheKey,
} from "./ArbitrageDashboardService";
import type { InternalArbitrageMarket } from "./arbitrageTypes";

describe("ArbitrageDashboardService cache and refresh control", () => {
  it("shares the existing raw market snapshot with position presentation reads", async () => {
    let loads = 0;
    const service = new ArbitrageDashboardService({ rawMarketLoader: async () => rawSnapshot(++loads) });
    const market = await service.getCurrentMarketSnapshot();
    await service.getSnapshot(90);
    assert.equal(loads, 1);
    assert.equal(market.generatedAt, 1);
    assert.deepEqual(market.markets, []);
  });
  it("reuses a fresh 20 second snapshot for ordinary requests", async () => {
    let now = 1_000;
    let loads = 0;
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      rawMarketLoader: async () => rawSnapshot(++loads),
    });

    const first = await service.getSnapshot(90);
    now += 19_999;
    const second = await service.getSnapshot(90);

    assert.equal(loads, 1);
    assert.equal(second, first);
  });

  it("serves a stale snapshot immediately while refreshing it in the background", async () => {
    let now = 1_000;
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      rawMarketLoader: async () => {
        loads += 1;
        if (loads === 2) await gate;
        return rawSnapshot(loads);
      },
    });

    const cached = await service.getSnapshot(90);
    now += 20_001;
    const stale = await service.getSnapshot(90);

    assert.equal(stale, cached);
    assert.equal(loads, 2);

    release();
    await nextTurn();
  });

  it("deduplicates the background refresh for concurrent stale-cache callers", async () => {
    let now = 1_000;
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      rawMarketLoader: async () => {
        loads += 1;
        if (loads === 2) await gate;
        return rawSnapshot(loads);
      },
    });

    const cached = await service.getSnapshot(90);
    now += 20_001;
    const results = await Promise.all([
      service.getSnapshot(90),
      service.getSnapshot(90),
      service.getSnapshot(90),
    ]);

    assert.deepEqual(results, [cached, cached, cached]);
    assert.equal(loads, 2);

    release();
    await nextTurn();
  });

  it("replaces a stale snapshot after its background refresh succeeds", async () => {
    let now = 1_000;
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      rawMarketLoader: async () => {
        loads += 1;
        if (loads === 2) await gate;
        return rawSnapshot(loads);
      },
    });

    const cached = await service.getSnapshot(90);
    now += 20_001;
    assert.equal(await service.getSnapshot(90), cached);

    release();
    await nextTurn();

    const refreshed = await service.getSnapshot(90);
    assert.equal(refreshed.generatedAt, 2);
    assert.notEqual(refreshed, cached);
    assert.equal(loads, 2);
  });

  it("keeps a stale snapshot and permits retry after a background refresh failure", async () => {
    let now = 1_000;
    let attempts = 0;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => { warnings.push(values); };
    try {
      const service = new ArbitrageDashboardService({
        now: () => now,
        snapshotTtlMs: 20_000,
        rawMarketLoader: async () => {
          attempts += 1;
          if (attempts === 2) throw new Error("upstream failed");
          return rawSnapshot(attempts);
        },
      });

      const cached = await service.getSnapshot(90);
      now += 20_001;
      assert.equal(await service.getSnapshot(90), cached);
      await nextTurn();

      assert.equal(await service.getSnapshot(90), cached);
      await nextTurn();

      const recovered = await service.getSnapshot(90);
      assert.equal(attempts, 3);
      assert.equal(recovered.generatedAt, 3);
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]?.[0]), /background snapshot refresh failed/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("merges in-flight ordinary requests for the same horizon", async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      rawMarketLoader: async () => {
        loads += 1;
        await gate;
        return rawSnapshot(loads);
      },
    });

    const first = service.getSnapshot(90);
    const second = service.getSnapshot(90);
    release();

    assert.equal(await first, await second);
    assert.equal(loads, 1);
  });

  it("waits for the first snapshot on a cold start", async () => {
    let settled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      rawMarketLoader: async () => {
        await gate;
        return rawSnapshot(1);
      },
    });

    const request = service.getSnapshot(90).then((value) => {
      settled = true;
      return value;
    });
    await nextTurn();
    assert.equal(settled, false);

    release();
    assert.equal((await request).generatedAt, 1);
  });

  it("waits for a new snapshot during a forced refresh", async () => {
    let now = 1_000;
    let loads = 0;
    let settled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      rawMarketLoader: async () => {
        loads += 1;
        if (loads === 2) await gate;
        return rawSnapshot(loads);
      },
    });

    const cached = await service.getSnapshot(90);
    now += 20_001;
    const request = service.getSnapshot(90, true).then((value) => {
      settled = true;
      return value;
    });
    await nextTurn();

    assert.equal(settled, false);
    assert.equal(loads, 2);
    release();

    const refreshed = await request;
    assert.notEqual(refreshed, cached);
    assert.equal(refreshed.generatedAt, 2);
  });

  it("reloads Provider market facts when force refresh is used with a fresh raw snapshot", async () => {
    let loads = 0;
    const service = new ArbitrageDashboardService({
      rawMarketLoader: async () => rawSnapshot(++loads),
    });

    const cached = await service.getSnapshot(90);
    const refreshed = await service.getSnapshot(90, true);

    assert.equal(loads, 2);
    assert.notEqual(refreshed.generatedAt, cached.generatedAt);
  });

  it("serves the old snapshot when refresh cooldown is hit", async () => {
    let now = 10_000;
    let loads = 0;
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      forcedRefreshCooldownMs: 10_000,
      rawMarketLoader: async () => rawSnapshot(++loads),
    });

    const cached = await service.getSnapshot(90);
    const refreshed = await service.getSnapshot(90, true);
    now += 1_000;
    const cooledDown = await service.getSnapshot(90, true);

    assert.equal(loads, 2);
    assert.notEqual(refreshed, cached);
    assert.equal(cooledDown, refreshed);
  });

  it("returns a cooldown error when refresh cooldown is hit without a snapshot", async () => {
    let now = 20_000;
    let loads = 0;
    const service = new ArbitrageDashboardService({
      now: () => now,
      forcedRefreshCooldownMs: 10_000,
      rawMarketLoader: async () => rawSnapshot(++loads),
    });

    await service.getSnapshot(90, true);
    now += 1_000;

    await assert.rejects(
      () => service.getSnapshot(365, true),
      (error) => error instanceof ArbitrageRefreshCooldownError && error.retryAfterSeconds === 9,
    );
    assert.equal(loads, 1);
  });

  it("cleans up in-flight requests after loader failures", async () => {
    let attempts = 0;
    const service = new ArbitrageDashboardService({
      rawMarketLoader: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("upstream failed");
        return rawSnapshot(attempts);
      },
    });

    await assert.rejects(() => service.getSnapshot(90), /upstream failed/);
    const recovered = await service.getSnapshot(90);

    assert.equal(attempts, 2);
    assert.equal(recovered.generatedAt, 2);
  });

  it("reuses one fresh raw market snapshot from 90 to 365", async () => {
    let loads = 0;
    const service = new ArbitrageDashboardService({
      rawMarketLoader: async () => rawSnapshot(++loads, opportunityMarkets()),
    });

    const first = await service.getSnapshot(90);
    const second = await service.getSnapshot(365);

    assert.equal(loads, 1);
    assert.equal(first.generatedAt, second.generatedAt);
    assert.equal(first.horizonDays, 90);
    assert.equal(second.horizonDays, 365);
    assert.notEqual(first.opportunities[0]?.netApr, second.opportunities[0]?.netApr);
  });

  it("reuses one fresh raw market snapshot from 365 to 90", async () => {
    let loads = 0;
    const service = new ArbitrageDashboardService({
      rawMarketLoader: async () => rawSnapshot(++loads, opportunityMarkets()),
    });

    const first = await service.getSnapshot(365);
    const second = await service.getSnapshot(90);

    assert.equal(loads, 1);
    assert.equal(first.generatedAt, second.generatedAt);
    assert.equal(first.horizonDays, 365);
    assert.equal(second.horizonDays, 90);
  });

  it("deduplicates one raw market load for concurrent cross-horizon cold requests", async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      rawMarketLoader: async () => {
        loads += 1;
        await gate;
        return rawSnapshot(loads);
      },
    });

    const first = service.getSnapshot(90);
    const second = service.getSnapshot(365);
    assert.equal(loads, 0);
    await nextTurn();
    assert.equal(loads, 1);
    release();

    const [ninety, year] = await Promise.all([first, second]);
    assert.equal(ninety.generatedAt, year.generatedAt);
    assert.equal(loads, 1);
  });

  it("deduplicates one raw market refresh for concurrent stale cross-horizon dashboards", async () => {
    let now = 1_000;
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      rawMarketLoader: async () => {
        loads += 1;
        if (loads === 2) await gate;
        return rawSnapshot(loads);
      },
    });

    const ninety = await service.getSnapshot(90);
    const year = await service.getSnapshot(365);
    now += 20_001;

    const stale = await Promise.all([service.getSnapshot(90), service.getSnapshot(365)]);
    assert.deepEqual(stale, [ninety, year]);
    assert.equal(loads, 2);

    release();
    await nextTurn();
    assert.equal(loads, 2);
  });

  it("rebuilds a stale horizon from a fresh raw market snapshot without another provider load", async () => {
    let now = 1_000;
    let loads = 0;
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      forcedRefreshCooldownMs: 0,
      rawMarketLoader: async () => rawSnapshot(++loads),
    });

    const oldNinety = await service.getSnapshot(90);
    now += 20_001;
    const freshYear = await service.getSnapshot(365, true);
    assert.equal(loads, 2);

    const staleNinety = await service.getSnapshot(90);
    assert.equal(staleNinety, oldNinety);
    await nextTurn();

    const refreshedNinety = await service.getSnapshot(90);
    assert.equal(loads, 2);
    assert.equal(refreshedNinety.generatedAt, freshYear.generatedAt);
  });

  it("deduplicates one forced raw market refresh across horizons", async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      rawMarketLoader: async () => {
        loads += 1;
        await gate;
        return rawSnapshot(loads);
      },
    });

    const first = service.getSnapshot(90, true);
    const second = service.getSnapshot(365, true);
    await nextTurn();
    assert.equal(loads, 1);
    release();

    const [ninety, year] = await Promise.all([first, second]);
    assert.equal(ninety.generatedAt, year.generatedAt);
    assert.equal(loads, 1);
  });

  it("queues and deduplicates force refresh behind an ordinary raw refresh", async () => {
    let now = 1_000;
    const forceFlags: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      forcedRefreshCooldownMs: 0,
      rawMarketLoader: async (forceRefresh) => {
        forceFlags.push(forceRefresh === true);
        if (forceFlags.length === 2) await gate;
        return rawSnapshot(forceFlags.length);
      },
    });

    await service.getSnapshot(90);
    now += 20_001;
    assert.equal((await service.getSnapshot(90)).generatedAt, 1);
    await nextTurn();

    const forcedNinety = service.getSnapshot(90, true);
    const forcedYear = service.getSnapshot(365, true);
    await nextTurn();
    assert.deepEqual(forceFlags, [false, false]);

    release();
    const [ninety, year] = await Promise.all([forcedNinety, forcedYear]);

    assert.deepEqual(forceFlags, [false, false, true]);
    assert.equal(ninety.generatedAt, 3);
    assert.equal(year.generatedAt, 3);
  });

  it("does not mutate raw markets while calculating multiple horizons", async () => {
    const markets = opportunityMarkets();
    for (const market of markets) {
      Object.freeze(market.warnings);
      Object.freeze(market.fundingHistory);
      Object.freeze(market);
    }
    Object.freeze(markets);
    const before = JSON.stringify(markets);
    const service = new ArbitrageDashboardService({
      rawMarketLoader: async () => rawSnapshot(1, markets),
    });

    await service.getSnapshot(90);
    await service.getSnapshot(365);

    assert.equal(JSON.stringify(markets), before);
  });

  it("reuses batched public tickers and current funding while keeping per-market orderbooks", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      return jsonResponse(mockArbitragePayload(url, init));
    }) as typeof fetch;
    try {
      const service = new ArbitrageDashboardService({ now: () => 1_800_000_000_000, timingEnabled: false });
      const snapshot = await service.getSnapshot(90);
      const providerRequestCount = requestedUrls.length;
      const yearlySnapshot = await service.getSnapshot(365);

      assert.equal(snapshot.markets.length, 90);
      assert.equal(yearlySnapshot.markets.length, 90);
      assert.equal(yearlySnapshot.generatedAt, snapshot.generatedAt);
      assert.equal(requestedUrls.length, providerRequestCount);
      assert.equal(snapshot.summary.trackedMarketCount, 90);
      for (const asset of ["BTC", "ETH", "SOL", "XRP", "DOGE"] as const) {
        assert.equal(snapshot.markets.filter((market) => market.asset === asset).length, 8);
        assert.equal(snapshot.opportunities.filter((opportunity) =>
          opportunity.longLeg.asset === asset && opportunity.shortLeg.asset === asset).length, 28);
      }
      const binanceBtcPerpetual = snapshot.markets.find((market) => market.id === "binance-btc-perp");
      assert.equal(binanceBtcPerpetual?.bid, 100);
      assert.equal(binanceBtcPerpetual?.ask, 101);
      assert.notEqual(binanceBtcPerpetual?.status, "disconnected");
      assert.ok(!binanceBtcPerpetual?.warnings.includes("缺少可执行买卖报价"));
      const bybitDogePerpetual = snapshot.markets.find((market) => market.id === "bybit-doge-perp");
      assert.equal(bybitDogePerpetual?.fundingIntervalHours, 6);
      assert.equal(bybitDogePerpetual?.fundingScheduleCompleteness, "COMPLETE");
      assert.equal(countMatching(requestedUrls, "api.binance.com/api/v3/ticker/24hr?symbols="), 1);
      assert.equal(countMatching(requestedUrls, "fapi.binance.com/fapi/v1/ticker/24hr?symbols="), 1);
      assert.equal(countMatching(requestedUrls, "fapi.binance.com/fapi/v1/premiumIndex"), 1);
      assert.equal(countMatching(requestedUrls, "api.bybit.com/v5/market/tickers?category=spot"), 1);
      assert.equal(countMatching(requestedUrls, "api.bybit.com/v5/market/tickers?category=linear"), 1);
      assert.equal(countMatching(requestedUrls, "api.bitget.com/api/v2/spot/market/tickers"), 1);
      assert.equal(countMatching(requestedUrls, "api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES"), 1);
      assert.equal(countMatching(requestedUrls, "api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES"), 1);
      assert.equal(countMatching(requestedUrls, "www.okx.com/api/v5/market/tickers?instType=SPOT"), 1);
      assert.equal(countMatching(requestedUrls, "www.okx.com/api/v5/market/tickers?instType=SWAP"), 1);
      assert.equal(requestedUrls.some((url) => url.includes("/ticker/24hr?symbol=")), false);
      assert.equal(requestedUrls.some((url) => url.includes("/v5/market/tickers?category=spot&symbol=")), false);
      assert.equal(requestedUrls.some((url) => url.includes("/v5/market/tickers?category=linear&symbol=")), false);
      assert.equal(requestedUrls.some((url) => url.includes("/spot/market/tickers?symbol=")), false);
      assert.equal(requestedUrls.some((url) => url.includes("/mix/market/ticker?symbol=")), false);
      assert.equal(requestedUrls.some((url) => url.includes("/api/v5/market/ticker?instId=")), false);
      assert.ok(countMatching(requestedUrls, "/depth?symbol=") > 0);
      assert.ok(countMatching(requestedUrls, "/orderbook?category=") > 0);
      assert.ok(countMatching(requestedUrls, "/market/books?instId=") > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("degrades a market with a clear warning when executable quotes remain unavailable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT")) {
        return jsonResponse({ bids: [], asks: [] });
      }
      return jsonResponse(mockArbitragePayload(url, init));
    }) as typeof fetch;
    try {
      const service = new ArbitrageDashboardService({ now: () => 1_800_000_000_000, timingEnabled: false });
      const snapshot = await service.getSnapshot(90);
      const market = snapshot.markets.find((item) => item.id === "binance-btc-perp");

      assert.equal(market?.bid, null);
      assert.equal(market?.ask, null);
      assert.equal(market?.status, "degraded");
      assert.ok(market?.warnings.includes("缺少可执行买卖报价"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("ArbitrageDashboardService orderbook cache", () => {
  it("caches every production-shaped orderbook and bypasses fresh entries on force refresh", async () => {
    const originalFetch = globalThis.fetch;
    const requests: ProviderRequest[] = [];
    globalThis.fetch = mockProviderFetch(requests);
    try {
      const service = new ArbitrageDashboardService({
        now: () => 1_800_000_000_000,
        snapshotTtlMs: 0,
        timingEnabled: false,
      });

      await service.getSnapshot(90);
      const cache = (service as unknown as { orderbooks: Map<string, unknown> }).orderbooks;
      assert.equal(cache.size, 90);
      cache.clear();
      requests.length = 0;

      await service.getSnapshot(365);
      const cold = classifyProviderRequests(requests);
      requests.length = 0;

      await service.getSnapshot(90);
      await nextTurn();
      const cached = classifyProviderRequests(requests);
      requests.length = 0;

      await service.getSnapshot(365, true);
      const forced = classifyProviderRequests(requests);

      assert.deepEqual(cold, { tickerCurrent: 23, orderbook: 90, other: 0, total: 113 });
      assert.deepEqual(cached, { tickerCurrent: 23, orderbook: 0, other: 0, total: 23 });
      assert.deepEqual(forced, { tickerCurrent: 23, orderbook: 90, other: 0, total: 113 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("hits at TTL minus 1ms and reloads at TTL plus 1ms", async () => {
    const originalFetch = globalThis.fetch;
    const requests: ProviderRequest[] = [];
    let now = 1_800_000_000_000;
    globalThis.fetch = mockProviderFetch(requests);
    try {
      const service = new ArbitrageDashboardService({ now: () => now, snapshotTtlMs: 0, timingEnabled: false });
      await service.getSnapshot(90);
      requests.length = 0;

      now += ORDERBOOK_CACHE_TTL_MS - 1;
      await service.getSnapshot(365);
      assert.equal(classifyProviderRequests(requests).orderbook, 0);
      requests.length = 0;

      now += 2;
      await service.getSnapshot(90);
      await nextTurn();
      assert.equal(classifyProviderRequests(requests).orderbook, 90);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reloads only stale per-market entries during a partial cache hit", async () => {
    const originalFetch = globalThis.fetch;
    const requests: ProviderRequest[] = [];
    const now = 1_800_000_000_000;
    globalThis.fetch = mockProviderFetch(requests);
    try {
      const service = new ArbitrageDashboardService({ now: () => now, snapshotTtlMs: 0, timingEnabled: false });
      await service.getSnapshot(90);
      requests.length = 0;

      const cache = (service as unknown as {
        orderbooks: Map<string, { fetchedAt: number }>;
      }).orderbooks;
      const staleKeys = [...cache.keys()].slice(0, 27);
      for (const key of staleKeys) cache.get(key)!.fetchedAt = now - ORDERBOOK_CACHE_TTL_MS - 1;

      await service.getSnapshot(365);

      assert.equal(cache.size, 90);
      assert.equal(staleKeys.length, 27);
      assert.equal(classifyProviderRequests(requests).orderbook, 27);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("isolates identical symbols by venue and market type", () => {
    const binanceSpot = orderbookCacheKey({ venue: "binance", kind: "spot", symbol: "BTCUSDT" });
    const binancePerpetual = orderbookCacheKey({ venue: "binance", kind: "perpetual", symbol: "BTCUSDT" });
    const bybitSpot = orderbookCacheKey({ venue: "bybit", kind: "spot", symbol: "BTCUSDT" });

    assert.equal(new Set([binanceSpot, binancePerpetual, bybitSpot]).size, 3);
    assert.equal(binanceSpot, "binance:spot:BTCUSDT");
    assert.equal(binancePerpetual, "binance:perpetual:BTCUSDT");
    assert.equal(bybitSpot, "bybit:spot:BTCUSDT");
  });

  it("does not poison the cache after an orderbook request failure and retries that market", async () => {
    const originalFetch = globalThis.fetch;
    const requests: ProviderRequest[] = [];
    let failures = 0;
    globalThis.fetch = mockProviderFetch(requests, (url) => {
      if (failures < 2 && url.includes("api.binance.com/api/v3/depth?symbol=BTCUSDT")) {
        failures += 1;
        return true;
      }
      return false;
    });
    try {
      const service = new ArbitrageDashboardService({
        now: () => 1_800_000_000_000,
        snapshotTtlMs: 0,
        timingEnabled: false,
      });
      const first = await service.getSnapshot(90);
      assert.equal(first.markets.find((market) => market.id === "binance-btc-spot")?.status, "disconnected");
      requests.length = 0;

      const second = await service.getSnapshot(365);

      assert.equal(classifyProviderRequests(requests).orderbook, 1);
      assert.notEqual(second.markets.find((market) => market.id === "binance-btc-spot")?.status, "disconnected");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stores immutable normalized orderbooks and returns new market calculations on reuse", async () => {
    const originalFetch = globalThis.fetch;
    const requests: ProviderRequest[] = [];
    globalThis.fetch = mockProviderFetch(requests);
    try {
      const service = new ArbitrageDashboardService({
        now: () => 1_800_000_000_000,
        snapshotTtlMs: 0,
        timingEnabled: false,
      });
      const first = await service.getSnapshot(90);
      const cache = (service as unknown as {
        orderbooks: Map<string, { value: { bids: readonly unknown[]; asks: readonly unknown[] } }>;
      }).orderbooks;
      const cached = cache.get("binance:spot:BTCUSDT")!.value;

      assert.equal(Object.isFrozen(cached), true);
      assert.equal(Object.isFrozen(cached.bids), true);
      assert.equal(Object.isFrozen(cached.bids[0]), true);
      const serialized = JSON.stringify(cached);

      const second = await service.getSnapshot(365);
      assert.equal(JSON.stringify(cached), serialized);
      assert.equal(second.markets.find((market) => market.id === "binance-btc-spot")?.depthUsd,
        first.markets.find((market) => market.id === "binance-btc-spot")?.depthUsd);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("ArbitrageDashboardService timing", () => {
  it("keeps the dashboard payload equivalent with timing enabled", async () => {
    const originalFetch = globalThis.fetch;
    const requests: ProviderRequest[] = [];
    globalThis.fetch = mockProviderFetch(requests);
    try {
      const options = { now: () => 1_800_000_000_000 };
      const withoutTiming = new ArbitrageDashboardService({ ...options, timingEnabled: false });
      const withTiming = new ArbitrageDashboardService({
        ...options,
        timingEnabled: true,
        timingLogger: () => undefined,
      });

      const expected = await withoutTiming.getSnapshot(90);
      const actual = await withTiming.getSnapshot(90);

      assert.deepEqual(actual, expected);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports cold orderbook misses, fresh hits, and force bypasses without changing Provider counts", async () => {
    const originalFetch = globalThis.fetch;
    const requests: ProviderRequest[] = [];
    const logs: TimingLog[] = [];
    globalThis.fetch = mockProviderFetch(requests);
    try {
      const service = new ArbitrageDashboardService({
        now: () => 1_800_000_000_000,
        snapshotTtlMs: 0,
        timingLogger: (event, facts) => { logs.push({ event, facts }); },
      });

      await service.getSnapshot(90);
      const cold = rawTimingLog(logs);
      assert.deepEqual(cold.orderbook, { hits: 0, misses: 90, forceBypasses: 0, providerFetches: 90 });
      assert.deepEqual(cold.fundingHistory, { hits: 0, misses: 51 });
      logs.length = 0;
      requests.length = 0;

      await service.getSnapshot(365);
      const cached = rawTimingLog(logs);
      assert.deepEqual(cached.orderbook, { hits: 90, misses: 0, forceBypasses: 0, providerFetches: 0 });
      assert.deepEqual(cached.fundingHistory, { hits: 51, misses: 0 });
      assert.deepEqual(classifyProviderRequests(requests), { tickerCurrent: 23, orderbook: 0, other: 0, total: 23 });
      logs.length = 0;
      requests.length = 0;

      await service.getSnapshot(90, true);
      const forced = rawTimingLog(logs);
      assert.deepEqual(forced.orderbook, { hits: 0, misses: 0, forceBypasses: 90, providerFetches: 90 });
      assert.deepEqual(forced.fundingHistory, { hits: 51, misses: 0 });
      assert.deepEqual(classifyProviderRequests(requests), { tickerCurrent: 23, orderbook: 90, other: 0, total: 113 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("counts a final Provider failure and retry without swallowing the existing disconnected result", async () => {
    const originalFetch = globalThis.fetch;
    const requests: ProviderRequest[] = [];
    const logs: TimingLog[] = [];
    let failures = 0;
    globalThis.fetch = mockProviderFetch(requests, (url) => {
      if (failures < 2 && url.includes("api.binance.com/api/v3/depth?symbol=BTCUSDT")) {
        failures += 1;
        return true;
      }
      return false;
    });
    try {
      const service = new ArbitrageDashboardService({
        now: () => 1_800_000_000_000,
        timingLogger: (event, facts) => { logs.push({ event, facts }); },
      });
      const snapshot = await service.getSnapshot(90);
      const report = rawTimingLog(logs);
      const binance = (report.providers as Record<string, Record<string, unknown>>).binance;

      assert.equal(binance.failures, 1);
      assert.equal(binance.retries, 1);
      assert.equal(snapshot.markets.find((market) => market.id === "binance-btc-spot")?.status, "disconnected");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("emits non-negative raw and dashboard phases without per-market logs", async () => {
    const originalFetch = globalThis.fetch;
    const logs: TimingLog[] = [];
    globalThis.fetch = mockProviderFetch([]);
    try {
      const service = new ArbitrageDashboardService({
        now: () => 1_800_000_000_000,
        timingLogger: (event, facts) => { logs.push({ event, facts }); },
      });
      await service.getSnapshot(90);
      await service.getSnapshot(365);

      assert.equal(logs.length, 3);
      const raw = rawTimingLog(logs);
      const dashboards = logs.filter((entry) => entry.event.includes("dashboard refresh complete"));
      const dashboard = dashboards[0]!.facts;
      assert.equal(dashboard.rawMarketState, "raw_cache_refresh");
      assert.equal(dashboards[1]!.facts.rawMarketState, "raw_cache_fresh");
      for (const value of [raw.totalMs, raw.currentMarketLoadingMs, raw.stablecoinLoadingMs]) {
        assert.equal(typeof value, "number");
        assert.ok(Number(value) >= 0);
      }
      for (const value of [dashboard.totalMs, dashboard.rawMarketMs, dashboard.opportunityScoringMs, dashboard.dashboardAssemblyMs]) {
        assert.equal(typeof value, "number");
        assert.ok(Number(value) >= 0);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not let timing logger failure affect dashboard availability", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockProviderFetch([]);
    try {
      const service = new ArbitrageDashboardService({
        now: () => 1_800_000_000_000,
        timingLogger: () => { throw new Error("logger unavailable"); },
      });

      const snapshot = await service.getSnapshot(90);
      assert.equal(snapshot.markets.length, 90);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function rawSnapshot(generatedAt: number, markets: InternalArbitrageMarket[] = []) {
  return {
    generatedAt,
    markets,
    stablecoin: {
      price: null,
      warnings: [],
    },
  };
}

function opportunityMarkets(): InternalArbitrageMarket[] {
  return [
    market({ id: "binance-doge-spot", venue: "binance", venueLabel: "Binance", kind: "spot" }),
    market({
      id: "bybit-doge-perp",
      venue: "bybit",
      venueLabel: "Bybit",
      kind: "perpetual",
      fundingRate: 0.0001,
      currentFundingApr: 10,
      historicalFundingApr: 10,
      fundingPositiveRatio: 1,
      fundingCoverageRatio: 1,
    }),
  ];
}

function market(overrides: Partial<InternalArbitrageMarket>): InternalArbitrageMarket {
  return {
    id: "market",
    venue: "binance",
    venueLabel: "Binance",
    symbol: "DOGEUSDT",
    asset: "DOGE",
    kind: "spot",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    bid: 0.1,
    ask: 0.101,
    markPrice: 0.1,
    indexPrice: 0.1,
    spreadBps: 1,
    fundingRate: null,
    fundingIntervalHours: null,
    currentFundingApr: 0,
    historicalFundingApr: 0,
    fundingPositiveRatio: null,
    fundingCoverageRatio: 1,
    slippageBps10k: 1,
    slippageBps100k: 2,
    depthUsd: 100_000,
    volume24h: 1_000_000,
    openInterest: null,
    nextFundingTime: null,
    takerFeeBps: 1,
    status: "connected",
    fetchedAt: 1,
    availableSince: null,
    warnings: [],
    fundingHistory: [],
    ...overrides,
  };
}

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

type ProviderRequest = {
  url: string;
  init?: RequestInit;
};

type TimingLog = {
  event: string;
  facts: Record<string, unknown>;
};

function rawTimingLog(logs: TimingLog[]) {
  const log = logs.find((entry) => entry.event.includes("raw market refresh complete"));
  assert.ok(log);
  return log.facts;
}

function mockProviderFetch(
  requests: ProviderRequest[],
  shouldFail: (url: string, init?: RequestInit) => boolean = () => false,
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, init });
    if (shouldFail(url, init)) throw new Error("controlled orderbook failure");
    return jsonResponse(mockArbitragePayload(url, init));
  }) as typeof fetch;
}

function classifyProviderRequests(requests: ProviderRequest[]) {
  let tickerCurrent = 0;
  let orderbook = 0;
  let other = 0;
  for (const request of requests) {
    if (isOrderbookRequest(request)) orderbook += 1;
    else if (isTickerOrCurrentRequest(request)) tickerCurrent += 1;
    else other += 1;
  }
  return { tickerCurrent, orderbook, other, total: requests.length };
}

function isOrderbookRequest({ url, init }: ProviderRequest) {
  if (
    url.includes("/depth?")
    || url.includes("/market/orderbook?")
    || url.includes("/market/merge-depth?")
    || url.includes("/market/books?")
  ) return true;
  if (!url.includes("api.hyperliquid.xyz/info") || typeof init?.body !== "string") return false;
  return JSON.parse(init.body).type === "l2Book";
}

function isTickerOrCurrentRequest({ url, init }: ProviderRequest) {
  if (
    url.includes("/ticker/24hr")
    || url.includes("/ticker/bookTicker")
    || url.includes("/premiumIndex")
    || url.includes("/market/tickers")
    || url.includes("/market/current-fund-rate")
    || url.includes("/public/funding-rate?")
  ) return true;
  if (!url.includes("api.hyperliquid.xyz/info") || typeof init?.body !== "string") return false;
  return JSON.parse(init.body).type === "metaAndAssetCtxs";
}

function countMatching(urls: string[], fragment: string) {
  return urls.filter((url) => url.includes(fragment)).length;
}

function mockArbitragePayload(url: string, init?: RequestInit) {
  const parsed = new URL(url);
  const symbol = parsed.searchParams.get("symbol")
    ?? parsed.searchParams.get("instId")
    ?? "BTCUSDT";
  if (url.includes("api.hyperliquid.xyz/info")) return mockHyperliquidPayload(init);
  if (url.includes("bookTicker?symbol=USDCUSDT")) return { bidPrice: "0.9999", askPrice: "1.0001" };
  if (url.includes("api.binance.com/api/v3/ticker/24hr")) return binanceTickerRows(parsed);
  if (url.includes("fapi.binance.com/fapi/v1/ticker/24hr")) return binanceTickerRows(parsed, false);
  if (url.includes("fapi.binance.com/fapi/v1/premiumIndex")) return premiumRows();
  if (url.includes("/depth?")) return { bids: bookRows(), asks: bookRows("ask") };
  if (url.includes("fapi.binance.com/fapi/v1/fundingRate")) return fundingRows("fundingRate", "fundingTime");
  if (url.includes("api.bybit.com/v5/market/tickers?category=spot")) return { result: { list: bybitTickerRows() } };
  if (url.includes("api.bybit.com/v5/market/tickers?category=linear")) return { result: { list: bybitTickerRows() } };
  if (url.includes("api.bybit.com/v5/market/orderbook")) return { result: { b: bookRows(), a: bookRows("ask"), ts: 1_800_000_000_000 } };
  if (url.includes("api.bybit.com/v5/market/funding/history")) return { result: { list: fundingRows("fundingRate", "fundingRateTimestamp") } };
  if (url.includes("api.bitget.com/api/v2/spot/market/tickers")) return { data: bitgetTickerRows() };
  if (url.includes("api.bitget.com/api/v2/spot/market/orderbook")) return { data: { bids: bookRows(), asks: bookRows("ask"), ts: 1_800_000_000_000 } };
  if (url.includes("api.bitget.com/api/v2/mix/market/tickers")) return { data: bitgetTickerRows() };
  if (url.includes("api.bitget.com/api/v2/mix/market/current-fund-rate")) return { data: bitgetFundingRows() };
  if (url.includes("api.bitget.com/api/v2/mix/market/merge-depth")) return { data: { bids: bookRows(), asks: bookRows("ask"), ts: 1_800_000_000_000 } };
  if (url.includes("api.bitget.com/api/v2/mix/market/history-fund-rate")) return { data: fundingRows("fundingRate", "fundingTime") };
  if (url.includes("www.okx.com/api/v5/market/tickers")) return { data: okxTickerRows() };
  if (url.includes("www.okx.com/api/v5/market/books")) return { data: [{ bids: bookRows(), asks: bookRows("ask"), ts: "1800000000000" }] };
  if (url.includes("www.okx.com/api/v5/public/funding-rate-history")) return { data: fundingRows("realizedRate", "fundingTime") };
  if (url.includes("www.okx.com/api/v5/public/funding-rate")) {
    return { data: [{ fundingRate: "0.0001", fundingTime: "1800000000000", nextFundingTime: "1800028800000" }] };
  }
  throw new Error(`Unhandled arbitrage mock URL: ${url} ${symbol}`);
}

function binanceTickerRows(parsed: URL, includeExecutableQuotes = true) {
  const symbols = JSON.parse(parsed.searchParams.get("symbols") ?? "[]") as string[];
  return symbols.map((symbol) => ({
    symbol,
    ...(includeExecutableQuotes ? { bidPrice: "100", askPrice: "101" } : {}),
    lastPrice: "100.5",
    quoteVolume: "1000000",
  }));
}

function premiumRows() {
  return perpSymbols().map((symbol) => ({
    symbol,
    markPrice: "100.5",
    indexPrice: "100.4",
    lastFundingRate: "0.0001",
    nextFundingTime: 1_800_028_800_000,
  }));
}

function bybitTickerRows() {
  return allSymbols().map((symbol) => ({
    symbol,
    bid1Price: "100",
    ask1Price: "101",
    lastPrice: "100.5",
    markPrice: "100.5",
    indexPrice: "100.4",
    fundingRate: "0.0001",
    ...(symbol === "DOGEUSDT" ? { fundingIntervalHour: "6" } : {}),
    turnover24h: "1000000",
    openInterest: "10000",
    nextFundingTime: "1800028800000",
  }));
}

function bitgetTickerRows() {
  return allSymbols().map((symbol) => ({
    symbol,
    bidPr: "100",
    askPr: "101",
    lastPr: "100.5",
    markPrice: "100.5",
    indexPrice: "100.4",
    usdtVolume: "1000000",
    holdingAmount: "10000",
  }));
}

function bitgetFundingRows() {
  return perpSymbols().map((symbol) => ({
    symbol,
    fundingRate: "0.0001",
    fundingRateInterval: "8",
    nextUpdate: "1800028800000",
  }));
}

function okxTickerRows() {
  return okxSymbols().map((instId) => ({
    instId,
    bidPx: "100",
    askPx: "101",
    last: "100.5",
    volCcy24h: "10000",
  }));
}

function fundingRows(rateKey: string, timeKey: string) {
  return Array.from({ length: 90 }, (_, index) => ({
    [rateKey]: "0.0001",
    [timeKey]: 1_800_000_000_000 - index * 86_400_000,
  }));
}

function bookRows(side: "bid" | "ask" = "bid") {
  return Array.from({ length: 4 }, (_, index) => {
    const price = side === "bid" ? 100 - index : 101 + index;
    return [String(price), "100"];
  });
}

function mockHyperliquidPayload(init?: RequestInit) {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  if (body.type === "metaAndAssetCtxs") {
    return [
      { universe: [{ name: "xyz:GOLD" }] },
      [{ markPx: "100.5", oraclePx: "100.4", funding: "0.0001", dayNtlVlm: "1000000", openInterest: "10000" }],
    ];
  }
  if (body.type === "l2Book") {
    return { levels: [bookRows().map(([px, sz]) => ({ px, sz })), bookRows("ask").map(([px, sz]) => ({ px, sz }))], time: 1_800_000_000_000 };
  }
  if (body.type === "fundingHistory") return fundingRows("fundingRate", "time");
  throw new Error(`Unhandled Hyperliquid mock body: ${JSON.stringify(body)}`);
}

function allSymbols() {
  return [...new Set([
    "PAXGUSDT",
    "XAUTUSDT",
    "XAUUSDT",
    "RMUUSDT",
    "MUUSDT",
    "NVDABUSDT",
    "RNVDAUSDT",
    "NVDAUSDT",
    "NVDAXUSDT",
    "GOOGLBUSDT",
    "RGOOGLUSDT",
    "GOOGLUSDT",
    "GOOGLXUSDT",
    "MSFTBUSDT",
    "RMSFTUSDT",
    "MSFTUSDT",
    "TSLABUSDT",
    "RTSLAUSDT",
    "TSLAUSDT",
    "TSLAXUSDT",
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "DOGEUSDT",
  ])];
}

function perpSymbols() {
  return allSymbols().filter((symbol) => !symbol.startsWith("R") && !symbol.endsWith("BUSDT") && !symbol.endsWith("XUSDT"));
}

function okxSymbols() {
  return [
    "PAXG-USDT",
    "XAUT-USDT",
    "XAU-USDT-SWAP",
    "MU-USDT-SWAP",
    "NVDA-USDT-SWAP",
    "GOOGL-USDT-SWAP",
    "MSFT-USDT-SWAP",
    "TSLA-USDT-SWAP",
    "BTC-USDT",
    "BTC-USDT-SWAP",
    "ETH-USDT",
    "ETH-USDT-SWAP",
    "SOL-USDT",
    "SOL-USDT-SWAP",
    "XRP-USDT",
    "XRP-USDT-SWAP",
    "DOGE-USDT",
    "DOGE-USDT-SWAP",
  ];
}
