import type { ArbitrageMarket } from "../arbitrage/arbitrageTypes";
import type { ArbitrageInstance, ArbitrageInstanceLeg } from "../cex/arbitrage-instance/ArbitrageInstance";
import { activeManagedQuantity } from "../cex/arbitrage-instance/ArbitrageInstance";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";

const DEFAULT_MARKET_MAX_AGE_MS = 20_000;
const NORMALIZED_FUNDING_INTERVAL_HOURS = 8;

type Completeness = "COMPLETE" | "INCOMPLETE";
type FundingCashflowDirection = "INCOME" | "EXPENSE" | "NEUTRAL" | "NOT_APPLICABLE";

export type ArbitragePositionPresentation = Readonly<{
  arbitrageId: string;
  market: Readonly<{
    legs: readonly [FundingLegPresentation, FundingLegPresentation];
    netFundingRate8h: number | null;
    nextFundingEvent: NextFundingEvent;
    managedScaleUsdt: string | null;
    managedScaleAsOf: number | null;
    managedScaleCompleteness: Completeness;
    fundingRate: number | null;
    fundingIntervalHours: number | null;
    nextFundingTime: number | null;
    nextEstimatedFundingFee: string | null;
    nextEstimatedFundingFeeAsset: string | null;
    spreadQuotePerBase: number | null;
    spreadBps: number | null;
    quotedAt: number | null;
    marketDataAsOf: number | null;
    completeness: Completeness;
  }>;
  revenue: Readonly<{
    expectedArbitrageNetProfit: null;
    cumulativeFundingIncome: null;
    incurredFees: null;
    estimatedExitFees: null;
    exitSpreadProfit: null;
    completeness: "INCOMPLETE";
  }>;
}>;

type FundingLegPresentation = Readonly<{
  legId: string;
  venue: ArbitrageInstanceLeg["venue"];
  legRole: ArbitrageInstanceLeg["role"];
  marketType: "SPOT" | "PERPETUAL";
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  cashflowDirection: FundingCashflowDirection;
  completeness: Completeness;
}>;

type NextFundingEventLeg = Readonly<{
  venue: ArbitrageInstanceLeg["venue"];
  legRole: ArbitrageInstanceLeg["role"];
  fundingRate: number;
  fundingIntervalHours: number;
  estimatedCashflow: string;
}>;

type NextFundingEvent = Readonly<{
  time: number | null;
  estimatedNetFee: string | null;
  eventLegs: readonly NextFundingEventLeg[];
  completeness: Completeness;
}>;

export type PositionMarketSnapshotSource = Readonly<{
  getCurrentMarketSnapshot(): Promise<Readonly<{ generatedAt: number; markets: readonly ArbitrageMarket[] }>>;
}>;

type MappedLeg = Readonly<{
  leg: ArbitrageInstanceLeg;
  canonical: ReturnType<typeof canonicalInstrumentFromId>;
  market: ArbitrageMarket | undefined;
  fresh: boolean;
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
        return incomplete(instance);
      }
    }));
  }

  private presentInstance(instance: ArbitrageInstance, markets: readonly ArbitrageMarket[]): ArbitragePositionPresentation {
    const now = this.now();
    const mapped: readonly MappedLeg[] = instance.legs.map((leg) => {
      const canonical = canonicalInstrumentFromId(leg.instrumentId);
      const venueInstrument = this.instruments.resolveVenueInstrument(canonical, leg.venue);
      const market = markets.find((candidate) => candidate.venue === leg.venue
        && candidate.symbol === venueInstrument.symbol
        && candidate.kind === canonical.contractType);
      const fresh = Boolean(market
        && market.status !== "disconnected"
        && now - market.fetchedAt <= this.marketMaxAgeMs);
      return { leg, canonical, market, fresh };
    });

    const legs = mapped.map(fundingLegPresentation) as unknown as readonly [FundingLegPresentation, FundingLegPresentation];
    const netFundingRate8h = normalizedNetFundingRate(mapped);
    const nextFundingEvent = presentNextFundingEvent(instance, mapped);
    const exitSpread = presentExitSpread(mapped);
    const managedScale = presentManagedScale(instance, mapped);
    const marketDataAsOf = mapped.every(({ fresh }) => fresh)
      ? Math.min(...mapped.map(({ market }) => market!.fetchedAt))
      : null;
    const complete = netFundingRate8h !== null
      && nextFundingEvent.completeness === "COMPLETE"
      && exitSpread.completeness === "COMPLETE"
      && managedScale.completeness === "COMPLETE";

    return Object.freeze({
      arbitrageId: instance.arbitrageId,
      market: Object.freeze({
        legs: Object.freeze(legs),
        netFundingRate8h,
        nextFundingEvent,
        managedScaleUsdt: managedScale.value,
        managedScaleAsOf: managedScale.asOf,
        managedScaleCompleteness: managedScale.completeness,
        fundingRate: netFundingRate8h,
        fundingIntervalHours: netFundingRate8h === null ? null : NORMALIZED_FUNDING_INTERVAL_HOURS,
        nextFundingTime: nextFundingEvent.time,
        nextEstimatedFundingFee: nextFundingEvent.estimatedNetFee,
        nextEstimatedFundingFeeAsset: nextFundingEvent.completeness === "COMPLETE" ? "USDT" : null,
        spreadQuotePerBase: exitSpread.quotePerBase,
        spreadBps: exitSpread.bps,
        quotedAt: exitSpread.asOf,
        marketDataAsOf,
        completeness: complete ? "COMPLETE" as const : "INCOMPLETE" as const,
      }),
      revenue: incompleteRevenue(),
    });
  }
}

