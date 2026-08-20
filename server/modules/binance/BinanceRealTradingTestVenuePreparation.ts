import { createAsset } from "../cex/Asset";
import {
  ExecutionQuantityPlanner,
  type ExecutionQuantityPlanningInstrument,
} from "../cex/ExecutionQuantityPlanner";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";
import {
  BinanceTradingRulesAdapter,
  HttpPublicTradingRulesClient,
  type TradingRulesAdapter,
} from "../cex/TradingRulesAdapter";
import type {
  UnifiedRealTradingTestPreparation,
  UnifiedRealTradingTestPreparationRequest,
  UnifiedRealTradingTestVenuePreparation,
} from "../cex/UnifiedRealTradingTestCommand";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";

type CredentialSummaries = Pick<UserExchangeCredentialStore, "findSummary">;

export type BinanceBookTicker = Readonly<{
  symbol: string;
  bidPrice: string;
  askPrice: string;
}>;

export type BinanceTickerSource = (
  symbol: string,
  market: "spot" | "perpetual",
) => Promise<{ ticker: BinanceBookTicker; fetchedAt: number }>;

export type BinanceRealTradingTestVenuePreparationOptions = Readonly<{
  instrumentCapability?: InstrumentCapability;
  tradingRules?: Pick<TradingRulesAdapter, "getTradingRules">;
  tickerSource?: BinanceTickerSource;
  now?: () => number;
}>;

export class BinanceRealTradingTestVenuePreparation implements UnifiedRealTradingTestVenuePreparation {
  readonly venue = "binance" as const;
  private readonly instruments: InstrumentCapability;
  private readonly tradingRules: Pick<TradingRulesAdapter, "getTradingRules">;
  private readonly tickerSource: BinanceTickerSource;
  private readonly now: () => number;

  constructor(
    private readonly credentials: CredentialSummaries,
    options: BinanceRealTradingTestVenuePreparationOptions = {},
  ) {
    this.instruments = options.instrumentCapability ?? new InstrumentCapability();
    this.tradingRules = options.tradingRules
      ?? new BinanceTradingRulesAdapter(new HttpPublicTradingRulesClient("https://api.binance.com"));
    this.tickerSource = options.tickerSource ?? createBinanceTickerSource();
    this.now = options.now ?? Date.now;
  }

  async prepare(
    request: UnifiedRealTradingTestPreparationRequest,
  ): Promise<UnifiedRealTradingTestPreparation> {
    if (request.venue !== "binance") throw new Error(`Unsupported Binance real trading test venue: ${request.venue}.`);
    const credential = this.credentials.findSummary(request.userId, "binance");
    if (!credential) throw new Error("Binance credential is not configured for the real trading test user.");
    if (credential.permissions.executionEnabled !== true) {
      throw new Error("Binance credential is not enabled for execution.");
    }

    const canonical = canonicalInstrumentFromId(request.instrumentId);
    const venueInstrument = this.instruments.resolveVenueInstrument(canonical, "binance");
    const [rules, ticker] = await Promise.all([
      this.tradingRules.getTradingRules(venueInstrument),
      this.tickerSource(venueInstrument.symbol, canonical.contractType),
    ]);
    if (ticker.ticker.symbol !== venueInstrument.symbol) {
      throw new Error("Binance real trading test ticker identity does not match the instrument.");
    }
    const planningInstrument = quantityInstrument(canonical, venueInstrument.symbol);
    const quantityPlan = await new ExecutionQuantityPlanner(
      { resolve: async (instrumentId) => instrumentId === canonical.instrumentId ? planningInstrument : null },
      { getTradingRules: async () => rules },
      { now: this.now },
    ).plan({
      instrumentId: canonical.instrumentId,
      side: request.side,
      quantityInput: request.quantityInput,
      quote: {
        bid: ticker.ticker.bidPrice,
        ask: ticker.ticker.askPrice,
        fetchedAt: ticker.fetchedAt,
      },
    });
    if (!quantityPlan.ok) {
      throw new Error(`Binance real trading test quantity planning failed: ${quantityPlan.error.code}.`);
    }
    return Object.freeze({ accountId: credential.accountId, quantityPlan: quantityPlan.plan });
  }
}

export function createBinanceTickerSource(options: Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}> = {}): BinanceTickerSource {
  const baseUrl = options.baseUrl ?? "https://api.binance.com";
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (symbol, market) => {
    const url = new URL(market === "spot" ? "/api/v3/ticker/bookTicker" : "/fapi/v1/ticker/bookTicker", baseUrl);
    url.searchParams.set("symbol", symbol);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Binance ticker request failed: ${response.status}.`);
    const payload = await response.json() as Partial<BinanceBookTicker>;
    if (payload.symbol !== symbol || typeof payload.bidPrice !== "string" || typeof payload.askPrice !== "string") {
      throw new Error("Binance ticker response identity is invalid.");
    }
    return { ticker: Object.freeze({ symbol, bidPrice: payload.bidPrice, askPrice: payload.askPrice }), fetchedAt: Date.now() };
  };
}

function quantityInstrument(
  canonical: ReturnType<typeof canonicalInstrumentFromId>,
  providerSymbol: string,
): ExecutionQuantityPlanningInstrument {
  return Object.freeze({
    instrumentId: canonical.instrumentId,
    providerSymbol,
    baseAsset: createAsset({ symbol: canonical.baseAsset, type: "DIGITAL_ASSET" }),
    quoteAsset: canonical.quoteAsset,
    ...(canonical.contractType === "perpetual" ? { settlementAsset: canonical.quoteAsset } : {}),
    marketType: canonical.contractType === "spot" ? "spot" : "perpetual",
    contractType: canonical.contractType === "spot" ? "spot" : "linear_perpetual",
    // Binance USDⓈ-M quantity is expressed in base-asset units for both Spot
    // and linear perpetual orders; contractSize conversion belongs to venues
    // whose Provider API uses contract counts (for example OKX SWAP).
    quantityUnit: "base",
    status: "trading",
  });
}
