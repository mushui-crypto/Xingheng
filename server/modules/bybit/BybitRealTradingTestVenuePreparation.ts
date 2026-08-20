import { createAsset } from "../cex/Asset";
import { ExecutionQuantityPlanner, type ExecutionQuantityPlanningInstrument } from "../cex/ExecutionQuantityPlanner";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";
import { BybitTradingRulesAdapter, HttpPublicTradingRulesClient, type TradingRulesAdapter } from "../cex/TradingRulesAdapter";
import type {
  UnifiedRealTradingTestPreparation,
  UnifiedRealTradingTestPreparationRequest,
  UnifiedRealTradingTestVenuePreparation,
} from "../cex/UnifiedRealTradingTestCommand";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import { createBybitExecutionTickerSource, type BybitExecutionTickerSource } from "./BybitExecutionMarketData";

type CredentialSummaries = Pick<UserExchangeCredentialStore, "findSummary">;

export type BybitRealTradingTestVenuePreparationOptions = Readonly<{
  instrumentCapability?: InstrumentCapability;
  tradingRules?: Pick<TradingRulesAdapter, "getTradingRules">;
  tickerSource?: BybitExecutionTickerSource;
  now?: () => number;
}>;

export class BybitRealTradingTestVenuePreparation implements UnifiedRealTradingTestVenuePreparation {
  readonly venue = "bybit" as const;
  private readonly instruments: InstrumentCapability;
  private readonly tradingRules: Pick<TradingRulesAdapter, "getTradingRules">;
  private readonly tickerSource: BybitExecutionTickerSource;
  private readonly now: () => number;

  constructor(private readonly credentials: CredentialSummaries, options: BybitRealTradingTestVenuePreparationOptions = {}) {
    this.instruments = options.instrumentCapability ?? new InstrumentCapability();
    this.tradingRules = options.tradingRules
      ?? new BybitTradingRulesAdapter(new HttpPublicTradingRulesClient("https://api.bybit.com"));
    this.tickerSource = options.tickerSource ?? createBybitExecutionTickerSource();
    this.now = options.now ?? Date.now;
  }

  async prepare(request: UnifiedRealTradingTestPreparationRequest): Promise<UnifiedRealTradingTestPreparation> {
    if (request.venue !== "bybit") throw new Error(`Unsupported Bybit real trading test venue: ${request.venue}.`);
    const credential = this.credentials.findSummary(request.userId, "bybit");
    if (!credential) throw new Error("Bybit credential is not configured for the real trading test user.");
    if (credential.permissions.executionEnabled !== true) throw new Error("Bybit credential is not enabled for execution.");
    const canonical = canonicalInstrumentFromId(request.instrumentId);
    if (canonical.quoteAsset !== "USDT") throw new Error("Bybit real trading test supports USDT instruments only.");
    if (canonical.contractType === "spot" && request.reduceOnly) throw new Error("Bybit Spot real trading test does not support reduceOnly.");
    const venue = this.instruments.resolveVenueInstrument(canonical, "bybit");
    const category = canonical.contractType === "spot" ? "spot" as const : "linear" as const;
    const [rules, ticker] = await Promise.all([
      this.tradingRules.getTradingRules(venue),
      this.tickerSource(category, venue.symbol),
    ]);
    if (ticker.symbol !== venue.symbol || ticker.category !== category) throw new Error("Bybit real trading test ticker identity does not match the instrument.");
    const instrument = quantityInstrument(canonical, venue.symbol);
    const quantityPlan = await new ExecutionQuantityPlanner(
      { resolve: async (instrumentId) => instrumentId === canonical.instrumentId ? instrument : null },
      { getTradingRules: async () => rules },
      { now: this.now },
    ).plan({
      instrumentId: canonical.instrumentId,
      side: request.side,
      quantityInput: request.quantityInput,
      quote: { bid: ticker.bid, ask: ticker.ask, fetchedAt: ticker.fetchedAt },
    });
    if (!quantityPlan.ok) throw new Error(`Bybit real trading test quantity planning failed: ${quantityPlan.error.code}.`);
    return Object.freeze({ accountId: credential.accountId, quantityPlan: quantityPlan.plan });
  }
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
    quantityUnit: "base",
    status: "trading",
  });
}
