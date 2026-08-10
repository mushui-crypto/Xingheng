import type {
  CanonicalFundingRate,
  CanonicalInstrument,
  CanonicalTopOfBook,
} from "../CexCanonicalModels";
import type { FundingSpreadConfidence, FundingSpreadPlan } from "./FundingSpreadPlan";

export type FundingOpportunityEvaluationParameters = Readonly<{
  minimumNetYield: number;
  maxSnapshotAgeMs: number;
  maxFundingTimeSkewMs: number;
  entryCutoffMs: number;
  takerFeeRateByVenue?: Readonly<Record<string, number>>;
  now: number;
}>;

type Candidate = Readonly<{
  longInstrument: CanonicalInstrument;
  shortInstrument: CanonicalInstrument;
  longFunding: CanonicalFundingRate;
  shortFunding: CanonicalFundingRate;
  longBook: CanonicalTopOfBook;
  shortBook: CanonicalTopOfBook;
  fundingTimeSkewMs: number;
  fundingSpread: number;
  estimatedCost: number;
  estimatedNetYield: number;
  expiresAt: number;
}>;

export function evaluateFundingSpreadOpportunities(
  instruments: readonly CanonicalInstrument[],
  fundingRates: readonly CanonicalFundingRate[],
  topOfBooks: readonly CanonicalTopOfBook[],
  parameters: FundingOpportunityEvaluationParameters,
): FundingSpreadPlan[] {
  assertEvaluationParameters(parameters);
  const fundingByInstrument = new Map(
    fundingRates.map((snapshot) => [snapshotKey(snapshot.venue, snapshot.instrumentId), snapshot]),
  );
  const topOfBookByInstrument = new Map(
    topOfBooks.map((snapshot) => [snapshotKey(snapshot.venue, snapshot.instrumentId), snapshot]),
  );
  const eligibleInstruments = instruments.filter((instrument) => isEligibleInstrument(instrument, parameters));
  const candidates: Candidate[] = [];

  for (let leftIndex = 0; leftIndex < eligibleInstruments.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < eligibleInstruments.length; rightIndex += 1) {
      const left = eligibleInstruments[leftIndex];
      const right = eligibleInstruments[rightIndex];
      if (!left || !right || left.venue === right.venue || !isExactMatch(left, right)) continue;
      const leftFunding = fundingByInstrument.get(snapshotKey(left.venue, left.instrumentId));
      const rightFunding = fundingByInstrument.get(snapshotKey(right.venue, right.instrumentId));
      const leftBook = topOfBookByInstrument.get(snapshotKey(left.venue, left.instrumentId));
      const rightBook = topOfBookByInstrument.get(snapshotKey(right.venue, right.instrumentId));
      if (!leftFunding || !rightFunding || !leftBook || !rightBook) continue;
      if (!isFresh(leftFunding.fetchedAt, parameters) || !isFresh(rightFunding.fetchedAt, parameters)) continue;
      if (!isFresh(leftBook.fetchedAt, parameters) || !isFresh(rightBook.fetchedAt, parameters)) continue;
      if (leftFunding.nextFundingAt === null || rightFunding.nextFundingAt === null) continue;
      const fundingTimeSkewMs = Math.abs(leftFunding.nextFundingAt - rightFunding.nextFundingAt);
      if (fundingTimeSkewMs > parameters.maxFundingTimeSkewMs) continue;

      const candidate = buildDirectionalCandidate(
        left,
        right,
        leftFunding,
        rightFunding,
        leftBook,
        rightBook,
        fundingTimeSkewMs,
        parameters,
      );
      if (!candidate || candidate.estimatedNetYield < parameters.minimumNetYield) continue;
      candidates.push(candidate);
    }
  }

  return candidates
    .sort((left, right) => right.estimatedNetYield - left.estimatedNetYield)
    .map((candidate) => toFundingSpreadPlan(candidate, parameters));
}

