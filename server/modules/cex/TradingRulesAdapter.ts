import type { VenueInstrument } from "./Instrument";
import { createTradingRules, decimalStepFromPrecision, type TradingRules } from "./TradingRules";

export interface TradingRulesAdapter {
  getTradingRules(instrument: VenueInstrument): Promise<TradingRules>;
}

export interface PublicTradingRulesClient {
  get(path: string, query: Record<string, string>): Promise<unknown>;
}

export type OkxNativePerpetualExecutionRules = Readonly<{
  providerInstrumentId: string;
  instrumentState: "live";
  contractType: "linear";
  contractValueCurrency: string;
  settlementAsset: string;
  contractValue: string;
  lotSize: string;
  minimumSize: string;
}>;

export class HttpPublicTradingRulesClient implements PublicTradingRulesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async get(path: string, query: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const response = await this.fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Trading rules HTTP ${response.status}: ${response.statusText}.`);
    }
    return response.json();
  }
}

export class BinanceTradingRulesAdapter implements TradingRulesAdapter {
  constructor(private readonly client: PublicTradingRulesClient) {}

  async getTradingRules(instrument: VenueInstrument): Promise<TradingRules> {
    requireVenue(instrument, "binance");
    const path = instrument.category === "spot" ? "/api/v3/exchangeInfo" : "/fapi/v1/exchangeInfo";
    const payload = await this.client.get(path, { symbol: instrument.symbol });
    const row = firstSymbol(payload, instrument.symbol, "Binance");
    const filters = filtersByType(row.filters);
    const lot = record(filters.LOT_SIZE, "Binance LOT_SIZE filter");
    const price = record(filters.PRICE_FILTER, "Binance PRICE_FILTER filter");
    const notional = record(filters.NOTIONAL ?? filters.MIN_NOTIONAL ?? {}, "Binance notional filter");

    return createTradingRules({
      quantityStep: requiredString(lot.stepSize, "Binance quantity step"),
      minQuantity: requiredString(lot.minQty, "Binance min quantity"),
      priceTick: requiredString(price.tickSize, "Binance price tick"),
      minNotional: optionalString(notional.minNotional ?? notional.notional),
      precision: {
        quantity: optionalNumber(row.quantityPrecision ?? row.baseAssetPrecision),
        price: optionalNumber(row.pricePrecision ?? row.quotePrecision ?? row.quoteAssetPrecision),
      },
    });
  }
}

export class OkxTradingRulesAdapter implements TradingRulesAdapter {
  constructor(private readonly client: PublicTradingRulesClient) {}

  async getTradingRules(instrument: VenueInstrument): Promise<TradingRules> {
    requireVenue(instrument, "okx");
    return rulesForOkxRow(await this.loadRow(instrument));
  }

  async getPerpetualTradingRulesWithNativeFacts(instrument: VenueInstrument): Promise<Readonly<{
    tradingRules: TradingRules;
    nativeRules: OkxNativePerpetualExecutionRules;
  }>> {
    requireVenue(instrument, "okx");
    if (instrument.category !== "swap") {
      throw new Error("OKX native perpetual execution rules require a SWAP instrument.");
    }
    const row = await this.loadRow(instrument);
    try {
      const assets = okxSwapAssets(instrument.instId);
      const instrumentState = requiredString(row.state, "OKX instrument state");
      if (instrumentState !== "live") {
        throw new OkxInstrumentRulesError("instrument_not_tradable", "OKX instrument is not currently tradeable.");
      }
      if (requiredString(row.instType, "OKX instrument type") !== "SWAP"
        || requiredString(row.ctType, "OKX contract type") !== "linear"
        || requiredString(row.ctValCcy, "OKX contract value currency") !== assets.baseAsset
        || requiredString(row.settleCcy, "OKX settlement asset") !== assets.quoteAsset) {
        throw new OkxInstrumentRulesError("instrument_rules_invalid", "OKX native instrument rules do not match the canonical instrument.");
      }
      const tradingRules = rulesForOkxRow(row);
      if (tradingRules.contractSize === undefined) {
        throw new OkxInstrumentRulesError("instrument_rules_invalid", "OKX contract value is unavailable.");
      }
      return Object.freeze({
        tradingRules,
        nativeRules: Object.freeze({
          providerInstrumentId: instrument.instId,
          instrumentState: "live" as const,
          contractType: "linear" as const,
          contractValueCurrency: assets.baseAsset,
          settlementAsset: assets.quoteAsset,
          contractValue: tradingRules.contractSize,
          lotSize: tradingRules.quantityStep,
          minimumSize: tradingRules.minQuantity,
        }),
      });
    } catch (error) {
      if (error instanceof OkxInstrumentRulesError) throw error;
      throw new OkxInstrumentRulesError("instrument_rules_invalid", "OKX native instrument rules are incomplete or invalid.");
    }
  }

  private async loadRow(instrument: VenueInstrument) {
    let payload: unknown;
    try {
      payload = await this.client.get("/api/v5/public/instruments", {
        instType: instrument.category === "spot" ? "SPOT" : "SWAP",
        instId: instrument.instId,
      });
    } catch {
      throw new OkxInstrumentRulesError("instrument_rules_unavailable", "OKX instrument rules are temporarily unavailable.");
    }
    try {
      const value = record(payload, "OKX response");
      const data = array(value.data, "OKX data");
      const row = data.map((item) => record(item, "OKX instrument"))
        .find((item) => item.instId === instrument.instId);
      if (!row) {
        throw new OkxInstrumentRulesError("instrument_not_tradable", "OKX instrument is unavailable or not tradeable.");
      }
      return row;
    } catch (error) {
      if (error instanceof OkxInstrumentRulesError) throw error;
      throw new OkxInstrumentRulesError("instrument_rules_invalid", "OKX instrument rules response is invalid.");
    }
  }
}

export class OkxInstrumentRulesError extends Error {
  constructor(
    readonly category: "instrument_rules_unavailable" | "instrument_not_tradable" | "instrument_rules_invalid",
    message: string,
  ) {
    super(message);
    this.name = "OkxInstrumentRulesError";
  }
}

function rulesForOkxRow(row: Record<string, unknown>) {
  try {
    return createTradingRules({
      quantityStep: requiredString(row.lotSz, "OKX lot size"),
      minQuantity: requiredString(row.minSz, "OKX min size"),
      priceTick: requiredString(row.tickSz, "OKX price tick"),
      contractSize: optionalString(row.ctVal),
      precision: {},
    });
  } catch {
    throw new OkxInstrumentRulesError("instrument_rules_invalid", "OKX instrument quantity or price rules are invalid.");
  }
}

function okxSwapAssets(instId: string) {
  const match = /^([A-Z0-9]{2,12})-([A-Z0-9]{2,12})-SWAP$/u.exec(instId);
  if (!match) throw new OkxInstrumentRulesError("instrument_rules_invalid", "OKX SWAP instrument identity is invalid.");
  return Object.freeze({ baseAsset: match[1]!, quoteAsset: match[2]! });
}

export class BybitTradingRulesAdapter implements TradingRulesAdapter {
  constructor(private readonly client: PublicTradingRulesClient) {}

  async getTradingRules(instrument: VenueInstrument): Promise<TradingRules> {
    requireVenue(instrument, "bybit");
    const category = instrument.category === "spot" ? "spot" : "linear";
    const payload = await this.client.get("/v5/market/instruments-info", {
      category,
      symbol: instrument.symbol,
    });
    const row = firstListItem(payload, instrument.symbol, "Bybit");
    const lot = record(row.lotSizeFilter, "Bybit lot size filter");
    const price = record(row.priceFilter, "Bybit price filter");

    return createTradingRules({
      quantityStep: requiredString(lot.qtyStep ?? lot.basePrecision, "Bybit quantity step"),
      minQuantity: requiredString(lot.minOrderQty ?? lot.basePrecision, "Bybit min quantity"),
      priceTick: requiredString(price.tickSize, "Bybit price tick"),
      minNotional: optionalString(lot.minNotionalValue ?? lot.minOrderAmt),
      precision: {},
    });
  }
}

export class BitgetTradingRulesAdapter implements TradingRulesAdapter {
  constructor(private readonly client: PublicTradingRulesClient) {}

  async getTradingRules(instrument: VenueInstrument): Promise<TradingRules> {
    requireVenue(instrument, "bitget");
    const payload = await this.client.get("/api/v3/market/instruments", {
      category: instrument.category === "spot" ? "SPOT" : "USDT-FUTURES",
      symbol: instrument.symbol,
    });
    const row = firstDataItem(payload, instrument.symbol, "Bitget");

    return createTradingRules({
      quantityStep: optionalString(row.quantityMultiplier ?? row.quantityStep)
        ?? decimalStepFromPrecision(row.quantityPrecision, "Bitget quantity precision"),
      minQuantity: requiredString(row.minTradeAmount ?? row.minTradeNum ?? row.minOrderQty, "Bitget min quantity"),
      priceTick: optionalString(row.priceMultiplier ?? row.priceTick)
        ?? decimalStepFromPrecision(row.pricePrecision, "Bitget price precision"),
      minNotional: optionalString(row.minTradeUSDT ?? row.minNotional ?? row.minOrderAmount),
      contractSize: optionalString(row.contractSize),
      precision: {
        quantity: optionalNumber(row.quantityPrecision),
        price: optionalNumber(row.pricePrecision),
      },
    });
  }
}

function requireVenue(instrument: VenueInstrument, venue: VenueInstrument["venue"]) {
  if (instrument.venue !== venue) {
    throw new Error(`Expected ${venue} venue instrument.`);
  }
}

function firstSymbol(payload: unknown, symbol: string, venue: string) {
  const value = record(payload, `${venue} response`);
  const symbols = array(value.symbols, `${venue} symbols`);
  const row = symbols.map((item) => record(item, `${venue} symbol`))
    .find((item) => item.symbol === symbol);
  if (!row) throw new Error(`${venue} trading rules not found for ${symbol}.`);
  return row;
}

function firstDataItem(payload: unknown, id: string, venue: string) {
  const value = record(payload, `${venue} response`);
  const data = array(value.data, `${venue} data`);
  const row = data.map((item) => record(item, `${venue} instrument`))
    .find((item) => item.instId === id || item.symbol === id);
  if (!row) throw new Error(`${venue} trading rules not found for ${id}.`);
  return row;
}

function firstListItem(payload: unknown, symbol: string, venue: string) {
  const value = record(payload, `${venue} response`);
  const result = record(value.result, `${venue} result`);
  const list = array(result.list, `${venue} list`);
  const row = list.map((item) => record(item, `${venue} instrument`))
    .find((item) => item.symbol === symbol);
  if (!row) throw new Error(`${venue} trading rules not found for ${symbol}.`);
  return row;
}

function filtersByType(input: unknown) {
  const filters = array(input, "filters");
  return Object.fromEntries(filters.map((filter) => {
    const value = record(filter, "filter");
    return [String(value.filterType), value];
  }));
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is missing.`);
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown) {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}
