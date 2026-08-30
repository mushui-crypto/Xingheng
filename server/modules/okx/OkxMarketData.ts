import { tracedProviderFetch, tracedProviderJson } from "../cex/ProviderRequestTrace";
import type { MarketDataPort } from "../cex/CexCapabilityPorts";
import type { CanonicalTopOfBook } from "../cex/CexCanonicalModels";
import type { OkxInstrumentBinding, OkxTickerRecord } from "./OkxReadTypes";

const OKX_API_BASE_URL = "https://www.okx.com";

export type OkxTickerSource = (symbol: string) => Promise<{ ticker: OkxTickerRecord; fetchedAt: number }>;

type OkxTickerSourceOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}>;

type OkxTickerResponse = {
  code?: string;
  msg?: string;
  data?: OkxTickerRecord[];
};

export function createOkxTickerSource(options: OkxTickerSourceOptions = {}): OkxTickerSource {
  const baseUrl = options.baseUrl ?? OKX_API_BASE_URL;
  const fetchImpl = tracedProviderFetch("okx", options.fetchImpl ?? fetch);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return async (symbol) => {
    const url = new URL("/api/v5/market/ticker", baseUrl);
    url.searchParams.set("instId", symbol);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`OKX ticker request failed: ${response.status}.`);
    const payload = await tracedProviderJson(response) as OkxTickerResponse;
    if (payload.code && payload.code !== "0") {
      throw new Error(`OKX ticker response rejected: ${payload.code}.`);
    }
    const ticker = payload.data?.[0];
    if (!ticker) throw new Error("OKX ticker response is empty.");
    return { ticker, fetchedAt: Date.now() };
  };
}

export class OkxMarketData implements MarketDataPort {
  readonly venue = "okx" as const;
  private readonly providerSymbols: ReadonlyMap<string, string>;

  constructor(private readonly source: OkxTickerSource, bindings: readonly OkxInstrumentBinding[]) {
    this.providerSymbols = new Map(bindings.map((binding) => [binding.instrumentId, binding.providerSymbol]));
  }

  async getTopOfBook(instrumentId: string) {
    const providerSymbol = this.providerSymbols.get(instrumentId);
    if (!providerSymbol) throw new Error(`Unsupported OKX market data instrument: ${instrumentId}.`);
    const snapshot = await this.source(providerSymbol);
    if (!snapshot.ticker) throw new Error("OKX ticker response is empty.");
    if (snapshot.ticker.instId !== providerSymbol) {
      throw new Error(`Unexpected OKX ticker symbol: ${snapshot.ticker.instId}.`);
    }
    return toCanonicalOkxTopOfBook(instrumentId, snapshot.ticker, snapshot.fetchedAt);
  }
}

export function toCanonicalOkxTopOfBook(
  instrumentId: string,
  raw: OkxTickerRecord,
  fetchedAt: number,
): CanonicalTopOfBook {
  return {
    venue: "okx",
    instrumentId,
    bid: providerPositiveNumber(raw.bidPx, "OKX bidPx"),
    ask: providerPositiveNumber(raw.askPx, "OKX askPx"),
    markPrice: null,
    depthUsd: null,
    fetchedAt: providerTimestamp(raw.ts, "OKX ticker ts"),
  };
}

function providerPositiveNumber(value: string, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${field}: ${value}.`);
  return parsed;
}

function providerTimestamp(value: string, field: string) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw new Error(`Invalid ${field}: ${value}.`);
}
