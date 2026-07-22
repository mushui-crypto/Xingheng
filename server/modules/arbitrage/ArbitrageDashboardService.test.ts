import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ArbitrageDashboardService,
  ArbitrageRefreshCooldownError,
} from "./ArbitrageDashboardService";
import type { ArbitrageDashboardSnapshot } from "./arbitrageTypes";

describe("ArbitrageDashboardService cache and refresh control", () => {
  it("reuses a fresh 20 second snapshot for ordinary requests", async () => {
    let now = 1_000;
    let loads = 0;
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      snapshotLoader: async (horizonDays) => snapshot(horizonDays, ++loads),
    });

    const first = await service.getSnapshot(90);
    now += 19_999;
    const second = await service.getSnapshot(90);

    assert.equal(loads, 1);
    assert.equal(second, first);
  });

  it("merges in-flight ordinary requests for the same horizon", async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ArbitrageDashboardService({
      snapshotLoader: async (horizonDays) => {
        loads += 1;
        await gate;
        return snapshot(horizonDays, loads);
      },
    });

    const first = service.getSnapshot(90);
    const second = service.getSnapshot(90);
    release();

    assert.equal(await first, await second);
    assert.equal(loads, 1);
  });

  it("serves the old snapshot when refresh cooldown is hit", async () => {
    let now = 10_000;
    let loads = 0;
    const service = new ArbitrageDashboardService({
      now: () => now,
      snapshotTtlMs: 20_000,
      forcedRefreshCooldownMs: 10_000,
      snapshotLoader: async (horizonDays) => snapshot(horizonDays, ++loads),
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
      snapshotLoader: async (horizonDays) => snapshot(horizonDays, ++loads),
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
      snapshotLoader: async (horizonDays) => {
        attempts += 1;
        if (attempts === 1) throw new Error("upstream failed");
        return snapshot(horizonDays, attempts);
      },
    });

    await assert.rejects(() => service.getSnapshot(90), /upstream failed/);
    const recovered = await service.getSnapshot(90);

    assert.equal(attempts, 2);
    assert.equal(recovered.generatedAt, 2);
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
      const service = new ArbitrageDashboardService({ now: () => 1_800_000_000_000 });
      const snapshot = await service.getSnapshot(90);

      assert.equal(snapshot.markets.length, 50);
      assert.equal(snapshot.summary.trackedMarketCount, 50);
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
});

function snapshot(horizonDays: 90 | 365, generatedAt: number): ArbitrageDashboardSnapshot {
  return {
    horizonDays,
    generatedAt,
    markets: [],
    opportunities: [],
    summary: {
      bestScore: null,
      bestNetApr: null,
      eligibleOpportunityCount: 0,
      connectedVenueCount: 0,
      totalVenueCount: 5,
      trackedMarketCount: 0,
      usdcUsdtPrice: null,
      stablecoinBasisBps: null,
    },
    warnings: [],
  };
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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
  if (url.includes("fapi.binance.com/fapi/v1/ticker/24hr")) return binanceTickerRows(parsed);
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

function binanceTickerRows(parsed: URL) {
  const symbols = JSON.parse(parsed.searchParams.get("symbols") ?? "[]") as string[];
  return symbols.map((symbol) => ({
    symbol,
    bidPrice: "100",
    askPrice: "101",
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
  ];
}
