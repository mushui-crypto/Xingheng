import { BitgetFundingRate } from "../../bitget/BitgetFundingRate";
import { BitgetInstrumentCatalog } from "../../bitget/BitgetInstrumentCatalog";
import { BitgetMarketData } from "../../bitget/BitgetMarketData";
import { canonicalInstrumentId } from "../Instrument";
import type {
  BitgetFundingRateRecord,
  BitgetMarketTicker,
  BitgetUsdtPerpetualInstrument,
} from "../../bitget/BitgetReadTypes";
import { BybitFundingRate } from "../../bybit/BybitFundingRate";
import { BybitInstrumentCatalog } from "../../bybit/BybitInstrumentCatalog";
import { BybitMarketData } from "../../bybit/BybitMarketData";
import type {
  BybitFundingTicker,
  BybitLinearPerpetualInstrument,
  BybitMarketTicker,
} from "../../bybit/BybitReadTypes";
import { OkxFundingRate } from "../../okx/OkxFundingRate";
import { OkxInstrumentCatalog } from "../../okx/OkxInstrumentCatalog";
import { OkxMarketData } from "../../okx/OkxMarketData";
import type {
  OkxFundingRateRecord,
  OkxSwapInstrument,
  OkxTickerRecord,
} from "../../okx/OkxReadTypes";
import type {
  FundingRatePort,
  InstrumentCatalogPort,
  MarketDataPort,
} from "../CexCapabilityPorts";
import type {
  CanonicalFundingRate,
  CanonicalInstrument,
  CanonicalTopOfBook,
} from "../CexCanonicalModels";
import { CanonicalFundingOpportunitySource, type FundingOpportunityReadVenue } from "./CanonicalFundingOpportunitySource";

const DEFAULT_SYMBOLS = ["XAUTUSDT"] as const;
const BINANCE_FUTURES_BASE_URL = "https://fapi.binance.com";
const OKX_BASE_URL = "https://www.okx.com";
const BYBIT_BASE_URL = "https://api.bybit.com";
const BITGET_BASE_URL = "https://api.bitget.com";

export type DefaultFundingOpportunitySourceOptions = Readonly<{
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  symbols?: readonly string[];
}>;

export function createDefaultFundingOpportunitySource(options: DefaultFundingOpportunitySourceOptions = {}) {
  const symbols = options.symbols ?? DEFAULT_SYMBOLS;
  return new CanonicalFundingOpportunitySource({
    venues: [
      createBinanceReadVenue(options, symbols),
      createOkxReadVenue(options, symbols),
      createBybitReadVenue(options, symbols),
      createBitgetReadVenue(options, symbols),
    ],
    symbols,
    parameters: {
      minimumNetYield: 0,
      maxSnapshotAgeMs: 30_000,
      maxFundingTimeSkewMs: 5 * 60_000,
      entryCutoffMs: 5 * 60_000,
    },
    now: options.now,
  });
}

function createOkxReadVenue(
  options: DefaultFundingOpportunitySourceOptions,
  symbols: readonly string[],
): FundingOpportunityReadVenue {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const bindings = symbols.map(toUsdtBinding).map((binding) => ({
    instrumentId: canonicalInstrumentId(binding.base, "USDT", "perpetual"),
    providerSymbol: `${binding.base}-USDT-SWAP`,
  }));
  return {
    venue: "okx",
    instrumentCatalog: new OkxInstrumentCatalog(async () => ({
      instruments: await readOkxInstruments(fetchImpl, timeoutMs),
      fetchedAt: now(),
    })),
    fundingRate: new OkxFundingRate(async (symbol) => ({
      fundingRate: await readOkxFundingRate(symbol, fetchImpl, timeoutMs),
      fetchedAt: now(),
    }), bindings),
    marketData: new OkxMarketData(async (symbol) => ({
      ticker: await readOkxTicker(symbol, fetchImpl, timeoutMs),
      fetchedAt: now(),
    }), bindings),
  };
}

