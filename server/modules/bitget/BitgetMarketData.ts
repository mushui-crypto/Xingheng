import type { MarketDataPort } from "../cex/CexCapabilityPorts";
import type { CanonicalTopOfBook } from "../cex/CexCanonicalModels";
import type { BitgetInstrumentBinding, BitgetMarketTicker } from "./BitgetReadTypes";

const BITGET_API_BASE_URL = "https://api.bitget.com";

export type BitgetTickerSource = (symbol: string) => Promise<{
  ticker: BitgetMarketTicker;
  fetchedAt: number;
}>;

type BitgetTickerSourceOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}>;

type BitgetTickerResponse = {
  code?: string;
  msg?: string;
  data?: BitgetMarketTicker[];
};

export function createBitgetTickerSource(options: BitgetTickerSourceOptions = {}): BitgetTickerSource {
  const baseUrl = options.baseUrl ?? BITGET_API_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return async (symbol) => {
    const url = new URL("/api/v2/mix/market/ticker", baseUrl);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("productType", "USDT-FUTURES");
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Bitget ticker request failed: ${response.status}.`);
    const payload = await response.json() as BitgetTickerResponse;
    if (payload.code && payload.code !== "00000") {
      throw new Error(`Bitget ticker response rejected: ${payload.code}.`);
    }
    const ticker = payload.data?.[0];
    if (!ticker) throw new Error("Bitget ticker response is empty.");
    return { ticker, fetchedAt: Date.now() };
  };
}

export class BitgetMarketData implements MarketDataPort {
  readonly venue = "bitget" as const;
  private readonly providerSymbols: ReadonlyMap<string, string>;

  constructor(private readonly source: BitgetTickerSource, bindings: readonly BitgetInstrumentBinding[]) {
    this.providerSymbols = new Map(bindings.map((binding) => [binding.instrumentId, binding.providerSymbol]));
  }

  async getTopOfBook(instrumentId: string) {
    const providerSymbol = this.providerSymbols.get(instrumentId);
    if (!providerSymbol) throw new Error(`Unsupported Bitget market data instrument: ${instrumentId}.`);
    const snapshot = await this.source(providerSymbol);
    if (!snapshot.ticker) throw new Error("Bitget ticker response is empty.");
    if (snapshot.ticker.symbol !== providerSymbol) {
      throw new Error(`Unexpected Bitget ticker symbol: ${snapshot.ticker.symbol}.`);
    }
    return toCanonicalBitgetTopOfBook(instrumentId, snapshot.ticker, snapshot.fetchedAt);
  }
}

export function toCanonicalBitgetTopOfBook(
  instrumentId: string,
  raw: BitgetMarketTicker,
  fetchedAt: number,
): CanonicalTopOfBook {
  return {
    venue: "bitget",
    instrumentId,
    bid: providerPositiveNumber(raw.bidPr, "Bitget bidPr"),
    ask: providerPositiveNumber(raw.askPr, "Bitget askPr"),
    markPrice: null,
    depthUsd: null,
    fetchedAt: providerTimestamp(fetchedAt, "Bitget fetchedAt"),
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
