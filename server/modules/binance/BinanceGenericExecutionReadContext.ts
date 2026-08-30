import { tracedProviderFetch, tracedProviderJson } from "../cex/ProviderRequestTrace";
import type { CanonicalAssetSource } from "../cex/CanonicalAssetSource";
import type {
  ExecutionQuantityDecimalQuote,
  ExecutionQuantityPlanningInstrument,
} from "../cex/ExecutionQuantityPlanner";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import { createTradingRules, type TradingRules } from "../cex/TradingRules";

const BINANCE_SPOT_BASE_URL = "https://api.binance.com";
const BINANCE_USDM_BASE_URL = "https://fapi.binance.com";

export type BinanceExecutionMarket = "spot" | "usdm_perpetual";

export interface BinanceGenericExecutionReadClient {
  readExchangeInfo(market: BinanceExecutionMarket): Promise<unknown>;
  readBookTicker(market: BinanceExecutionMarket, providerSymbol: string): Promise<unknown>;
}

export type BinanceGenericPlanningInstrument = ExecutionQuantityPlanningInstrument & Readonly<{
  venue: "binance";
  contractSize: "1";
}>;

export type BinanceGenericExecutionContext = Readonly<{
  instrument: BinanceGenericPlanningInstrument;
  tradingRules: TradingRules;
  quote: ExecutionQuantityDecimalQuote;
}>;

export type BinanceGenericExecutionReadErrorCode =
  | "INSTRUMENT_ID_INVALID"
  | "INSTRUMENT_UNSUPPORTED"
  | "INSTRUMENT_NOT_FOUND"
  | "INSTRUMENT_NOT_TRADING"
  | "ASSET_MAPPING_UNAVAILABLE"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_REQUEST_FAILED";

export class BinanceGenericExecutionReadError extends Error {
  constructor(readonly code: BinanceGenericExecutionReadErrorCode, message: string) {
    super(message);
  }
}

export class HttpBinanceGenericExecutionReadClient implements BinanceGenericExecutionReadClient {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async readExchangeInfo(market: BinanceExecutionMarket) {
    return this.get(market, market === "spot" ? "/api/v3/exchangeInfo" : "/fapi/v1/exchangeInfo");
  }

  async readBookTicker(market: BinanceExecutionMarket, providerSymbol: string) {
    const symbol = providerSymbolValue(providerSymbol);
    return this.get(
      market,
      market === "spot" ? "/api/v3/ticker/bookTicker" : "/fapi/v1/ticker/bookTicker",
      { symbol },
    );
  }

  private async get(
    market: BinanceExecutionMarket,
    path: string,
    query: Readonly<Record<string, string>> = {},
  ) {
    const url = new URL(path, market === "spot" ? BINANCE_SPOT_BASE_URL : BINANCE_USDM_BASE_URL);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await tracedProviderFetch("binance", this.fetchFn)(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new BinanceGenericExecutionReadError("PROVIDER_REQUEST_FAILED", "Binance public read failed.");
    }
    if (!response.ok) {
      throw new BinanceGenericExecutionReadError(
        "PROVIDER_REQUEST_FAILED",
        `Binance public read failed with HTTP ${response.status}.`,
      );
    }
    try {
      return await tracedProviderJson(response);
    } catch {
      throw new BinanceGenericExecutionReadError("PROVIDER_RESPONSE_INVALID", "Binance returned invalid JSON.");
    }
  }
}

export class BinanceGenericExecutionReadContextService {
  constructor(
    private readonly client: BinanceGenericExecutionReadClient,
    private readonly assets: CanonicalAssetSource,
    private readonly now: () => number = Date.now,
  ) {}

  async load(instrumentId: string): Promise<BinanceGenericExecutionContext> {
    const canonical = parseSupportedInstrumentId(instrumentId);
    const market: BinanceExecutionMarket = canonical.contractType === "spot" ? "spot" : "usdm_perpetual";
    const exchangeInfo = await this.client.readExchangeInfo(market);
    const row = resolveAuthoritativeInstrument(exchangeInfo, canonical, market);
    const status = instrumentStatus(row, market);
    if (status !== "trading") {
      throw new BinanceGenericExecutionReadError("INSTRUMENT_NOT_TRADING", "Binance instrument is not trading.");
    }

    const baseAsset = this.assets.getAsset(canonical.baseAsset);
    if (!baseAsset || baseAsset.symbol !== canonical.baseAsset) {
      throw new BinanceGenericExecutionReadError(
        "ASSET_MAPPING_UNAVAILABLE",
        `Canonical asset mapping is unavailable for ${canonical.baseAsset}.`,
      );
    }

    const providerSymbol = providerSymbolValue(row.symbol);
    const tradingRules = rulesFromExchangeInfo(row, market);
    const quote = quoteFromBookTicker(
      await this.client.readBookTicker(market, providerSymbol),
      providerSymbol,
      this.now(),
    );
    const instrument: BinanceGenericPlanningInstrument = Object.freeze({
      instrumentId: canonical.instrumentId,
      venue: "binance",
      providerSymbol,
      baseAsset,
      quoteAsset: "USDT",
      ...(market === "usdm_perpetual" ? { settlementAsset: "USDT" } : {}),
      marketType: market === "spot" ? "spot" : "perpetual",
      contractType: market === "spot" ? "spot" : "linear_perpetual",
      quantityUnit: "base",
      contractSize: "1",
      status,
    });

    return Object.freeze({ instrument, tradingRules, quote });
  }
}

