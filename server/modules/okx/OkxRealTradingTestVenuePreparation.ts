import { createAsset } from "../cex/Asset";
import {
  ExecutionQuantityPlanner,
  type ExecutionQuantityPlanningInstrument,
} from "../cex/ExecutionQuantityPlanner";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";
import {
  HttpPublicTradingRulesClient,
  OkxTradingRulesAdapter,
  type TradingRulesAdapter,
} from "../cex/TradingRulesAdapter";
import type {
  UnifiedRealTradingTestPreparation,
  UnifiedRealTradingTestPreparationRequest,
  UnifiedRealTradingTestVenuePreparation,
} from "../cex/UnifiedRealTradingTestCommand";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import { createOkxTickerSource, type OkxTickerSource } from "./OkxMarketData";

type CredentialSummaries = Pick<UserExchangeCredentialStore, "findSummary">;

export type OkxRealTradingTestVenuePreparationOptions = Readonly<{
  instrumentCapability?: InstrumentCapability;
  tradingRules?: Pick<TradingRulesAdapter, "getTradingRules">;
  tickerSource?: OkxTickerSource;
  now?: () => number;
}>;

export class OkxRealTradingTestVenuePreparation implements UnifiedRealTradingTestVenuePreparation {
  readonly venue = "okx" as const;
  private readonly instruments: InstrumentCapability;
  private readonly tradingRules: Pick<TradingRulesAdapter, "getTradingRules">;
  private readonly tickerSource: OkxTickerSource;
  private readonly now: () => number;

  constructor(
    private readonly credentials: CredentialSummaries,
    options: OkxRealTradingTestVenuePreparationOptions = {},
  ) {
    this.instruments = options.instrumentCapability ?? new InstrumentCapability();
    this.tradingRules = options.tradingRules
      ?? new OkxTradingRulesAdapter(new HttpPublicTradingRulesClient("https://www.okx.com"));
    this.tickerSource = options.tickerSource ?? createOkxTickerSource();
    this.now = options.now ?? Date.now;
  }

  async prepare(
    request: UnifiedRealTradingTestPreparationRequest,
  ): Promise<UnifiedRealTradingTestPreparation> {
    if (request.venue !== "okx") throw new Error(`Unsupported OKX real trading test venue: ${request.venue}.`);
    const credential = this.credentials.findSummary(request.userId, "okx");
    if (!credential) throw new Error("OKX credential is not configured for the real trading test user.");
    if (credential.permissions.executionEnabled !== true) {
      throw new Error("OKX credential is not enabled for execution.");
    }

    const canonical = canonicalInstrumentFromId(request.instrumentId);
    if (canonical.contractType === "spot" && request.reduceOnly) {
      throw new Error("OKX Spot real trading test does not support reduceOnly.");
    }
    if (canonical.contractType === "spot" && request.executionMode === "PRICE_PRIORITY") {
      throw new Error("OKX Spot real trading test supports EXECUTION_PRIORITY only.");
    }
    const venueInstrument = this.instruments.resolveVenueInstrument(canonical, "okx");
    const [rules, ticker] = await Promise.all([
      this.tradingRules.getTradingRules(venueInstrument),
      this.tickerSource(venueInstrument.instId),
    ]);
    if (ticker.ticker.instId !== venueInstrument.instId) {
      throw new Error("OKX real trading test ticker identity does not match the instrument.");
    }
    const planningInstrument = quantityInstrument(canonical, venueInstrument.instId);
    const quantityPlan = await new ExecutionQuantityPlanner(
      { resolve: async (instrumentId) => instrumentId === canonical.instrumentId ? planningInstrument : null },
      { getTradingRules: async () => rules },
      { now: this.now },
    ).plan({
      instrumentId: canonical.instrumentId,
      side: request.side,
      quantityInput: request.quantityInput,
      quote: {
        bid: ticker.ticker.bidPx,
        ask: ticker.ticker.askPx,
        fetchedAt: ticker.fetchedAt,
      },
    });
    if (!quantityPlan.ok) {
      throw new Error(`OKX real trading test quantity planning failed: ${quantityPlan.error.code}.`);
    }
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
    quantityUnit: canonical.contractType === "spot" ? "base" : "contract",
    status: "trading",
  });
}
