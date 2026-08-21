import { createExecutionCanonicalAssetSource, type CanonicalAssetSource } from "../cex/CanonicalAssetSource";
import type {
  ExecutionQuantityDecimalQuote,
  ExecutionQuantityPlanningInstrument,
} from "../cex/ExecutionQuantityPlanner";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";
import {
  BitgetTradingRulesAdapter,
  BybitTradingRulesAdapter,
  HttpPublicTradingRulesClient,
  OkxTradingRulesAdapter,
} from "../cex/TradingRulesAdapter";
import type { TradingRules } from "../cex/TradingRules";
import {
  BinanceGenericExecutionReadContextService,
  HttpBinanceGenericExecutionReadClient,
} from "../binance/BinanceGenericExecutionReadContext";
import type { ArbitrageExecutionDraftVenue } from "./ArbitrageExecutionDraft";

export type ArbitrageExecutionPlanningContext = Readonly<{
  instrument: ExecutionQuantityPlanningInstrument;
  tradingRules: TradingRules;
  quote: ExecutionQuantityDecimalQuote;
}>;

export interface ArbitrageExecutionPlanningContextSource {
  load(venue: ArbitrageExecutionDraftVenue, instrumentId: string): Promise<ArbitrageExecutionPlanningContext>;
}

const BASE_URLS = Object.freeze({
  okx: "https://www.okx.com",
  bybit: "https://api.bybit.com",
  bitget: "https://api.bitget.com",
});

export class DefaultArbitrageExecutionPlanningContextSource
implements ArbitrageExecutionPlanningContextSource {
  private readonly binance;
  private readonly instruments = new InstrumentCapability();

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly assets: CanonicalAssetSource = createExecutionCanonicalAssetSource(),
    private readonly now: () => number = Date.now,
  ) {
    this.binance = new BinanceGenericExecutionReadContextService(
      new HttpBinanceGenericExecutionReadClient(fetchFn),
      assets,
      now,
    );
  }

  async load(venue: ArbitrageExecutionDraftVenue, instrumentId: string) {
    if (venue === "binance") return this.binance.load(instrumentId);

    const canonical = canonicalInstrumentFromId(instrumentId);
    if (canonical.quoteAsset !== "USDT") throw new Error("Only USDT instruments are supported.");
    const asset = this.assets.getAsset(canonical.baseAsset);
    if (!asset) throw new Error("Canonical asset mapping is unavailable.");
    const venueInstrument = this.instruments.resolveVenueInstrument(canonical, venue);
    const client = new HttpPublicTradingRulesClient(BASE_URLS[venue], this.fetchFn);
    const tradingRules = await rulesAdapter(venue, client).getTradingRules(venueInstrument);
    const quote = await readDecimalQuote(venue, venueInstrument.symbol, venueInstrument.category, this.fetchFn, this.now);
    const instrument: ExecutionQuantityPlanningInstrument = Object.freeze({
      instrumentId: canonical.instrumentId,
      providerSymbol: venueInstrument.symbol,
      baseAsset: asset,
      quoteAsset: canonical.quoteAsset,
      ...(canonical.contractType === "perpetual" ? { settlementAsset: "USDT" } : {}),
      marketType: canonical.contractType,
      contractType: canonical.contractType === "spot" ? "spot" : "linear_perpetual",
      quantityUnit: venue === "okx" && canonical.contractType === "perpetual" ? "contract" : "base",
      status: "trading",
    });
    return Object.freeze({ instrument, tradingRules, quote });
  }
}

function rulesAdapter(
  venue: Exclude<ArbitrageExecutionDraftVenue, "binance">,
  client: HttpPublicTradingRulesClient,
) {
  if (venue === "okx") return new OkxTradingRulesAdapter(client);
  if (venue === "bybit") return new BybitTradingRulesAdapter(client);
  return new BitgetTradingRulesAdapter(client);
}

async function readDecimalQuote(
  venue: Exclude<ArbitrageExecutionDraftVenue, "binance">,
  symbol: string,
  category: "spot" | "linear" | "swap",
  fetchFn: typeof fetch,
  now: () => number,
): Promise<ExecutionQuantityDecimalQuote> {
  const request = quoteRequest(venue, symbol, category);
  const response = await fetchFn(request.url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Venue quote request failed.");
  const payload = await response.json();
  const values = quoteValues(venue, payload, symbol);
  const fetchedAt = now();
  if (!Number.isSafeInteger(fetchedAt) || fetchedAt < 0) throw new Error("Quote timestamp is invalid.");
  return Object.freeze({ bid: decimal(values.bid), ask: decimal(values.ask), fetchedAt });
}

function quoteRequest(
  venue: Exclude<ArbitrageExecutionDraftVenue, "binance">,
  symbol: string,
  category: "spot" | "linear" | "swap",
) {
  if (venue === "okx") {
    const url = new URL("/api/v5/market/ticker", BASE_URLS.okx);
    url.searchParams.set("instId", symbol);
    return { url };
  }
  if (venue === "bybit") {
    const url = new URL("/v5/market/tickers", BASE_URLS.bybit);
    url.searchParams.set("category", category === "spot" ? "spot" : "linear");
    url.searchParams.set("symbol", symbol);
    return { url };
  }
  const url = new URL("/api/v3/market/tickers", BASE_URLS.bitget);
  url.searchParams.set("category", category === "spot" ? "SPOT" : "USDT-FUTURES");
  url.searchParams.set("symbol", symbol);
  return { url };
}

function quoteValues(
  venue: Exclude<ArbitrageExecutionDraftVenue, "binance">,
  payload: unknown,
  symbol: string,
) {
  const root = record(payload);
  if (venue === "okx") {
    if (root.code !== undefined && root.code !== "0") throw new Error("OKX quote was rejected.");
    const row = first(root.data);
    if (row.instId !== symbol) throw new Error("OKX quote identity is invalid.");
    return { bid: row.bidPx, ask: row.askPx };
  }
  if (venue === "bybit") {
    if (root.retCode !== undefined && root.retCode !== 0) throw new Error("Bybit quote was rejected.");
    const row = first(record(root.result).list);
    if (row.symbol !== symbol) throw new Error("Bybit quote identity is invalid.");
    return { bid: row.bid1Price, ask: row.ask1Price };
  }
  if (root.code !== undefined && root.code !== "00000") throw new Error("Bitget quote was rejected.");
  const row = first(root.data);
  if (row.symbol !== symbol) throw new Error("Bitget quote identity is invalid.");
  return { bid: row.bid1Price, ask: row.ask1Price };
}

function first(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Venue quote is empty.");
  return record(value[0]);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Venue response is invalid.");
  return value as Record<string, unknown>;
}

function decimal(value: unknown) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Venue quote is not a Decimal string.");
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  const normalized = normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
  if (normalized === "0") throw new Error("Venue quote must be positive.");
  return normalized;
}
