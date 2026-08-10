import type {
  FundingRatePort,
  InstrumentCatalogPort,
  MarketDataPort,
} from "../CexCapabilityPorts";
import type {
  CanonicalFundingRate,
  CanonicalInstrument,
  CanonicalTopOfBook,
  CexVenue,
} from "../CexCanonicalModels";
import {
  evaluateFundingSpreadOpportunities,
  type FundingOpportunityEvaluationParameters,
} from "./FundingOpportunityEvaluator";
import type { FundingOpportunitySource } from "./FundingOpportunitySource";
import type { FundingSpreadPlan } from "./FundingSpreadPlan";

export type FundingOpportunityReadVenue = Readonly<{
  venue: CexVenue;
  instrumentCatalog: Pick<InstrumentCatalogPort, "listInstruments" | "venue">;
  fundingRate: Pick<FundingRatePort, "getFundingRate" | "venue">;
  marketData: Pick<MarketDataPort, "getTopOfBook" | "venue">;
}>;

export type CanonicalFundingOpportunitySourceOptions = Readonly<{
  venues: readonly FundingOpportunityReadVenue[];
  parameters: Omit<FundingOpportunityEvaluationParameters, "now">;
  symbols?: readonly string[];
  now?: () => number;
}>;

export class CanonicalFundingOpportunitySource implements FundingOpportunitySource {
  private readonly now: () => number;

  constructor(private readonly options: CanonicalFundingOpportunitySourceOptions) {
    this.now = options.now ?? Date.now;
  }

  async getOpportunities(): Promise<FundingSpreadPlan[]> {
    const now = this.now();
    const symbols = normalizeSymbols(this.options.symbols);
    const snapshots = await Promise.all(this.options.venues.map((venue) => readVenueSnapshots(venue, symbols)));
    const instruments = snapshots.flatMap((snapshot) => snapshot.instruments);
    const fundingRates = snapshots.flatMap((snapshot) => snapshot.fundingRates);
    const topOfBooks = snapshots.flatMap((snapshot) => snapshot.topOfBooks);

    return evaluateFundingSpreadOpportunities(instruments, fundingRates, topOfBooks, {
      ...this.options.parameters,
      now,
    });
  }
}

async function readVenueSnapshots(venue: FundingOpportunityReadVenue, symbols: ReadonlySet<string>) {
  const instruments = await readInstruments(venue);
  const eligible = instruments
    .filter((instrument) => instrument.marketType === "perpetual")
    .filter((instrument) => matchesConfiguredSymbol(instrument, symbols));
  const snapshots = await Promise.all(eligible.map((instrument) => readInstrumentSnapshots(venue, instrument)));
  return {
    instruments,
    fundingRates: snapshots.flatMap((snapshot) => snapshot.fundingRate),
    topOfBooks: snapshots.flatMap((snapshot) => snapshot.topOfBook),
  };
}

function matchesConfiguredSymbol(
  instrument: CanonicalInstrument,
  symbols: ReadonlySet<string>,
) {
  return symbols.size === 0 || symbols.has(`${instrument.baseAsset}${instrument.quoteAsset}`.toUpperCase());
}

function normalizeSymbols(symbols: readonly string[] | undefined) {
  return new Set(
    (symbols ?? [])
      .map((symbol) => symbol.replace(/[-_/]/gu, "").trim().toUpperCase())
      .filter(Boolean),
  );
}

async function readInstruments(venue: FundingOpportunityReadVenue) {
  try {
    return await venue.instrumentCatalog.listInstruments();
  } catch {
    return [];
  }
}

async function readInstrumentSnapshots(
  venue: FundingOpportunityReadVenue,
  instrument: CanonicalInstrument,
): Promise<{
  fundingRate: CanonicalFundingRate[];
  topOfBook: CanonicalTopOfBook[];
}> {
  const [fundingRate, topOfBook] = await Promise.allSettled([
    venue.fundingRate.getFundingRate(instrument.instrumentId),
    venue.marketData.getTopOfBook(instrument.instrumentId),
  ]);
  return {
    fundingRate: fundingRate.status === "fulfilled" ? [fundingRate.value] : [],
    topOfBook: topOfBook.status === "fulfilled" ? [topOfBook.value] : [],
  };
}