function createBybitReadVenue(
  options: DefaultFundingOpportunitySourceOptions,
  symbols: readonly string[],
): FundingOpportunityReadVenue {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const bindings = symbols.map(toUsdtBinding).map((binding) => ({
    instrumentId: canonicalInstrumentId(binding.base, "USDT", "perpetual"),
    providerSymbol: `${binding.base}USDT`,
  }));
  return {
    venue: "bybit",
    instrumentCatalog: new BybitInstrumentCatalog(async () => ({
      instruments: await readBybitInstruments(fetchImpl, timeoutMs),
      fetchedAt: now(),
    })),
    fundingRate: new BybitFundingRate(async (symbol) => ({
      fundingRate: await readBybitFundingRate(symbol, fetchImpl, timeoutMs),
      fetchedAt: now(),
    }), bindings),
    marketData: new BybitMarketData(async (symbol) => ({
      ticker: await readBybitTicker(symbol, fetchImpl, timeoutMs),
      fetchedAt: now(),
    }), bindings),
  };
}

function createBitgetReadVenue(
  options: DefaultFundingOpportunitySourceOptions,
  symbols: readonly string[],
): FundingOpportunityReadVenue {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const bindings = symbols.map(toUsdtBinding).map((binding) => ({
    instrumentId: canonicalInstrumentId(binding.base, "USDT", "perpetual"),
    providerSymbol: `${binding.base}USDT`,
  }));
  return {
    venue: "bitget",
    instrumentCatalog: new BitgetInstrumentCatalog(async () => ({
      instruments: await readBitgetInstruments(fetchImpl, timeoutMs),
      fetchedAt: now(),
    })),
    fundingRate: new BitgetFundingRate(async (symbol) => ({
      fundingRate: await readBitgetFundingRate(symbol, fetchImpl, timeoutMs),
      fetchedAt: now(),
    }), bindings),
    marketData: new BitgetMarketData(async (symbol) => ({
      ticker: await readBitgetTicker(symbol, fetchImpl, timeoutMs),
      fetchedAt: now(),
    }), bindings),
  };
}

function createBinanceReadVenue(
  options: DefaultFundingOpportunitySourceOptions,
  symbols: readonly string[],
): FundingOpportunityReadVenue {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const requestedSymbols = new Set(symbols.map(normalizeSymbol).filter(Boolean));
  return {
    venue: "binance",
    instrumentCatalog: {
      venue: "binance",
      listInstruments: async () => listBinanceInstruments(fetchImpl, timeoutMs, now, requestedSymbols),
    },
    fundingRate: {
      venue: "binance",
      getFundingRate: async (instrumentId) => readBinanceFundingRate(instrumentId, fetchImpl, timeoutMs, now),
    },
    marketData: {
      venue: "binance",
      getTopOfBook: async (instrumentId) => readBinanceTopOfBook(instrumentId, fetchImpl, timeoutMs, now),
    },
  };
}

async function readOkxInstruments(fetchImpl: typeof fetch, timeoutMs: number) {
  const url = new URL("/api/v5/public/instruments", OKX_BASE_URL);
  url.searchParams.set("instType", "SWAP");
  const payload = await readJson<{ code?: string; data?: OkxSwapInstrument[] }>(url, fetchImpl, timeoutMs, "OKX instruments");
  if (payload.code && payload.code !== "0") throw new Error(`OKX instruments response rejected: ${payload.code}.`);
  return payload.data ?? [];
}

async function readOkxFundingRate(symbol: string, fetchImpl: typeof fetch, timeoutMs: number) {
  const url = new URL("/api/v5/public/funding-rate", OKX_BASE_URL);
  url.searchParams.set("instId", symbol);
  const payload = await readJson<{ code?: string; data?: OkxFundingRateRecord[] }>(url, fetchImpl, timeoutMs, "OKX funding");
  if (payload.code && payload.code !== "0") throw new Error(`OKX funding response rejected: ${payload.code}.`);
  const fundingRate = payload.data?.[0];
  if (!fundingRate) throw new Error("OKX funding response is empty.");
  return fundingRate;
}

