import { buildArbitrageOpportunities, calculateHistoricalFundingMetrics } from "./arbitrageScoring";
import type {
  ArbitrageAsset,
  ArbitrageDashboardSnapshot,
  ArbitrageInstrumentKind,
  ArbitrageQuoteAsset,
  ArbitrageVenue,
  FundingPoint,
  InternalArbitrageMarket,
  OrderbookLevel,
} from "./arbitrageTypes";

const requestTimeoutMs = 10_000;
const snapshotTtlMs = 20_000;
const forcedRefreshCooldownMs = 10_000;
const fundingHistoryTtlMs = 15 * 60_000;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const fundingLookbackDays = 90;
const marketLoadConcurrency = 8;

type InstrumentConfig = {
  id: string;
  venue: ArbitrageVenue;
  venueLabel: string;
  symbol: string;
  asset: ArbitrageAsset;
  kind: ArbitrageInstrumentKind;
  quoteAsset: ArbitrageQuoteAsset;
  settlementAsset: ArbitrageQuoteAsset;
  takerFeeBps: number;
  sizeMultiplier?: number;
  fundingIntervalHours?: number;
  availableSince?: number;
};

type CurrentMarketPayload = {
  bid: number | null;
  ask: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  volume24h: number | null;
  openInterest: number | null;
  nextFundingTime: number | null;
  timestamp: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  warnings?: string[];
};

type CurrentMarketBatches = {
  binanceSpotTickers: Promise<Map<string, any>>;
  binancePerpetualTickers: Promise<Map<string, any>>;
  binancePremiums: Promise<Map<string, any>>;
  bybitSpotTickers: Promise<Map<string, any>>;
  bybitPerpetualTickers: Promise<Map<string, any>>;
  bitgetSpotTickers: Promise<Map<string, any>>;
  bitgetPerpetualTickers: Promise<Map<string, any>>;
  bitgetFunding: Promise<Map<string, any>>;
  okxSpotTickers: Promise<Map<string, any>>;
  okxPerpetualTickers: Promise<Map<string, any>>;
};

type ArbitrageDashboardServiceOptions = {
  now?: () => number;
  snapshotTtlMs?: number;
  forcedRefreshCooldownMs?: number;
  snapshotLoader?: (horizonDays: 90 | 365) => Promise<ArbitrageDashboardSnapshot>;
};

export class ArbitrageRefreshCooldownError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterMs: number) {
    super("套利行情刷新仍在冷却中。");
    this.name = "ArbitrageRefreshCooldownError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
}

const instruments: InstrumentConfig[] = [
  instrument("binance-paxg-spot", "binance", "Binance", "PAXGUSDT", "PAXG", "spot", 10),
  instrument("binance-xaut-spot", "binance", "Binance", "XAUTUSDT", "XAUT", "spot", 10),
  instrument("binance-paxg-perp", "binance", "Binance", "PAXGUSDT", "PAXG", "perpetual", 5, { fundingIntervalHours: 4 }),
  instrument("binance-xaut-perp", "binance", "Binance", "XAUTUSDT", "XAUT", "perpetual", 5, { fundingIntervalHours: 4 }),
  instrument("binance-xau-perp", "binance", "Binance", "XAUUSDT", "XAU", "perpetual", 5, { fundingIntervalHours: 4 }),
  instrument("bybit-xaut-spot", "bybit", "Bybit", "XAUTUSDT", "XAUT", "spot", 10),
  instrument("bybit-paxg-perp", "bybit", "Bybit", "PAXGUSDT", "PAXG", "perpetual", 5.5, { fundingIntervalHours: 4 }),
  instrument("bybit-xaut-perp", "bybit", "Bybit", "XAUTUSDT", "XAUT", "perpetual", 5.5, { fundingIntervalHours: 4 }),
  instrument("bybit-xau-perp", "bybit", "Bybit", "XAUUSDT", "XAU", "perpetual", 5.5, { fundingIntervalHours: 4 }),
  instrument("bitget-paxg-spot", "bitget", "Bitget", "PAXGUSDT", "PAXG", "spot", 10),
  instrument("bitget-xaut-spot", "bitget", "Bitget", "XAUTUSDT", "XAUT", "spot", 10),
  instrument("bitget-paxg-perp", "bitget", "Bitget", "PAXGUSDT", "PAXG", "perpetual", 6, { fundingIntervalHours: 4 }),
  instrument("bitget-xaut-perp", "bitget", "Bitget", "XAUTUSDT", "XAUT", "perpetual", 6, { fundingIntervalHours: 4 }),
  instrument("bitget-xau-perp", "bitget", "Bitget", "XAUUSDT", "XAU", "perpetual", 6, { fundingIntervalHours: 4 }),
  instrument("okx-paxg-spot", "okx", "OKX", "PAXG-USDT", "PAXG", "spot", 10),
  instrument("okx-xaut-spot", "okx", "OKX", "XAUT-USDT", "XAUT", "spot", 10),
  instrument("okx-xau-perp", "okx", "OKX", "XAU-USDT-SWAP", "XAU", "perpetual", 5, { fundingIntervalHours: 8, sizeMultiplier: 0.001 }),
  instrument("tradexyz-gold-perp", "tradexyz", "tradeXYZ", "xyz:GOLD", "GOLD", "perpetual", 7, {
    quoteAsset: "USDC",
    settlementAsset: "USDC",
    fundingIntervalHours: 1,
  }),
  ...stockRwaInstruments(),
];

