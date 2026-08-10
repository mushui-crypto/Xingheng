import type { MarketDataPort } from "../cex/CexCapabilityPorts";
import type { CanonicalTopOfBook } from "../cex/CexCanonicalModels";
import type { BybitInstrumentBinding, BybitMarketTicker } from "./BybitReadTypes";

const BYBIT_API_BASE_URL = "https://api.bybit.com";

export type BybitTickerSource = (symbol: string) => Promise<{
  ticker: BybitMarketTicker;
  fetchedAt: number;
}>;

type BybitTickerSourceOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}>;

type BybitTickerResponse = {
  retCode?: number;
  retMsg?: string;
  result?: {
    list?: BybitMarketTicker[];
  };
};

export function createBybitTickerSource(options: BybitTickerSourceOptions = {}): BybitTickerSource {
  const baseUrl = options.baseUrl ?? BYBIT_API_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return async (symbol) => {
    const url = new URL("/v5/market/tickers", baseUrl);
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", symbol);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Bybit ticker request failed: ${response.status}.`);
    const payload = await response.json() as BybitTickerResponse;
    if (payload.retCode !== undefined && payload.retCode !== 0) {
      throw new Error(`Bybit ticker response rejected: ${payload.retCode}.`);
    }
    const ticker = payload.result?.list?.[0];
    if (!ticker) throw new Error("Bybit ticker response is empty.");
    return { ticker, fetchedAt: Date.now() };
  };
}

export class BybitMarketData implements MarketDataPort {
  readonly venue = "bybit" as const;
  private readonly providerSymbols: ReadonlyMap<string, string>;

  constructor(private readonly source: BybitTickerSource, bindings: readonly BybitInstrumentBinding[]) {
    this.providerSymbols = new Map(bindings.map((binding) => [binding.instrumentId, binding.providerSymbol]));
  }

  async getTopOfBook(instrumentId: string) {
    const providerSymbol = this.providerSymbols.get(instrumentId);
    if (!providerSymbol) throw new Error(`Unsupported Bybit market data instrument: ${instrumentId}.`);
    const snapshot = await this.source(providerSymbol);
    if (!snapshot.ticker) throw new Error("Bybit ticker response is empty.");
    if (snapshot.ticker.symbol !== providerSymbol) {
      throw new Error(`Unexpected Bybit ticker symbol: ${snapshot.ticker.symbol}.`);
    }
    return toCanonicalBybitTopOfBook(instrumentId, snapshot.ticker, snapshot.fetchedAt);
  }
}

export function toCanonicalBybitTopOfBook(
  instrumentId: string,
  raw: BybitMarketTicker,
  fetchedAt: number,
): CanonicalTopOfBook {
  return {
    venue: "bybit",
    instrumentId,
    bid: providerPositiveNumber(raw.bid1Price, "Bybit bid1Price"),
    ask: providerPositiveNumber(raw.ask1Price, "Bybit ask1Price"),
    markPrice: null,
    depthUsd: null,
    fetchedAt: providerTimestamp(fetchedAt, "Bybit fetchedAt"),
  };
}

function providerPositiveNumber(value: string, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}

function providerTimestamp(value: number, field: string) {
  if (Number.isInteger(value) && value >= 0) return value;
  throw new Error(`Invalid ${field}: ${value}.`);
}
