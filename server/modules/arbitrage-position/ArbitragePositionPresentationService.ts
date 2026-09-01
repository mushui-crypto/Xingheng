import type { ArbitrageMarket } from "../arbitrage/arbitrageTypes";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import { activeManagedQuantity } from "../cex/arbitrage-instance/ArbitrageInstance";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";

const DEFAULT_MARKET_MAX_AGE_MS = 20_000;

export type ArbitragePositionPresentation = Readonly<{
  arbitrageId: string;
  market: Readonly<{
    fundingRate: number | null;
    fundingIntervalHours: number | null;
    nextFundingTime: number | null;
    nextEstimatedFundingFee: string | null;
    nextEstimatedFundingFeeAsset: string | null;
    spreadQuotePerBase: number | null;
    spreadBps: number | null;
    quotedAt: number | null;
    marketDataAsOf: number | null;
    completeness: "COMPLETE" | "INCOMPLETE";
  }>;
  revenue: Readonly<{
    cumulativeFundingIncome: null;
    incurredFees: null;
    estimatedExitFees: null;
    currentArbitrageNetProfit: null;
    completeness: "INCOMPLETE";
  }>;
}>;

export type PositionMarketSnapshotSource = Readonly<{
  getCurrentMarketSnapshot(): Promise<Readonly<{ generatedAt: number; markets: readonly ArbitrageMarket[] }>>;
}>;

export class ArbitragePositionPresentationService {
  private readonly instruments = new InstrumentCapability();

  constructor(
    private readonly marketSource: PositionMarketSnapshotSource,
    private readonly now: () => number = Date.now,
    private readonly marketMaxAgeMs = DEFAULT_MARKET_MAX_AGE_MS,
  ) {}

  async present(instances: readonly ArbitrageInstance[]) {
    const snapshot = await this.marketSource.getCurrentMarketSnapshot();
    return Object.freeze(instances.map((instance) => {
      try {
        return this.presentInstance(instance, snapshot.markets);
      } catch {
        return incomplete(instance.arbitrageId);
      }
    }));
  }

  private presentInstance(instance: ArbitrageInstance, markets: readonly ArbitrageMarket[]): ArbitragePositionPresentation {
    const mapped = instance.legs.map((leg) => {
      const canonical = canonicalInstrumentFromId(leg.instrumentId);
      const venueInstrument = this.instruments.resolveVenueInstrument(canonical, leg.venue);
      const market = markets.find((candidate) => candidate.venue === leg.venue
        && candidate.symbol === venueInstrument.symbol
        && candidate.kind === canonical.contractType);
      return { leg, canonical, market };
    });
    const now = this.now();
    const completeMarkets = mapped.every(({ market }) => market
      && market.status !== "disconnected"
      && market.bid !== null
      && market.ask !== null
      && now - market.fetchedAt <= this.marketMaxAgeMs);
    const perpetuals = mapped.filter(({ canonical }) => canonical.contractType === "perpetual");
    const completeFunding = perpetuals.length > 0 && perpetuals.every(({ market }) => market
      && market.fundingRate !== null
      && market.fundingIntervalHours !== null
      && market.nextFundingTime !== null
      && market.markPrice !== null);
    if (!completeMarkets || !completeFunding) return incomplete(instance.arbitrageId);

    const long = mapped.find(({ leg }) => leg.role === "LONG")!;
    const short = mapped.find(({ leg }) => leg.role === "SHORT")!;
    const longBid = long.market!.bid!;
    const shortAsk = short.market!.ask!;
    const spreadQuotePerBase = shortAsk - longBid;
    const midpoint = (shortAsk + longBid) / 2;
    const fundingRate = perpetuals.reduce((total, { leg, market }) =>
      total + (leg.role === "SHORT" ? market!.fundingRate! : -market!.fundingRate!), 0);
    const fundingIntervals = new Set(perpetuals.map(({ market }) => market!.fundingIntervalHours!));
    const nextFundingTime = Math.min(...perpetuals.map(({ market }) => market!.nextFundingTime!));
    const nextEstimatedFundingFee = perpetuals.reduce((total, { leg, market }) => {
      const direction = leg.role === "SHORT" ? 1 : -1;
      return total + direction * Number(activeManagedQuantity(instance, leg)) * market!.markPrice! * market!.fundingRate!;
    }, 0);
    const quotedAt = Math.min(...mapped.map(({ market }) => market!.fetchedAt));
    const quoteAssets = new Set(mapped.map(({ canonical }) => canonical.quoteAsset));

    return Object.freeze({
      arbitrageId: instance.arbitrageId,
      market: Object.freeze({
        fundingRate,
        fundingIntervalHours: fundingIntervals.size === 1 ? [...fundingIntervals][0]! : null,
        nextFundingTime,
        nextEstimatedFundingFee: displayDecimal(nextEstimatedFundingFee),
        nextEstimatedFundingFeeAsset: quoteAssets.size === 1 ? [...quoteAssets][0]! : null,
        spreadQuotePerBase,
        spreadBps: midpoint > 0 ? spreadQuotePerBase / midpoint * 10_000 : null,
        quotedAt,
        marketDataAsOf: quotedAt,
        completeness: "COMPLETE" as const,
      }),
      revenue: incompleteRevenue(),
    });
  }
}

function incomplete(arbitrageId: string): ArbitragePositionPresentation {
  return Object.freeze({
    arbitrageId,
    market: Object.freeze({
      fundingRate: null,
      fundingIntervalHours: null,
      nextFundingTime: null,
      nextEstimatedFundingFee: null,
      nextEstimatedFundingFeeAsset: null,
      spreadQuotePerBase: null,
      spreadBps: null,
      quotedAt: null,
      marketDataAsOf: null,
      completeness: "INCOMPLETE" as const,
    }),
    revenue: incompleteRevenue(),
  });
}

function incompleteRevenue() {
  return Object.freeze({
    cumulativeFundingIncome: null,
    incurredFees: null,
    estimatedExitFees: null,
    currentArbitrageNetProfit: null,
    completeness: "INCOMPLETE" as const,
  });
}

function displayDecimal(value: number) {
  if (!Number.isFinite(value)) return null;
  const normalized = value.toFixed(12)
    .replace(/(\.\d*?[1-9])0+$/u, "$1")
    .replace(/\.0+$/u, "");
  return normalized === "-0" ? "0" : normalized;
}