async function readOkxTicker(symbol: string, fetchImpl: typeof fetch, timeoutMs: number) {
  const url = new URL("/api/v5/market/ticker", OKX_BASE_URL);
  url.searchParams.set("instId", symbol);
  const payload = await readJson<{ code?: string; data?: OkxTickerRecord[] }>(url, fetchImpl, timeoutMs, "OKX ticker");
  if (payload.code && payload.code !== "0") throw new Error(`OKX ticker response rejected: ${payload.code}.`);
  const ticker = payload.data?.[0];
  if (!ticker) throw new Error("OKX ticker response is empty.");
  return ticker;
}

async function readBybitInstruments(fetchImpl: typeof fetch, timeoutMs: number) {
  const url = new URL("/v5/market/instruments-info", BYBIT_BASE_URL);
  url.searchParams.set("category", "linear");
  url.searchParams.set("limit", "1000");
  const payload = await readJson<{ retCode?: number; result?: { list?: BybitLinearPerpetualInstrument[] } }>(
    url,
    fetchImpl,
    timeoutMs,
    "Bybit instruments",
  );
  if (payload.retCode !== undefined && payload.retCode !== 0) {
    throw new Error(`Bybit instruments response rejected: ${payload.retCode}.`);
  }
  return payload.result?.list ?? [];
}

async function readBybitFundingRate(symbol: string, fetchImpl: typeof fetch, timeoutMs: number) {
  const url = new URL("/v5/market/tickers", BYBIT_BASE_URL);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", symbol);
  const payload = await readJson<{ retCode?: number; result?: { list?: BybitFundingTicker[] } }>(
    url,
    fetchImpl,
    timeoutMs,
    "Bybit funding",
  );
  if (payload.retCode !== undefined && payload.retCode !== 0) {
    throw new Error(`Bybit funding response rejected: ${payload.retCode}.`);
  }
  const fundingRate = payload.result?.list?.[0];
  if (!fundingRate) throw new Error("Bybit funding response is empty.");
  return fundingRate;
}

async function readBybitTicker(symbol: string, fetchImpl: typeof fetch, timeoutMs: number) {
  const url = new URL("/v5/market/tickers", BYBIT_BASE_URL);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", symbol);
  const payload = await readJson<{ retCode?: number; result?: { list?: BybitMarketTicker[] } }>(
    url,
    fetchImpl,
    timeoutMs,
    "Bybit ticker",
  );
  if (payload.retCode !== undefined && payload.retCode !== 0) {
    throw new Error(`Bybit ticker response rejected: ${payload.retCode}.`);
  }
  const ticker = payload.result?.list?.[0];
  if (!ticker) throw new Error("Bybit ticker response is empty.");
  return ticker;
}

async function readBitgetInstruments(fetchImpl: typeof fetch, timeoutMs: number) {
  const url = new URL("/api/v2/mix/market/contracts", BITGET_BASE_URL);
  url.searchParams.set("productType", "USDT-FUTURES");
  const payload = await readJson<{ code?: string; data?: BitgetUsdtPerpetualInstrument[] }>(
    url,
    fetchImpl,
    timeoutMs,
    "Bitget instruments",
  );
  if (payload.code && payload.code !== "00000") throw new Error(`Bitget instruments response rejected: ${payload.code}.`);
  return payload.data ?? [];
}