function stockRwaInstruments(): InstrumentConfig[] {
  return [
    instrument("bitget-mu-spot", "bitget", "Bitget", "RMUUSDT", "MU", "spot", 10, { availableSince: 1_780_322_400_000 }),
    instrument("bitget-mu-perp", "bitget", "Bitget", "MUUSDT", "MU", "perpetual", 6, { fundingIntervalHours: 8 }),
    instrument("binance-mu-perp", "binance", "Binance", "MUUSDT", "MU", "perpetual", 5, { fundingIntervalHours: 8 }),
    instrument("bybit-mu-perp", "bybit", "Bybit", "MUUSDT", "MU", "perpetual", 5.5, { fundingIntervalHours: 8 }),
    instrument("okx-mu-perp", "okx", "OKX", "MU-USDT-SWAP", "MU", "perpetual", 5, { fundingIntervalHours: 8 }),
    ...stockRwaAsset("NVDA", "NVDABUSDT", 1_781_136_000_000, 1_776_914_552_903, "NVDAXUSDT"),
    ...stockRwaAsset("GOOGL", "GOOGLBUSDT", 1_783_382_400_000, 1_780_322_400_000, "GOOGLXUSDT"),
    ...stockRwaAsset("MSFT", "MSFTBUSDT", 1_782_777_600_000, 1_780_322_400_000),
    ...stockRwaAsset("TSLA", "TSLABUSDT", 1_781_136_000_000, 1_780_323_652_017, "TSLAXUSDT"),
  ];
}

function stockRwaAsset(
  asset: Extract<ArbitrageAsset, "NVDA" | "GOOGL" | "MSFT" | "TSLA">,
  binanceSpotSymbol: string,
  binanceSpotAvailableSince: number,
  bitgetSpotAvailableSince: number,
  bybitSpotSymbol?: string,
): InstrumentConfig[] {
  const slug = asset.toLowerCase();
  return [
    instrument(`bitget-${slug}-spot`, "bitget", "Bitget", `R${asset}USDT`, asset, "spot", 10, { availableSince: bitgetSpotAvailableSince }),
    instrument(`bitget-${slug}-perp`, "bitget", "Bitget", `${asset}USDT`, asset, "perpetual", 6, { fundingIntervalHours: 8 }),
    instrument(`binance-${slug}-spot`, "binance", "Binance", binanceSpotSymbol, asset, "spot", 10, { availableSince: binanceSpotAvailableSince }),
    instrument(`binance-${slug}-perp`, "binance", "Binance", `${asset}USDT`, asset, "perpetual", 5, { fundingIntervalHours: 8 }),
    ...(bybitSpotSymbol
      ? [instrument(`bybit-${slug}-spot`, "bybit", "Bybit", bybitSpotSymbol, asset, "spot", 10)]
      : []),
    instrument(`bybit-${slug}-perp`, "bybit", "Bybit", `${asset}USDT`, asset, "perpetual", 5.5, { fundingIntervalHours: 8 }),
    instrument(`okx-${slug}-perp`, "okx", "OKX", `${asset}-USDT-SWAP`, asset, "perpetual", 5, { fundingIntervalHours: 8 }),
  ];
}

export class ArbitrageDashboardService {
  private snapshots = new Map<number, { expiresAt: number; value: ArbitrageDashboardSnapshot }>();
  private history = new Map<string, { expiresAt: number; value: FundingPoint[] }>();
  private inFlight = new Map<number, Promise<ArbitrageDashboardSnapshot>>();
  private lastForcedRefreshAt: number | null = null;
  private readonly now: () => number;
  private readonly snapshotTtl: number;
  private readonly forcedRefreshCooldown: number;
  private readonly snapshotLoader: (horizonDays: 90 | 365) => Promise<ArbitrageDashboardSnapshot>;

  constructor(options: ArbitrageDashboardServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.snapshotTtl = options.snapshotTtlMs ?? snapshotTtlMs;
    this.forcedRefreshCooldown = options.forcedRefreshCooldownMs ?? forcedRefreshCooldownMs;
    this.snapshotLoader = options.snapshotLoader ?? ((horizonDays) => this.loadSnapshot(horizonDays));
  }