function parseSupportedInstrumentId(instrumentId: string) {
  let canonical: ReturnType<typeof canonicalInstrumentFromId>;
  try {
    canonical = canonicalInstrumentFromId(instrumentId);
  } catch {
    throw new BinanceGenericExecutionReadError("INSTRUMENT_ID_INVALID", "Canonical instrument id is invalid.");
  }
  if (canonical.quoteAsset !== "USDT") {
    throw new BinanceGenericExecutionReadError(
      "INSTRUMENT_UNSUPPORTED",
      "Binance generic execution read context supports only USDT instruments.",
    );
  }
  return canonical;
}

function resolveAuthoritativeInstrument(
  payload: unknown,
  canonical: ReturnType<typeof canonicalInstrumentFromId>,
  market: BinanceExecutionMarket,
) {
  const root = record(payload, "Binance exchangeInfo");
  const symbols = array(root.symbols, "Binance exchangeInfo symbols");
  const candidates = symbols.map((value) => record(value, "Binance exchangeInfo symbol"));
  const row = candidates.find((candidate) => candidate.baseAsset === canonical.baseAsset
    && candidate.quoteAsset === canonical.quoteAsset
    && (market === "spot"
      ? candidate.contractType === undefined
      : candidate.contractType === "PERPETUAL" && candidate.marginAsset === "USDT"));
  if (!row) {
    throw new BinanceGenericExecutionReadError("INSTRUMENT_NOT_FOUND", "Binance instrument was not found.");
  }
  return row;
}

function instrumentStatus(row: Record<string, unknown>, market: BinanceExecutionMarket) {
  const enabled = market === "spot" ? row.isSpotTradingAllowed !== false : row.contractType === "PERPETUAL";
  return row.status === "TRADING" && enabled ? "trading" as const : "paused" as const;
}

function rulesFromExchangeInfo(row: Record<string, unknown>, market: BinanceExecutionMarket) {
  const filters = filtersByType(row.filters);
  const lot = record(filters.LOT_SIZE, "Binance LOT_SIZE filter");
  const price = record(filters.PRICE_FILTER, "Binance PRICE_FILTER filter");
  const notional = record(filters.NOTIONAL ?? filters.MIN_NOTIONAL ?? {}, "Binance notional filter");
  return createTradingRules({
    quantityStep: decimalString(lot.stepSize, "Binance quantityStep"),
    minQuantity: decimalString(lot.minQty, "Binance minQuantity"),
    priceTick: decimalString(price.tickSize, "Binance priceTick"),
    ...(notional.minNotional === undefined && notional.notional === undefined
      ? {}
      : { minNotional: decimalString(notional.minNotional ?? notional.notional, "Binance minNotional") }),
    precision: {
      ...(precision(row[market === "spot" ? "baseAssetPrecision" : "quantityPrecision"]) === undefined
        ? {}
        : { quantity: precision(row[market === "spot" ? "baseAssetPrecision" : "quantityPrecision"]) }),
      ...(precision(row[market === "spot" ? "quotePrecision" : "pricePrecision"]) === undefined
        ? {}
        : { price: precision(row[market === "spot" ? "quotePrecision" : "pricePrecision"]) }),
    },
  });
}

function quoteFromBookTicker(
  payload: unknown,
  expectedSymbol: string,
  fetchedAt: number,
): ExecutionQuantityDecimalQuote {
  const row = record(payload, "Binance book ticker");
  if (row.symbol !== expectedSymbol || !Number.isSafeInteger(fetchedAt) || fetchedAt < 0) {
    throw new BinanceGenericExecutionReadError("PROVIDER_RESPONSE_INVALID", "Binance book ticker identity is invalid.");
  }
  return Object.freeze({
    bid: decimalString(row.bidPrice, "Binance bidPrice"),
    ask: decimalString(row.askPrice, "Binance askPrice"),
    fetchedAt,
  });
}

function decimalString(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new BinanceGenericExecutionReadError("PROVIDER_RESPONSE_INVALID", `${name} is invalid.`);
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  const normalized = normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
  if (normalized === "0") {
    throw new BinanceGenericExecutionReadError("PROVIDER_RESPONSE_INVALID", `${name} must be positive.`);
  }
  return normalized;
}

function providerSymbolValue(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z0-9]{4,30}$/u.test(value)) {
    throw new BinanceGenericExecutionReadError("PROVIDER_RESPONSE_INVALID", "Binance provider symbol is invalid.");
  }
  return value;
}

function precision(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 30) return value;
  return undefined;
}

function filtersByType(value: unknown) {
  return Object.fromEntries(array(value, "Binance filters").map((filter) => {
    const item = record(filter, "Binance filter");
    return [String(item.filterType ?? ""), item];
  })) as Record<string, Record<string, unknown>>;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BinanceGenericExecutionReadError("PROVIDER_RESPONSE_INVALID", `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new BinanceGenericExecutionReadError("PROVIDER_RESPONSE_INVALID", `${name} must be an array.`);
  }
  return value;
}