async function readBitgetFundingRate(symbol: string, fetchImpl: typeof fetch, timeoutMs: number) {
  const url = new URL("/api/v2/mix/market/current-fund-rate", BITGET_BASE_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("productType", "USDT-FUTURES");
  const payload = await readJson<{ code?: string; data?: BitgetFundingRateRecord | BitgetFundingRateRecord[] }>(
    url,
    fetchImpl,
    timeoutMs,
    "Bitget funding",
  );
  if (payload.code && payload.code !== "00000") throw new Error(`Bitget funding response rejected: ${payload.code}.`);
  const fundingRate = Array.isArray(payload.data) ? payload.data[0] : payload.data;
  if (!fundingRate) throw new Error("Bitget funding response is empty.");
  return fundingRate;
}

async function readBitgetTicker(symbol: string, fetchImpl: typeof fetch, timeoutMs: number) {
  const url = new URL("/api/v2/mix/market/ticker", BITGET_BASE_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("productType", "USDT-FUTURES");
  const payload = await readJson<{ code?: string; data?: BitgetMarketTicker[] }>(
    url,
    fetchImpl,
    timeoutMs,
    "Bitget ticker",
  );
  if (payload.code && payload.code !== "00000") throw new Error(`Bitget ticker response rejected: ${payload.code}.`);
  const ticker = payload.data?.[0];
  if (!ticker) throw new Error("Bitget ticker response is empty.");
  return ticker;
}

async function listBinanceInstruments(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  now: () => number,
  requestedSymbols: ReadonlySet<string>,
) {
  const url = new URL("/fapi/v1/exchangeInfo", BINANCE_FUTURES_BASE_URL);
  const payload = await readJson<{ symbols?: BinanceExchangeInfoSymbol[] }>(url, fetchImpl, timeoutMs, "Binance instruments");
  return (payload.symbols ?? [])
    .filter((symbol) => symbol.contractType === "PERPETUAL")
    .filter((symbol) => requestedSymbols.size === 0 || requestedSymbols.has(normalizeSymbol(symbol.symbol)))
    .map((symbol) => toCanonicalBinanceInstrument(symbol, now()));
}

async function readBinanceFundingRate(
  instrumentId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  now: () => number,
): Promise<CanonicalFundingRate> {
  const symbol = binanceSymbolFromInstrumentId(instrumentId);
  const premiumUrl = new URL("/fapi/v1/premiumIndex", BINANCE_FUTURES_BASE_URL);
  premiumUrl.searchParams.set("symbol", symbol);
  const historyUrl = new URL("/fapi/v1/fundingRate", BINANCE_FUTURES_BASE_URL);
  historyUrl.searchParams.set("symbol", symbol);
  historyUrl.searchParams.set("limit", "1");
  const [premium, history] = await Promise.all([
    readJson<BinancePremiumIndex>(premiumUrl, fetchImpl, timeoutMs, "Binance premium index"),
    readJson<BinanceFundingHistory[]>(historyUrl, fetchImpl, timeoutMs, "Binance funding history"),
  ]);
  if (premium.symbol !== symbol) throw new Error(`Unexpected Binance funding symbol: ${premium.symbol}.`);
  const lastFundingAt = providerTimestamp(history[0]?.fundingTime, "Binance fundingTime");
  const nextFundingAt = providerTimestamp(premium.nextFundingTime, "Binance nextFundingTime");
  const intervalHours = (nextFundingAt - lastFundingAt) / 3_600_000;
  if (!Number.isInteger(intervalHours) || intervalHours <= 0) {
    throw new Error(`Invalid Binance funding interval: ${intervalHours}.`);
  }
  return {
    venue: "binance",
    instrumentId,
    rate: providerNumber(premium.lastFundingRate, "Binance lastFundingRate"),
    intervalHours,
    nextFundingAt,
    markPrice: providerPositiveNumber(premium.markPrice, "Binance markPrice"),
    fetchedAt: now(),
  };
}

async function readBinanceTopOfBook(
  instrumentId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  now: () => number,
): Promise<CanonicalTopOfBook> {
  const symbol = binanceSymbolFromInstrumentId(instrumentId);
  const url = new URL("/fapi/v1/ticker/bookTicker", BINANCE_FUTURES_BASE_URL);
  url.searchParams.set("symbol", symbol);
  const ticker = await readJson<BinanceBookTicker>(url, fetchImpl, timeoutMs, "Binance ticker");
  if (ticker.symbol !== symbol) throw new Error(`Unexpected Binance ticker symbol: ${ticker.symbol}.`);
  return {
    venue: "binance",
    instrumentId,
    bid: providerPositiveNumber(ticker.bidPrice, "Binance bidPrice"),
    ask: providerPositiveNumber(ticker.askPrice, "Binance askPrice"),
    markPrice: null,
    depthUsd: null,
    fetchedAt: now(),
  };
}

type BinanceExchangeInfoSymbol = {
  symbol?: string;
  contractType?: string;
  status?: string;
  baseAsset?: string;
  quoteAsset?: string;
  marginAsset?: string;
  filters?: Array<Record<string, string>>;
};

type BinancePremiumIndex = {
  symbol?: string;
  markPrice?: string;
  lastFundingRate?: string;
  nextFundingTime?: number | string;
};

type BinanceFundingHistory = {
  fundingTime?: number | string;
};

type BinanceBookTicker = {
  symbol?: string;
  bidPrice?: string;
  askPrice?: string;
};

function toCanonicalBinanceInstrument(raw: BinanceExchangeInfoSymbol, fetchedAt: number): CanonicalInstrument {
  const symbol = requireProviderString(raw.symbol, "Binance symbol");
  const baseAsset = requireProviderString(raw.baseAsset, "Binance baseAsset");
  const quoteAsset = requireProviderString(raw.quoteAsset, "Binance quoteAsset");
  const settlementAsset = requireProviderString(raw.marginAsset, "Binance marginAsset");
  return {
    instrumentId: canonicalInstrumentId(baseAsset, quoteAsset, "perpetual"),
    venue: "binance",
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset,
    quoteAsset,
    settlementAsset,
    providerSymbol: symbol,
    providerLocator: { scope: "futures" },
    quantityUnit: "base",
    contractSize: 1,
    priceTick: providerPositiveNumber(findFilterValue(raw, "PRICE_FILTER", "tickSize"), "Binance tickSize"),
    quantityStep: providerPositiveNumber(findFilterValue(raw, "LOT_SIZE", "stepSize"), "Binance stepSize"),
    minQuantity: providerPositiveNumber(findFilterValue(raw, "LOT_SIZE", "minQty"), "Binance minQty"),
    minNotional: providerPositiveNumber(findFilterValue(raw, "MIN_NOTIONAL", "notional"), "Binance minNotional"),
    status: raw.status === "TRADING" ? "trading" : raw.status === "SETTLING" ? "close_only" : raw.status === "PENDING_TRADING" ? "paused" : "unknown",
    fetchedAt,
  };
}

async function readJson<T>(
  url: URL,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  label: string,
) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${label} request failed: ${response.status}.`);
  return await response.json() as T;
}

function toUsdtBinding(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  const match = /^([A-Z0-9]+)USDT$/u.exec(normalized);
  if (!match) throw new Error(`Unsupported funding opportunity symbol: ${symbol}.`);
  return { base: match[1]! };
}

function normalizeSymbol(value: unknown) {
  return typeof value === "string" ? value.replace(/[-_/]/gu, "").trim().toUpperCase() : "";
}

function binanceSymbolFromInstrumentId(instrumentId: string) {
  const match = /^([A-Z0-9]{2,12})-([A-Z0-9]{2,12})-PERP$/u.exec(instrumentId);
  if (!match) throw new Error(`Unsupported Binance funding opportunity instrument: ${instrumentId}.`);
  return `${match[1]}${match[2]}`;
}

function findFilterValue(raw: BinanceExchangeInfoSymbol, filterType: string, field: string) {
  return raw.filters?.find((filter) => filter.filterType === filterType)?.[field];
}

function requireProviderString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${field}: ${value}.`);
  return value.trim().toUpperCase();
}

function providerPositiveNumber(value: unknown, field: string) {
  const parsed = providerNumber(value, field);
  if (parsed <= 0) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}

function providerNumber(value: unknown, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}

function providerTimestamp(value: unknown, field: string) {
  const parsed = providerNumber(value, field);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}