  async getSnapshot(horizonDays: 90 | 365, forceRefresh = false): Promise<ArbitrageDashboardSnapshot> {
    const cached = this.snapshots.get(horizonDays);
    const now = this.now();
    if (!forceRefresh && cached && cached.expiresAt > now) return cached.value;

    const pending = this.inFlight.get(horizonDays);
    if (pending) {
      if (forceRefresh && !this.isForcedRefreshCoolingDown(now)) {
        this.lastForcedRefreshAt = now;
      }
      return pending;
    }

    if (forceRefresh) {
      const retryAfterMs = this.forcedRefreshRetryAfterMs(now);
      if (retryAfterMs > 0) {
        if (cached) return cached.value;
        throw new ArbitrageRefreshCooldownError(retryAfterMs);
      }
      this.lastForcedRefreshAt = now;
    }

    const request = Promise.resolve()
      .then(() => this.snapshotLoader(horizonDays))
      .then((snapshot) => {
        this.snapshots.set(horizonDays, { expiresAt: this.now() + this.snapshotTtl, value: snapshot });
        return snapshot;
      })
      .finally(() => {
        if (this.inFlight.get(horizonDays) === request) this.inFlight.delete(horizonDays);
      });
    this.inFlight.set(horizonDays, request);
    return request;
  }

  private isForcedRefreshCoolingDown(now: number) {
    return this.forcedRefreshRetryAfterMs(now) > 0;
  }

  private forcedRefreshRetryAfterMs(now: number) {
    if (this.lastForcedRefreshAt === null) return 0;
    return Math.max(0, this.lastForcedRefreshAt + this.forcedRefreshCooldown - now);
  }

  private async loadSnapshot(horizonDays: 90 | 365): Promise<ArbitrageDashboardSnapshot> {
    const currentBatches = createCurrentMarketBatches();
    const [markets, stablecoin] = await Promise.all([
      mapWithConcurrency(instruments, marketLoadConcurrency, (config) => this.loadMarket(config, currentBatches)),
      this.loadStablecoinPrice(),
    ]);
    const opportunities = buildArbitrageOpportunities(markets, horizonDays, fundingLookbackDays);
    const active = opportunities.filter((item) => item.recommendation !== "blocked");
    const connectedVenues = new Set(markets.filter((market) => market.status !== "disconnected").map((market) => market.venue));
    const unavailableVenues = [...new Set(markets.filter((market) => market.status === "disconnected").map((market) => market.venueLabel))];
    const snapshot: ArbitrageDashboardSnapshot = {
      horizonDays,
      generatedAt: this.now(),
      markets: markets.map(({ fundingHistory: _fundingHistory, ...market }) => market),
      opportunities,
      summary: {
        bestScore: active[0]?.score ?? null,
        bestNetApr: active.length > 0 ? Math.max(...active.map((item) => item.netApr)) : null,
        eligibleOpportunityCount: opportunities.filter((item) => item.recommendation === "recommended" || item.recommendation === "watch").length,
        connectedVenueCount: connectedVenues.size,
        totalVenueCount: 5,
        trackedMarketCount: markets.length,
        usdcUsdtPrice: stablecoin.price,
        stablecoinBasisBps: stablecoin.price === null ? null : Number(((stablecoin.price - 1) * 10_000).toFixed(2)),
      },
      warnings: [
        ...unavailableVenues.map((venue) => `${venue} 部分或全部公开行情暂不可用`),
        ...stablecoin.warnings,
      ],
    };
    return snapshot;
  }

