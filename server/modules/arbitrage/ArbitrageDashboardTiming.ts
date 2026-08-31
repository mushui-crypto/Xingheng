export type ArbitrageProviderName = "binance" | "bybit" | "bitget" | "okx" | "hyperliquid" | "other";

export type ArbitrageProviderRequestCategory =
  | "ticker"
  | "orderbook"
  | "currentFunding"
  | "fundingHistory"
  | "stablecoin"
  | "other";

type MutableProviderTiming = {
  requests: number;
  successes: number;
  failures: number;
  retries: number;
  cumulativeRequestMs: number;
  slowestRequestMs: number;
  wallMs: number;
  activeRequests: number;
  activeSegmentStartedAt: number | null;
  categories: Record<ArbitrageProviderRequestCategory, number>;
};

export type ProviderTimingReport = Readonly<{
  requests: number;
  successes: number;
  failures: number;
  retries: number;
  cumulativeRequestMs: number;
  slowestRequestMs: number;
  wallMs: number;
  categories: Readonly<Record<ArbitrageProviderRequestCategory, number>>;
}>;

export type ArbitrageRawRefreshTimingContext = ReturnType<typeof createArbitrageRawRefreshTiming>;

const providerNames: ArbitrageProviderName[] = ["binance", "bybit", "bitget", "okx", "hyperliquid", "other"];

export function createArbitrageRawRefreshTiming(monotonicNow: () => number) {
  const providers = Object.fromEntries(providerNames.map((provider) => [provider, providerTiming()])) as Record<
    ArbitrageProviderName,
    MutableProviderTiming
  >;
  const orderbook = { hits: 0, misses: 0, forceBypasses: 0, providerFetches: 0 };
  const fundingHistory = { hits: 0, misses: 0 };

  return {
    startProviderRequest(provider: ArbitrageProviderName, category: ArbitrageProviderRequestCategory) {
      const timing = providers[provider];
      const startedAt = monotonicNow();
      timing.requests += 1;
      timing.categories[category] += 1;
      if (timing.activeRequests === 0) timing.activeSegmentStartedAt = startedAt;
      timing.activeRequests += 1;
      let settled = false;
      const settle = (success: boolean) => {
        if (settled) return;
        settled = true;
        const endedAt = monotonicNow();
        const durationMs = Math.max(0, endedAt - startedAt);
        timing.cumulativeRequestMs += durationMs;
        timing.slowestRequestMs = Math.max(timing.slowestRequestMs, durationMs);
        if (success) timing.successes += 1;
        else timing.failures += 1;
        timing.activeRequests -= 1;
        if (timing.activeRequests === 0 && timing.activeSegmentStartedAt !== null) {
          timing.wallMs += Math.max(0, endedAt - timing.activeSegmentStartedAt);
          timing.activeSegmentStartedAt = null;
        }
      };
      return {
        retry: () => { timing.retries += 1; },
        success: () => settle(true),
        failure: () => settle(false),
      };
    },
    orderbookHit: () => { orderbook.hits += 1; },
    orderbookMiss: () => { orderbook.misses += 1; },
    orderbookForceBypass: () => { orderbook.forceBypasses += 1; },
    orderbookProviderFetch: () => { orderbook.providerFetches += 1; },
    fundingHistoryHit: () => { fundingHistory.hits += 1; },
    fundingHistoryMiss: () => { fundingHistory.misses += 1; },
    report() {
      return {
        orderbook: { ...orderbook },
        fundingHistory: { ...fundingHistory },
        providers: Object.fromEntries(providerNames.map((provider) => [provider, providerReport(providers[provider])])) as Record<
          ArbitrageProviderName,
          ProviderTimingReport
        >,
      };
    },
  };
}

export function providerAndCategory(
  url: string,
  init?: RequestInit,
): { provider: ArbitrageProviderName; category: ArbitrageProviderRequestCategory } {
  const provider: ArbitrageProviderName = url.includes("binance.com")
    ? "binance"
    : url.includes("bybit.com")
      ? "bybit"
      : url.includes("bitget.com")
        ? "bitget"
        : url.includes("okx.com")
          ? "okx"
          : url.includes("hyperliquid.xyz")
            ? "hyperliquid"
            : "other";
  return { provider, category: requestCategory(url, init) };
}

function requestCategory(url: string, init?: RequestInit): ArbitrageProviderRequestCategory {
  if (url.includes("USDCUSDT")) return "stablecoin";
  if (
    url.includes("/depth?")
    || url.includes("/market/orderbook?")
    || url.includes("/market/merge-depth?")
    || url.includes("/market/books?")
  ) return "orderbook";
  if (
    url.includes("fundingRate?")
    || url.includes("funding/history")
    || url.includes("history-fund-rate")
    || url.includes("funding-rate-history")
  ) return "fundingHistory";
  if (
    url.includes("premiumIndex")
    || url.includes("current-fund-rate")
    || url.includes("/public/funding-rate?")
  ) return "currentFunding";
  if (url.includes("hyperliquid.xyz/info") && typeof init?.body === "string") {
    const type = safeHyperliquidType(init.body);
    if (type === "l2Book") return "orderbook";
    if (type === "fundingHistory") return "fundingHistory";
  }
  if (url.includes("ticker") || url.includes("hyperliquid.xyz/info")) return "ticker";
  return "other";
}

function safeHyperliquidType(body: string) {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.type === "string" ? parsed.type : null;
  } catch {
    return null;
  }
}

function providerTiming(): MutableProviderTiming {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    cumulativeRequestMs: 0,
    slowestRequestMs: 0,
    wallMs: 0,
    activeRequests: 0,
    activeSegmentStartedAt: null,
    categories: {
      ticker: 0,
      orderbook: 0,
      currentFunding: 0,
      fundingHistory: 0,
      stablecoin: 0,
      other: 0,
    },
  };
}

function providerReport(timing: MutableProviderTiming): ProviderTimingReport {
  return {
    requests: timing.requests,
    successes: timing.successes,
    failures: timing.failures,
    retries: timing.retries,
    cumulativeRequestMs: roundMs(timing.cumulativeRequestMs),
    slowestRequestMs: roundMs(timing.slowestRequestMs),
    wallMs: roundMs(timing.wallMs),
    categories: { ...timing.categories },
  };
}

export function roundMs(value: number) {
  return Number(value.toFixed(3));
}