export function evaluateBestFundingSpreadOpportunity(
  instruments: readonly CanonicalInstrument[],
  fundingRates: readonly CanonicalFundingRate[],
  topOfBooks: readonly CanonicalTopOfBook[],
  parameters: FundingOpportunityEvaluationParameters,
): FundingSpreadPlan | null {
  return evaluateFundingSpreadOpportunities(instruments, fundingRates, topOfBooks, parameters)[0] ?? null;
}

function buildDirectionalCandidate(
  left: CanonicalInstrument,
  right: CanonicalInstrument,
  leftFunding: CanonicalFundingRate,
  rightFunding: CanonicalFundingRate,
  leftBook: CanonicalTopOfBook,
  rightBook: CanonicalTopOfBook,
  fundingTimeSkewMs: number,
  parameters: FundingOpportunityEvaluationParameters,
): Candidate | null {
  const [longInstrument, longFunding, longBook, shortInstrument, shortFunding, shortBook] =
    leftFunding.rate <= rightFunding.rate
      ? [left, leftFunding, leftBook, right, rightFunding, rightBook]
      : [right, rightFunding, rightBook, left, leftFunding, leftBook];
  const fundingSpread = shortFunding.rate - longFunding.rate;
  const estimatedCost = estimateRoundTripCostRate(longInstrument, shortInstrument, longBook, shortBook, parameters);
  const estimatedNetYield = fundingSpread - estimatedCost;
  const expiresAt = calculateExpiry(
    [left, right],
    [leftFunding, rightFunding],
    [leftBook, rightBook],
    parameters,
  );
  if (expiresAt <= parameters.now) return null;
  return {
    longInstrument,
    shortInstrument,
    longFunding,
    shortFunding,
    longBook,
    shortBook,
    fundingTimeSkewMs,
    fundingSpread,
    estimatedCost,
    estimatedNetYield,
    expiresAt,
  };
}

function estimateRoundTripCostRate(
  longInstrument: CanonicalInstrument,
  shortInstrument: CanonicalInstrument,
  longBook: CanonicalTopOfBook,
  shortBook: CanonicalTopOfBook,
  parameters: FundingOpportunityEvaluationParameters,
) {
  const longMid = midpoint(longBook);
  const shortMid = midpoint(shortBook);
  const longHalfSpread = longMid === null ? 0 : (longBook.ask - longBook.bid) / longMid / 2;
  const shortHalfSpread = shortMid === null ? 0 : (shortBook.ask - shortBook.bid) / shortMid / 2;
  const longFee = parameters.takerFeeRateByVenue?.[longInstrument.venue] ?? 0;
  const shortFee = parameters.takerFeeRateByVenue?.[shortInstrument.venue] ?? 0;
  return roundRate(longHalfSpread + shortHalfSpread + longFee + shortFee);
}

function midpoint(snapshot: CanonicalTopOfBook) {
  if (!Number.isFinite(snapshot.bid) || !Number.isFinite(snapshot.ask) || snapshot.bid <= 0 || snapshot.ask <= 0) {
    throw new Error(`Invalid top of book for funding opportunity: ${snapshot.venue}:${snapshot.instrumentId}.`);
  }
  if (snapshot.bid > snapshot.ask) {
    throw new Error(`Crossed top of book for funding opportunity: ${snapshot.venue}:${snapshot.instrumentId}.`);
  }
  return (snapshot.bid + snapshot.ask) / 2;
}

function toFundingSpreadPlan(candidate: Candidate, parameters: FundingOpportunityEvaluationParameters): FundingSpreadPlan {
  return {
    strategyType: "PERPETUAL_PERPETUAL",
    symbol: `${candidate.longInstrument.baseAsset}${candidate.longInstrument.quoteAsset}`,
    longVenue: candidate.longInstrument.venue,
    shortVenue: candidate.shortInstrument.venue,
    longInstrumentId: candidate.longInstrument.instrumentId,
    shortInstrumentId: candidate.shortInstrument.instrumentId,
    longFundingRate: candidate.longFunding.rate,
    shortFundingRate: candidate.shortFunding.rate,
    fundingSpread: roundRate(candidate.fundingSpread),
    estimatedCost: candidate.estimatedCost,
    estimatedNetYield: roundRate(candidate.estimatedNetYield),
    confidence: confidenceFor(candidate, parameters),
    createdAt: parameters.now,
    expiresAt: candidate.expiresAt,
  };
}