function fundingLegPresentation({ leg, canonical, market, fresh }: MappedLeg): FundingLegPresentation {
  if (canonical.contractType === "spot") {
    return Object.freeze({
      legId: leg.legId, venue: leg.venue, legRole: leg.role, marketType: "SPOT" as const,
      fundingRate: null, fundingIntervalHours: null, cashflowDirection: "NOT_APPLICABLE" as const,
      completeness: "COMPLETE" as const,
    });
  }
  const complete = fresh && validFundingMarket(market);
  const fundingRate = complete ? market!.fundingRate! : null;
  return Object.freeze({
    legId: leg.legId, venue: leg.venue, legRole: leg.role, marketType: "PERPETUAL" as const,
    fundingRate,
    fundingIntervalHours: complete ? market!.fundingIntervalHours! : null,
    cashflowDirection: fundingRate === null ? "NEUTRAL" as const : cashflowDirection(leg.role, fundingRate),
    completeness: complete ? "COMPLETE" as const : "INCOMPLETE" as const,
  });
}

function normalizedNetFundingRate(mapped: readonly MappedLeg[]) {
  const perpetuals = mapped.filter(({ canonical }) => canonical.contractType === "perpetual");
  if (perpetuals.length === 0 || perpetuals.some(({ market, fresh }) => !fresh || !validFundingMarket(market))) return null;
  return perpetuals.reduce((total, { leg, market }) => total
    + sideFundingMultiplier(leg.role) * market!.fundingRate!
      * NORMALIZED_FUNDING_INTERVAL_HOURS / market!.fundingIntervalHours!, 0);
}

function presentNextFundingEvent(instance: ArbitrageInstance, mapped: readonly MappedLeg[]): NextFundingEvent {
  const perpetuals = mapped.filter(({ canonical }) => canonical.contractType === "perpetual");
  if (perpetuals.length === 0 || perpetuals.some(({ market, fresh }) => !fresh
    || !validFundingMarket(market) || !validPositiveNumber(market!.markPrice)
    || !validTimestamp(market!.nextFundingTime))) return incompleteNextFundingEvent();
  if (perpetuals.some(({ canonical, market }) => canonical.quoteAsset !== "USDT"
    || market!.quoteAsset !== "USDT" || market!.settlementAsset !== "USDT")) return incompleteNextFundingEvent();
  const time = Math.min(...perpetuals.map(({ market }) => market!.nextFundingTime!));
  const event = perpetuals.filter(({ market }) => market!.nextFundingTime === time);
  const eventLegs = event.map(({ leg, market }) => {
    const estimatedCashflow = sideFundingMultiplier(leg.role)
      * Number(activeManagedQuantity(instance, leg)) * market!.markPrice! * market!.fundingRate!;
    return Object.freeze({
      venue: leg.venue,
      legRole: leg.role,
      fundingRate: market!.fundingRate!,
      fundingIntervalHours: market!.fundingIntervalHours!,
      estimatedCashflow: displayDecimal(estimatedCashflow)!,
    });
  });
  const estimatedNetFee = displayDecimal(eventLegs.reduce((total, leg) => total + Number(leg.estimatedCashflow), 0));
  if (estimatedNetFee === null) return incompleteNextFundingEvent();
  return Object.freeze({ time, estimatedNetFee, eventLegs: Object.freeze(eventLegs), completeness: "COMPLETE" as const });
}

