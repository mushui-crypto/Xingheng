import { createAsset } from "../cex/Asset";
import { ExecutionQuantityPlanner, type ExecutionQuantityPlanningInstrument } from "../cex/ExecutionQuantityPlanner";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";
import { BitgetTradingRulesAdapter, HttpPublicTradingRulesClient, type TradingRulesAdapter } from "../cex/TradingRulesAdapter";
import type {
  UnifiedRealTradingTestPreparation,
  UnifiedRealTradingTestPreparationRequest,
  UnifiedRealTradingTestVenuePreparation,
} from "../cex/UnifiedRealTradingTestCommand";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import { createBitgetExecutionTickerSource, type BitgetExecutionTickerSource } from "./BitgetExecutionMarketData";

type CredentialSummaries = Pick<UserExchangeCredentialStore, "findSummary">;
export type BitgetRealTradingTestVenuePreparationOptions = Readonly<{
  instrumentCapability?: InstrumentCapability;
  tradingRules?: Pick<TradingRulesAdapter, "getTradingRules">;
  tickerSource?: BitgetExecutionTickerSource;
  now?: () => number;
}>;

export class BitgetRealTradingTestVenuePreparation implements UnifiedRealTradingTestVenuePreparation {
  readonly venue = "bitget" as const;
  private readonly instruments: InstrumentCapability;
  private readonly tradingRules: Pick<TradingRulesAdapter, "getTradingRules">;
  private readonly tickerSource: BitgetExecutionTickerSource;
  private readonly now: () => number;

  constructor(private readonly credentials: CredentialSummaries, options: BitgetRealTradingTestVenuePreparationOptions = {}) {
    this.instruments = options.instrumentCapability ?? new InstrumentCapability();
    this.tradingRules = options.tradingRules
      ?? new BitgetTradingRulesAdapter(new HttpPublicTradingRulesClient("https://api.bitget.com"));
    this.tickerSource = options.tickerSource ?? createBitgetExecutionTickerSource();
    this.now = options.now ?? Date.now;
  }

  async prepare(request: UnifiedRealTradingTestPreparationRequest): Promise<UnifiedRealTradingTestPreparation> {
    if (request.venue !== "bitget") throw new Error(`Unsupported Bitget real trading test venue: ${request.venue}.`);
    const credential = this.credentials.findSummary(request.userId, "bitget");
    if (!credential) throw new Error("Bitget credential is not configured for the real trading test user.");
    if (credential.permissions.executionEnabled !== true || credential.permissions.providerVerified !== true
      || credential.permissions.positionModeSupported !== true) {
      throw new Error("Bitget credential is not enabled for one-way execution.");
    }
    const canonical = canonicalInstrumentFromId(request.instrumentId);
    if (canonical.quoteAsset !== "USDT") throw new Error("Bitget real trading test supports USDT instruments only.");
    if (canonical.contractType === "spot" && request.reduceOnly) throw new Error("Bitget Spot real trading test does not support reduceOnly.");
    const venue = this.instruments.resolveVenueInstrument(canonical, "bitget");
    const category = canonical.contractType === "spot" ? "SPOT" as const : "USDT-FUTURES" as const;
    const [rules, ticker] = await Promise.all([
      this.tradingRules.getTradingRules(venue), this.tickerSource(category, venue.symbol),
    ]);
    if (ticker.category !== category || ticker.symbol !== venue.symbol) {
      throw new Error("Bitget real trading test ticker identity does not match the instrument.");
    }
    const instrument = quantityInstrument(canonical, venue.symbol);
    const quantityPlan = await new ExecutionQuantityPlanner(
      { resolve: async (instrumentId) => instrumentId === canonical.instrumentId ? instrument : null },
      { getTradingRules: async () => rules },
      { now: this.now },
    ).plan({ instrumentId: canonical.instrumentId, side: request.side, quantityInput: request.quantityInput,
      quote: { bid: ticker.bid, ask: ticker.ask, fetchedAt: ticker.fetchedAt } });
    if (!quantityPlan.ok) throw new Error(`Bitget real trading test quantity planning failed: ${quantityPlan.error.code}.`);
    return Object.freeze({ accountId: credential.accountId, quantityPlan: quantityPlan.plan });
  }
}

function quantityInstrument(canonical: ReturnType<typeof canonicalInstrumentFromId>, providerSymbol: string): ExecutionQuantityPlanningInstrument {
  return Object.freeze({ instrumentId: canonical.instrumentId, providerSymbol,
    baseAsset: createAsset({ symbol: canonical.baseAsset, type: "DIGITAL_ASSET" }), quoteAsset: canonical.quoteAsset,
    ...(canonical.contractType === "perpetual" ? { settlementAsset: canonical.quoteAsset } : {}),
    marketType: canonical.contractType === "spot" ? "spot" : "perpetual",
    contractType: canonical.contractType === "spot" ? "spot" : "linear_perpetual",
    quantityUnit: "base", status: "trading" });
}