  private async loadMarket(config: InstrumentConfig, currentBatches: CurrentMarketBatches): Promise<InternalArbitrageMarket> {
    try {
      const [current, fundingHistory] = await Promise.all([
        loadCurrentMarket(config, currentBatches),
        config.kind === "perpetual" ? this.loadFundingHistory(config) : Promise.resolve([]),
      ]);
      const intervalHours = current.fundingIntervalHours ?? inferFundingIntervalHours(fundingHistory) ?? config.fundingIntervalHours ?? null;
      const fundingMetrics = config.kind === "spot"
        ? { apr: 0, positiveRatio: null, coverageRatio: 1 }
        : calculateHistoricalFundingMetrics(fundingHistory, fundingLookbackDays);
      const depth = calculateDepthMetrics(current.bids, current.asks);
      const spreadBps = current.bid && current.ask
        ? ((current.ask - current.bid) / ((current.ask + current.bid) / 2)) * 10_000
        : null;
      const warnings = [...(current.warnings ?? [])];
      if (config.kind === "perpetual" && fundingMetrics.coverageRatio < 0.8) warnings.push(`历史费率覆盖不足 ${Math.round(fundingMetrics.coverageRatio * 100)}%`);
      if (depth.slippageBps10k === null) warnings.push("订单簿不足以估算 1 万美元双向滑点");
      return {
        id: config.id,
        venue: config.venue,
        venueLabel: config.venueLabel,
        symbol: config.symbol,
        asset: config.asset,
        kind: config.kind,
        quoteAsset: config.quoteAsset,
        settlementAsset: config.settlementAsset,
        bid: current.bid,
        ask: current.ask,
        markPrice: current.markPrice,
        indexPrice: current.indexPrice,
        spreadBps: nullableRound(spreadBps),
        fundingRate: current.fundingRate,
        fundingIntervalHours: intervalHours,
        currentFundingApr: current.fundingRate !== null && intervalHours
          ? round(current.fundingRate * (24 / intervalHours) * 365 * 100)
          : config.kind === "spot" ? 0 : null,
        historicalFundingApr: fundingMetrics.apr,
        fundingPositiveRatio: fundingMetrics.positiveRatio,
        fundingCoverageRatio: fundingMetrics.coverageRatio,
        slippageBps10k: depth.slippageBps10k,
        slippageBps100k: depth.slippageBps100k,
        depthUsd: depth.depthUsd,
        volume24h: current.volume24h,
        openInterest: current.openInterest,
        nextFundingTime: current.nextFundingTime,
        takerFeeBps: config.takerFeeBps,
        status: warnings.length > 0 ? "degraded" : "connected",
        fetchedAt: current.timestamp,
        availableSince: config.availableSince ?? null,
        warnings: [...new Set(warnings)],
        fundingHistory,
      };
    } catch (error) {
      return disconnectedMarket(config, error);
    }
  }