function isEligibleInstrument(instrument: CanonicalInstrument, parameters: FundingOpportunityEvaluationParameters) {
  return instrument.marketType === "perpetual"
    && instrument.contractType === "linear_perpetual"
    && instrument.status === "trading"
    && isFresh(instrument.fetchedAt, parameters);
}

function isExactMatch(left: CanonicalInstrument, right: CanonicalInstrument) {
  return left.baseAsset === right.baseAsset
    && left.quoteAsset === right.quoteAsset
    && left.settlementAsset === right.settlementAsset;
}

function isFresh(fetchedAt: number, parameters: FundingOpportunityEvaluationParameters) {
  const age = parameters.now - fetchedAt;
  return age >= 0 && age <= parameters.maxSnapshotAgeMs;
}

function calculateExpiry(
  instruments: readonly [CanonicalInstrument, CanonicalInstrument],
  fundingRates: readonly [CanonicalFundingRate, CanonicalFundingRate],
  topOfBooks: readonly [CanonicalTopOfBook, CanonicalTopOfBook],
  parameters: FundingOpportunityEvaluationParameters,
) {
  return Math.min(
    ...instruments.map((instrument) => instrument.fetchedAt + parameters.maxSnapshotAgeMs),
    ...fundingRates.map((funding) => funding.fetchedAt + parameters.maxSnapshotAgeMs),
    ...topOfBooks.map((book) => book.fetchedAt + parameters.maxSnapshotAgeMs),
    ...fundingRates.map((funding) => (funding.nextFundingAt ?? 0) - parameters.entryCutoffMs),
  );
}

function confidenceFor(
  candidate: Candidate,
  parameters: FundingOpportunityEvaluationParameters,
): FundingSpreadConfidence {
  if (candidate.estimatedNetYield <= 0) return "low";
  if (candidate.fundingTimeSkewMs > 0) return "medium";
  const maxAge = Math.max(
    parameters.now - candidate.longInstrument.fetchedAt,
    parameters.now - candidate.shortInstrument.fetchedAt,
    parameters.now - candidate.longFunding.fetchedAt,
    parameters.now - candidate.shortFunding.fetchedAt,
    parameters.now - candidate.longBook.fetchedAt,
    parameters.now - candidate.shortBook.fetchedAt,
  );
  return maxAge <= parameters.maxSnapshotAgeMs / 2 ? "high" : "medium";
}

function snapshotKey(venue: string, instrumentId: string) {
  return `${venue}:${instrumentId}`;
}

function roundRate(value: number) {
  return Number(value.toFixed(12));
}

function assertEvaluationParameters(parameters: FundingOpportunityEvaluationParameters) {
  const numericParameters = {
    maxSnapshotAgeMs: parameters.maxSnapshotAgeMs,
    maxFundingTimeSkewMs: parameters.maxFundingTimeSkewMs,
    entryCutoffMs: parameters.entryCutoffMs,
    now: parameters.now,
  };
  if (!Number.isFinite(parameters.minimumNetYield)) {
    throw new Error("Invalid funding opportunity parameter: minimumNetYield.");
  }
  for (const [name, value] of Object.entries(numericParameters)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid funding opportunity parameter: ${name}.`);
  }
  if (parameters.maxSnapshotAgeMs <= 0) throw new Error("Funding opportunity snapshot age must be positive.");
  for (const [venue, feeRate] of Object.entries(parameters.takerFeeRateByVenue ?? {})) {
    if (!venue || !Number.isFinite(feeRate) || feeRate < 0) {
      throw new Error(`Invalid funding opportunity fee rate: ${venue}.`);
    }
  }
}