function presentExitSpread(mapped: readonly MappedLeg[]) {
  const long = mapped.find(({ leg }) => leg.role === "LONG");
  const short = mapped.find(({ leg }) => leg.role === "SHORT");
  if (!long?.fresh || !short?.fresh || !validPositiveNumber(long.market?.bid) || !validPositiveNumber(short.market?.ask)) {
    return { quotePerBase: null, bps: null, asOf: null, completeness: "INCOMPLETE" as const };
  }
  const quotePerBase = short.market!.ask! - long.market!.bid!;
  const midpoint = (short.market!.ask! + long.market!.bid!) / 2;
  return {
    quotePerBase,
    bps: quotePerBase / midpoint * 10_000,
    asOf: Math.min(long.market!.fetchedAt, short.market!.fetchedAt),
    completeness: "COMPLETE" as const,
  };
}

function presentManagedScale(instance: ArbitrageInstance, mapped: readonly MappedLeg[]) {
  if (mapped.some(({ canonical, market, fresh }) => !fresh || canonical.quoteAsset !== "USDT"
    || market?.quoteAsset !== "USDT" || market.settlementAsset !== "USDT")) return incompleteManagedScale();
  const notionals = mapped.map(({ leg, canonical, market }) => {
    const valuationPrice = canonical.contractType === "spot"
      ? validPositiveNumber(market!.bid) && validPositiveNumber(market!.ask) ? (market!.bid! + market!.ask!) / 2 : null
      : validPositiveNumber(market!.markPrice) ? market!.markPrice! : null;
    return valuationPrice === null ? null : Number(activeManagedQuantity(instance, leg)) * valuationPrice;
  });
  if (notionals.some((value) => value === null || !Number.isFinite(value))) return incompleteManagedScale();
  return {
    value: displayDecimal(Math.min(notionals[0]!, notionals[1]!)),
    asOf: Math.min(...mapped.map(({ market }) => market!.fetchedAt)),
    completeness: "COMPLETE" as const,
  };
}

function incomplete(instance: ArbitrageInstance): ArbitragePositionPresentation {
  const legs = instance.legs.map((leg) => {
    const spot = leg.instrumentId.endsWith("-SPOT");
    return Object.freeze({
      legId: leg.legId, venue: leg.venue, legRole: leg.role,
      marketType: spot ? "SPOT" as const : "PERPETUAL" as const,
      fundingRate: null, fundingIntervalHours: null,
      cashflowDirection: spot ? "NOT_APPLICABLE" as const : "NEUTRAL" as const,
      completeness: spot ? "COMPLETE" as const : "INCOMPLETE" as const,
    });
  }) as unknown as readonly [FundingLegPresentation, FundingLegPresentation];
  return Object.freeze({
    arbitrageId: instance.arbitrageId,
    market: Object.freeze({
      legs: Object.freeze(legs), netFundingRate8h: null, nextFundingEvent: incompleteNextFundingEvent(),
      managedScaleUsdt: null, managedScaleAsOf: null, managedScaleCompleteness: "INCOMPLETE" as const,
      fundingRate: null, fundingIntervalHours: null, nextFundingTime: null,
      nextEstimatedFundingFee: null, nextEstimatedFundingFeeAsset: null,
      spreadQuotePerBase: null, spreadBps: null, quotedAt: null, marketDataAsOf: null,
      completeness: "INCOMPLETE" as const,
    }),
    revenue: incompleteRevenue(),
  });
}

function incompleteNextFundingEvent(): NextFundingEvent {
  return Object.freeze({ time: null, estimatedNetFee: null, eventLegs: Object.freeze([]), completeness: "INCOMPLETE" as const });
}

function incompleteManagedScale() {
  return { value: null, asOf: null, completeness: "INCOMPLETE" as const };
}

function incompleteRevenue() {
  return Object.freeze({
    expectedArbitrageNetProfit: null, cumulativeFundingIncome: null, incurredFees: null,
    estimatedExitFees: null, exitSpreadProfit: null, completeness: "INCOMPLETE" as const,
  });
}

function validFundingMarket(market: ArbitrageMarket | undefined): boolean {
  return market?.fundingRate !== null && market?.fundingRate !== undefined
    && validPositiveNumber(market.fundingIntervalHours);
}

function validPositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validTimestamp(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sideFundingMultiplier(role: ArbitrageInstanceLeg["role"]) {
  return role === "LONG" ? -1 : 1;
}

function cashflowDirection(role: ArbitrageInstanceLeg["role"], fundingRate: number): FundingCashflowDirection {
  const cashflowRate = sideFundingMultiplier(role) * fundingRate;
  return cashflowRate > 0 ? "INCOME" : cashflowRate < 0 ? "EXPENSE" : "NEUTRAL";
}

function displayDecimal(value: number) {
  if (!Number.isFinite(value)) return null;
  const normalized = value.toFixed(12)
    .replace(/(\.\d*?[1-9])0+$/u, "$1")
    .replace(/\.0+$/u, "");
  return normalized === "-0" ? "0" : normalized;
}