  private async loadFundingHistory(config: InstrumentConfig) {
    const cached = this.history.get(config.id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await loadFundingHistory(config, fundingLookbackDays);
    this.history.set(config.id, { expiresAt: Date.now() + fundingHistoryTtlMs, value });
    return value;
  }

  private async loadStablecoinPrice() {
    try {
      const payload = await fetchJson(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=USDCUSDT`);
      const bid = numberValue(payload?.bidPrice);
      const ask = numberValue(payload?.askPrice);
      return { price: bid && ask ? (bid + ask) / 2 : null, warnings: [] as string[] };
    } catch {
      return { price: null, warnings: ["USDC/USDT 参考汇率暂不可用"] };
    }
  }
}

function createCurrentMarketBatches(): CurrentMarketBatches {
  const binanceSpotSymbols = configuredSymbols("binance", "spot");
  const binancePerpetualSymbols = configuredSymbols("binance", "perpetual");
  return {
    binanceSpotTickers: safeBatch(() => fetchJson(binanceSymbolsUrl("https://api.binance.com/api/v3/ticker/24hr", binanceSpotSymbols)), "symbol"),
    binancePerpetualTickers: safeBatch(() => fetchJson(binanceSymbolsUrl("https://fapi.binance.com/fapi/v1/ticker/24hr", binancePerpetualSymbols)), "symbol"),
    binancePremiums: safeBatch(() => fetchJson("https://fapi.binance.com/fapi/v1/premiumIndex"), "symbol"),
    bybitSpotTickers: safeBatch(
      async () => (await fetchJson("https://api.bybit.com/v5/market/tickers?category=spot"))?.result?.list,
      "symbol",
    ),
    bybitPerpetualTickers: safeBatch(
      async () => (await fetchJson("https://api.bybit.com/v5/market/tickers?category=linear"))?.result?.list,
      "symbol",
    ),
    bitgetSpotTickers: safeBatch(
      async () => (await fetchJson("https://api.bitget.com/api/v2/spot/market/tickers"))?.data,
      "symbol",
    ),
    bitgetPerpetualTickers: safeBatch(
      async () => (await fetchJson("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES"))?.data,
      "symbol",
    ),
    bitgetFunding: safeBatch(
      async () => (await fetchJson("https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES"))?.data,
      "symbol",
    ),
    okxSpotTickers: safeBatch(
      async () => (await fetchJson("https://www.okx.com/api/v5/market/tickers?instType=SPOT"))?.data,
      "instId",
    ),
    okxPerpetualTickers: safeBatch(
      async () => (await fetchJson("https://www.okx.com/api/v5/market/tickers?instType=SWAP"))?.data,
      "instId",
    ),
  };
}

function configuredSymbols(venue: ArbitrageVenue, kind: ArbitrageInstrumentKind) {
  return [...new Set(instruments
    .filter((config) => config.venue === venue && config.kind === kind)
    .map((config) => config.symbol))];
}

function binanceSymbolsUrl(baseUrl: string, symbols: string[]) {
  const url = new URL(baseUrl);
  url.searchParams.set("symbols", JSON.stringify(symbols));
  return url.toString();
}

async function safeBatch(load: () => Promise<unknown>, symbolKey: string) {
  try {
    const rows = await load();
    if (!Array.isArray(rows)) return new Map<string, any>();
    return new Map(rows
      .filter((row: any) => typeof row?.[symbolKey] === "string")
      .map((row: any) => [row[symbolKey], row]));
  } catch {
    return new Map<string, any>();
  }
}

async function marketBatchValue(batch: Promise<Map<string, any>>, symbol: string, fallback: () => Promise<any>) {
  return (await batch).get(symbol) ?? fallback();
}

async function loadCurrentMarket(config: InstrumentConfig, batches: CurrentMarketBatches): Promise<CurrentMarketPayload> {
  if (config.venue === "binance") return loadBinanceCurrent(config, batches);
  if (config.venue === "bybit") return loadBybitCurrent(config, batches);
  if (config.venue === "bitget") return loadBitgetCurrent(config, batches);
  if (config.venue === "okx") return loadOkxCurrent(config, batches);
  return loadTradeXyzCurrent(config);
}

async function loadBinanceCurrent(config: InstrumentConfig, batches: CurrentMarketBatches): Promise<CurrentMarketPayload> {
  const baseUrl = config.kind === "spot" ? "https://api.binance.com/api/v3" : "https://fapi.binance.com/fapi/v1";
  const [ticker, depth, premium] = await Promise.all([
    marketBatchValue(
      config.kind === "spot" ? batches.binanceSpotTickers : batches.binancePerpetualTickers,
      config.symbol,
      () => fetchJson(`${baseUrl}/ticker/24hr?symbol=${config.symbol}`),
    ),
    fetchJson(`${baseUrl}/depth?symbol=${config.symbol}&limit=100`),
    config.kind === "perpetual"
      ? marketBatchValue(batches.binancePremiums, config.symbol, () => fetchJson(`${baseUrl}/premiumIndex?symbol=${config.symbol}`))
      : Promise.resolve(null),
  ]);
  return currentPayload({
    bid: ticker?.bidPrice,
    ask: ticker?.askPrice,
    markPrice: premium?.markPrice ?? ticker?.lastPrice,
    indexPrice: premium?.indexPrice ?? ticker?.lastPrice,
    fundingRate: premium?.lastFundingRate,
    fundingIntervalHours: config.fundingIntervalHours,
    volume24h: ticker?.quoteVolume,
    openInterest: null,
    nextFundingTime: premium?.nextFundingTime,
    bids: depth?.bids,
    asks: depth?.asks,
    sizeMultiplier: config.sizeMultiplier,
  });
}

async function loadBybitCurrent(config: InstrumentConfig, batches: CurrentMarketBatches): Promise<CurrentMarketPayload> {
  const category = config.kind === "spot" ? "spot" : "linear";
  const [tickerPayload, depthPayload] = await Promise.all([
    marketBatchValue(
      config.kind === "spot" ? batches.bybitSpotTickers : batches.bybitPerpetualTickers,
      config.symbol,
      async () => (await fetchJson(`https://api.bybit.com/v5/market/tickers?category=${category}&symbol=${config.symbol}`))?.result?.list?.[0],
    ),
    fetchJson(`https://api.bybit.com/v5/market/orderbook?category=${category}&symbol=${config.symbol}&limit=200`),
  ]);
  const ticker = tickerPayload;
  const depth = depthPayload?.result;
  if (!ticker) throw new Error("Bybit ticker returned no market");
  return currentPayload({
    bid: ticker.bid1Price,
    ask: ticker.ask1Price,
    markPrice: ticker.markPrice ?? ticker.lastPrice,
    indexPrice: ticker.indexPrice ?? ticker.lastPrice,
    fundingRate: ticker.fundingRate,
    fundingIntervalHours: config.fundingIntervalHours,
    volume24h: ticker.turnover24h,
    openInterest: ticker.openInterestValue ?? ticker.openInterest,
    nextFundingTime: ticker.nextFundingTime,
    bids: depth?.b,
    asks: depth?.a,
    sizeMultiplier: config.sizeMultiplier,
    timestamp: depth?.ts,
  });
}

async function loadBitgetCurrent(config: InstrumentConfig, batches: CurrentMarketBatches): Promise<CurrentMarketPayload> {
  if (config.kind === "spot") {
    const [tickerPayload, depthPayload] = await Promise.all([
      marketBatchValue(
        batches.bitgetSpotTickers,
        config.symbol,
        async () => (await fetchJson(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${config.symbol}`))?.data?.[0],
      ),
      fetchJson(`https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${config.symbol}&type=step0&limit=100`),
    ]);
    const ticker = tickerPayload;
    const depth = depthPayload?.data;
    if (!ticker) throw new Error("Bitget spot ticker returned no market");
    return currentPayload({
      bid: ticker.bidPr,
      ask: ticker.askPr,
      markPrice: ticker.lastPr,
      indexPrice: ticker.lastPr,
      volume24h: ticker.usdtVolume ?? ticker.quoteVolume,
      bids: depth?.bids,
      asks: depth?.asks,
      timestamp: depth?.ts,
    });
  }
  const [tickerPayload, depthPayload, fundingPayload] = await Promise.all([
    marketBatchValue(
      batches.bitgetPerpetualTickers,
      config.symbol,
      async () => (await fetchJson(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${config.symbol}&productType=USDT-FUTURES`))?.data?.[0],
    ),
    fetchJson(`https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${config.symbol}&productType=USDT-FUTURES&precision=scale0&limit=100`),
    marketBatchValue(
      batches.bitgetFunding,
      config.symbol,
      async () => (await fetchJson(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${config.symbol}&productType=USDT-FUTURES`))?.data?.[0],
    ),
  ]);
  const ticker = tickerPayload;
  const depth = depthPayload?.data;
  const funding = fundingPayload;
  if (!ticker) throw new Error("Bitget futures ticker returned no market");
  return currentPayload({
    bid: ticker.bidPr,
    ask: ticker.askPr,
    markPrice: ticker.markPrice ?? ticker.lastPr,
    indexPrice: ticker.indexPrice ?? ticker.lastPr,
    fundingRate: funding?.fundingRate,
    fundingIntervalHours: funding?.fundingRateInterval ?? config.fundingIntervalHours,
    volume24h: ticker.usdtVolume ?? ticker.quoteVolume,
    openInterest: ticker.holdingAmount,
    nextFundingTime: funding?.nextUpdate,
    bids: depth?.bids,
    asks: depth?.asks,
    timestamp: depth?.ts,
  });
}

async function loadOkxCurrent(config: InstrumentConfig, batches: CurrentMarketBatches): Promise<CurrentMarketPayload> {
  const [tickerPayload, depthPayload, fundingPayload] = await Promise.all([
    marketBatchValue(
      config.kind === "spot" ? batches.okxSpotTickers : batches.okxPerpetualTickers,
      config.symbol,
      async () => (await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${config.symbol}`))?.data?.[0],
    ),
    fetchJson(`https://www.okx.com/api/v5/market/books?instId=${config.symbol}&sz=100`),
    config.kind === "perpetual"
      ? fetchJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${config.symbol}`)
      : Promise.resolve(null),
  ]);
  const ticker = tickerPayload;
  const depth = depthPayload?.data?.[0];
  const funding = fundingPayload?.data?.[0];
  if (!ticker) throw new Error("OKX ticker returned no market");
  return currentPayload({
    bid: ticker.bidPx,
    ask: ticker.askPx,
    markPrice: ticker.last,
    indexPrice: ticker.last,
    fundingRate: funding?.fundingRate,
    fundingIntervalHours: funding?.fundingTime && funding?.nextFundingTime
      ? (numberValue(funding.nextFundingTime)! - numberValue(funding.fundingTime)!) / 3_600_000
      : config.fundingIntervalHours,
    volume24h: ticker.volCcy24h ? numberValue(ticker.volCcy24h)! * numberValue(ticker.last)! : null,
    openInterest: null,
    nextFundingTime: funding?.fundingTime,
    bids: depth?.bids,
    asks: depth?.asks,
    sizeMultiplier: config.sizeMultiplier,
    timestamp: depth?.ts,
  });
}

async function loadTradeXyzCurrent(config: InstrumentConfig): Promise<CurrentMarketPayload> {
  const [meta, book] = await Promise.all([
    postHyperliquid({ type: "metaAndAssetCtxs", dex: "xyz" }),
    postHyperliquid({ type: "l2Book", coin: config.symbol }),
  ]);
  const universe = Array.isArray(meta?.[0]?.universe) ? meta[0].universe : [];
  const contexts = Array.isArray(meta?.[1]) ? meta[1] : [];
  const index = universe.findIndex((item: any) => item?.name === config.symbol);
  const context = contexts[index];
  if (index < 0 || !context) throw new Error("tradeXYZ GOLD market is unavailable");
  return currentPayload({
    bid: book?.levels?.[0]?.[0]?.px,
    ask: book?.levels?.[1]?.[0]?.px,
    markPrice: context.markPx,
    indexPrice: context.oraclePx,
    fundingRate: context.funding,
    fundingIntervalHours: 1,
    volume24h: context.dayNtlVlm,
    openInterest: context.openInterest && context.oraclePx
      ? numberValue(context.openInterest)! * numberValue(context.oraclePx)!
      : null,
    nextFundingTime: nextWholeHour(),
    bids: book?.levels?.[0]?.map((level: any) => [level.px, level.sz]),
    asks: book?.levels?.[1]?.map((level: any) => [level.px, level.sz]),
    timestamp: book?.time,
  });
}

async function loadFundingHistory(config: InstrumentConfig, days: number): Promise<FundingPoint[]> {
  const startTime = Date.now() - days * millisecondsPerDay;
  if (config.venue === "binance") {
    const payload = await fetchJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${config.symbol}&startTime=${startTime}&limit=1000`);
    return normalizeFundingRows(payload, "fundingRate", "fundingTime");
  }
  if (config.venue === "bybit") {
    const rows: FundingPoint[] = [];
    let endTime = Date.now();
    for (let page = 0; page < 4 && endTime > startTime; page += 1) {
      const payload = await fetchJson(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${config.symbol}&limit=200&endTime=${endTime}`);
      const batch = normalizeFundingRows(payload?.result?.list, "fundingRate", "fundingRateTimestamp");
      if (batch.length === 0) break;
      rows.push(...batch);
      endTime = Math.min(...batch.map((point) => point.timestamp)) - 1;
    }
    return uniqueFundingRows(rows).filter((point) => point.timestamp >= startTime);
  }
  if (config.venue === "bitget") {
    const rows: FundingPoint[] = [];
    for (let pageNo = 1; pageNo <= 6; pageNo += 1) {
      const payload = await fetchJson(`https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=${config.symbol}&productType=USDT-FUTURES&pageSize=100&pageNo=${pageNo}`);
      const batch = normalizeFundingRows(payload?.data, "fundingRate", "fundingTime");
      if (batch.length === 0) break;
      rows.push(...batch);
      if (Math.min(...batch.map((point) => point.timestamp)) <= startTime) break;
    }
    return uniqueFundingRows(rows).filter((point) => point.timestamp >= startTime);
  }
  if (config.venue === "okx") {
    const payload = await fetchJson(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${config.symbol}&limit=400`);
    return normalizeFundingRows(payload?.data, "realizedRate", "fundingTime")
      .filter((point) => point.timestamp >= startTime);
  }
  const rows: FundingPoint[] = [];
  let cursor = startTime;
  for (let page = 0; page < 6 && cursor < Date.now(); page += 1) {
    const payload = await postHyperliquid({ type: "fundingHistory", coin: config.symbol, startTime: cursor });
    const batch = normalizeFundingRows(payload, "fundingRate", "time");
    if (batch.length === 0) break;
    rows.push(...batch);
    const nextCursor = Math.max(...batch.map((point) => point.timestamp)) + 1;
    if (nextCursor <= cursor || batch.length < 500) break;
    cursor = nextCursor;
  }
  return uniqueFundingRows(rows).filter((point) => point.timestamp >= startTime);
}

function currentPayload(input: Record<string, any>): CurrentMarketPayload {
  return {
    bid: numberValue(input.bid),
    ask: numberValue(input.ask),
    markPrice: numberValue(input.markPrice),
    indexPrice: numberValue(input.indexPrice),
    fundingRate: numberValue(input.fundingRate),
    fundingIntervalHours: numberValue(input.fundingIntervalHours),
    volume24h: numberValue(input.volume24h),
    openInterest: numberValue(input.openInterest),
    nextFundingTime: numberValue(input.nextFundingTime),
    timestamp: numberValue(input.timestamp) ?? Date.now(),
    bids: normalizeBook(input.bids, input.sizeMultiplier),
    asks: normalizeBook(input.asks, input.sizeMultiplier),
    warnings: input.warnings,
  };
}

function calculateDepthMetrics(bids: OrderbookLevel[], asks: OrderbookLevel[]) {
  const bidDepth = bids.reduce((sum, level) => sum + level.price * level.size, 0);
  const askDepth = asks.reduce((sum, level) => sum + level.price * level.size, 0);
  return {
    depthUsd: bids.length > 0 && asks.length > 0 ? Math.round(Math.min(bidDepth, askDepth)) : null,
    slippageBps10k: combinedSlippageBps(bids, asks, 10_000),
    slippageBps100k: combinedSlippageBps(bids, asks, 100_000),
  };
}

function combinedSlippageBps(bids: OrderbookLevel[], asks: OrderbookLevel[], notional: number) {
  const sell = sideSlippageBps(bids, notional, "sell");
  const buy = sideSlippageBps(asks, notional, "buy");
  if (sell === null || buy === null) return null;
  return round((sell + buy) / 2);
}

function sideSlippageBps(levels: OrderbookLevel[], notional: number, side: "buy" | "sell") {
  const best = levels[0]?.price;
  if (!best) return null;
  let remaining = notional;
  let quantity = 0;
  let value = 0;
  for (const level of levels) {
    const available = level.price * level.size;
    const used = Math.min(remaining, available);
    quantity += used / level.price;
    value += used;
    remaining -= used;
    if (remaining <= 0.01) break;
  }
  if (remaining > 0.01 || quantity <= 0) return null;
  const vwap = value / quantity;
  return side === "buy" ? ((vwap - best) / best) * 10_000 : ((best - vwap) / best) * 10_000;
}

function disconnectedMarket(config: InstrumentConfig, error: unknown): InternalArbitrageMarket {
  return {
    id: config.id,
    venue: config.venue,
    venueLabel: config.venueLabel,
    symbol: config.symbol,
    asset: config.asset,
    kind: config.kind,
    quoteAsset: config.quoteAsset,
    settlementAsset: config.settlementAsset,
    bid: null,
    ask: null,
    markPrice: null,
    indexPrice: null,
    spreadBps: null,
    fundingRate: null,
    fundingIntervalHours: config.kind === "perpetual" ? config.fundingIntervalHours ?? null : null,
    currentFundingApr: config.kind === "spot" ? 0 : null,
    historicalFundingApr: config.kind === "spot" ? 0 : null,
    fundingPositiveRatio: null,
    fundingCoverageRatio: config.kind === "spot" ? 1 : 0,
    slippageBps10k: null,
    slippageBps100k: null,
    depthUsd: null,
    volume24h: null,
    openInterest: null,
    nextFundingTime: null,
    takerFeeBps: config.takerFeeBps,
    status: "disconnected",
    fetchedAt: Date.now(),
    availableSince: config.availableSince ?? null,
    warnings: [error instanceof Error ? error.message : "公开行情请求失败"],
    fundingHistory: [],
  };
}

function instrument(
  id: string,
  venue: ArbitrageVenue,
  venueLabel: string,
  symbol: string,
  asset: ArbitrageAsset,
  kind: ArbitrageInstrumentKind,
  takerFeeBps: number,
  overrides: Partial<Pick<InstrumentConfig, "quoteAsset" | "settlementAsset" | "sizeMultiplier" | "fundingIntervalHours" | "availableSince">> = {},
): InstrumentConfig {
  return {
    id,
    venue,
    venueLabel,
    symbol,
    asset,
    kind,
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    takerFeeBps,
    ...overrides,
  };
}

function normalizeBook(input: unknown, sizeMultiplier = 1): OrderbookLevel[] {
  if (!Array.isArray(input)) return [];
  return input.map((row: any) => {
    const price = numberValue(Array.isArray(row) ? row[0] : row?.px);
    const size = numberValue(Array.isArray(row) ? row[1] : row?.sz);
    return price && size ? { price, size: size * sizeMultiplier } : null;
  }).filter((row): row is OrderbookLevel => row !== null);
}

function normalizeFundingRows(input: unknown, rateKey: string, timeKey: string): FundingPoint[] {
  if (!Array.isArray(input)) return [];
  return input.map((row: any) => {
    const rate = numberValue(row?.[rateKey]);
    const timestamp = numberValue(row?.[timeKey]);
    return rate !== null && timestamp ? { rate, timestamp } : null;
  }).filter((row): row is FundingPoint => row !== null);
}

function uniqueFundingRows(rows: FundingPoint[]) {
  return [...new Map(rows.map((row) => [row.timestamp, row])).values()].sort((left, right) => left.timestamp - right.timestamp);
}

function inferFundingIntervalHours(history: FundingPoint[]) {
  if (history.length < 2) return null;
  const ordered = [...history].sort((left, right) => left.timestamp - right.timestamp);
  const differences = ordered.slice(1).map((point, index) => (point.timestamp - ordered[index].timestamp) / 3_600_000)
    .filter((value) => value > 0 && value <= 24)
    .sort((left, right) => left - right);
  return differences[Math.floor(differences.length / 2)] ?? null;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (attempt === 1) throw error;
      await delay(150);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) return await response.json();
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      await delay(150);
      continue;
    }
    throw new Error(`公开行情请求失败 (${response.status})`);
  }
  throw new Error("公开行情请求失败");
}

function postHyperliquid(body: unknown) {
  return fetchJson("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableRound(value: number | null) {
  return value === null ? null : round(value);
}

function round(value: number) {
  return Number(value.toFixed(4));
}

function nextWholeHour() {
  return Math.ceil(Date.now() / 3_600_000) * 3_600_000;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  load: (input: TInput) => Promise<TOutput>,
) {
  const output = new Array<TOutput>(inputs.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await load(inputs[index]);
    }
  });
  await Promise.all(workers);
  return output;
}
