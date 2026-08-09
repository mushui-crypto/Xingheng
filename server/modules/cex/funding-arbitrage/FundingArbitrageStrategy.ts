import type { CanonicalFundingRate, CanonicalInstrument } from "../CexCanonicalModels";
import type {
  FundingArbitrageConfidence,
  FundingArbitragePlan,
  PerpetualFundingArbitrageLeg,
} from "./FundingArbitragePlan";

export type FundingArbitragePlanningParameters = Readonly<{
  planId: string;
  targetBaseQuantity: number;
  minimumFundingSpreadRate: number;
  maxSnapshotAgeMs: number;
  maxFundingTimeSkewMs: number;
  entryCutoffMs: number;
  now: number;
}>;

type Candidate = {
  longInstrument: CanonicalInstrument;
  shortInstrument: CanonicalInstrument;
  longFunding: CanonicalFundingRate;
  shortFunding: CanonicalFundingRate;
  baseQuantity: number;
  spreadRate: number;
  fundingTimeSkewMs: number;
  expiresAt: number;
};

export function buildFundingArbitragePlan(
  instruments: readonly CanonicalInstrument[],
  fundingRates: readonly CanonicalFundingRate[],
  parameters: FundingArbitragePlanningParameters,
): FundingArbitragePlan | null {
  assertPlanningParameters(parameters);
  const fundingByInstrument = new Map(
    fundingRates.map((snapshot) => [fundingKey(snapshot.venue, snapshot.instrumentId), snapshot]),
  );
  const eligibleInstruments = instruments.filter((instrument) => isEligibleInstrument(instrument, parameters));
  let best: Candidate | null = null;

  for (let leftIndex = 0; leftIndex < eligibleInstruments.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < eligibleInstruments.length; rightIndex += 1) {
      const left = eligibleInstruments[leftIndex];
      const right = eligibleInstruments[rightIndex];
      if (!left || !right || !isExactMatch(left, right) || left.venue === right.venue) continue;
      const leftFunding = fundingByInstrument.get(fundingKey(left.venue, left.instrumentId));
      const rightFunding = fundingByInstrument.get(fundingKey(right.venue, right.instrumentId));
      if (!leftFunding || !rightFunding) continue;
      if (!isFresh(leftFunding.fetchedAt, parameters) || !isFresh(rightFunding.fetchedAt, parameters)) continue;
      if (leftFunding.nextFundingAt === null || rightFunding.nextFundingAt === null) continue;
      const fundingTimeSkewMs = Math.abs(leftFunding.nextFundingAt - rightFunding.nextFundingAt);
      if (fundingTimeSkewMs > parameters.maxFundingTimeSkewMs) continue;

      const [longInstrument, longFunding, shortInstrument, shortFunding] = leftFunding.rate <= rightFunding.rate
        ? [left, leftFunding, right, rightFunding]
        : [right, rightFunding, left, leftFunding];
      const spreadRate = shortFunding.rate - longFunding.rate;
      if (spreadRate < parameters.minimumFundingSpreadRate) continue;
      const baseQuantity = normalizeBaseQuantity(parameters.targetBaseQuantity, left, right);
      if (baseQuantity === null) continue;
      const expiresAt = calculateExpiry(
        [left, right],
        [leftFunding, rightFunding],
        parameters,
      );
      if (expiresAt <= parameters.now) continue;

      const candidate: Candidate = {
        longInstrument,
        shortInstrument,
        longFunding,
        shortFunding,
        baseQuantity,
        spreadRate,
        fundingTimeSkewMs,
        expiresAt,
      };
      if (!best || candidate.spreadRate > best.spreadRate) best = candidate;
    }
  }

  return best ? toPlan(best, parameters) : null;
}

function toPlan(candidate: Candidate, parameters: FundingArbitragePlanningParameters): FundingArbitragePlan {
  const longLeg = toPerpetualLeg("long", candidate.longInstrument, candidate.longFunding, candidate.baseQuantity);
  const shortLeg = toPerpetualLeg("short", candidate.shortInstrument, candidate.shortFunding, candidate.baseQuantity);
  const amount = candidate.longFunding.markPrice === null || candidate.shortFunding.markPrice === null
    ? null
    : candidate.baseQuantity * (
      candidate.shortFunding.markPrice * candidate.shortFunding.rate
      - candidate.longFunding.markPrice * candidate.longFunding.rate
    );
  return {
    planId: parameters.planId,
    strategyType: "PERPETUAL_PERPETUAL",
    instrument: {
      baseAsset: candidate.longInstrument.baseAsset,
      quoteAsset: candidate.longInstrument.quoteAsset,
      settlementAsset: candidate.longInstrument.settlementAsset,
    },
    legs: [longLeg, shortLeg],
    expectedFunding: {
      netRate: candidate.spreadRate,
      amount,
      asset: amount === null ? null : candidate.longInstrument.settlementAsset,
      fundingAt: Math.max(
        candidate.longFunding.nextFundingAt ?? 0,
        candidate.shortFunding.nextFundingAt ?? 0,
      ),
    },
    confidence: confidenceFor(candidate),
    details: {
      fundingSpreadRate: candidate.spreadRate,
      fundingTimeSkewMs: candidate.fundingTimeSkewMs,
    },
    createdAt: parameters.now,
    expiresAt: candidate.expiresAt,
  };
}

function toPerpetualLeg<Role extends "long" | "short">(
  role: Role,
  instrument: CanonicalInstrument,
  fundingSnapshot: CanonicalFundingRate,
  baseQuantity: number,
): PerpetualFundingArbitrageLeg & { role: Role } {
  return {
    role,
    venue: instrument.venue,
    instrumentId: instrument.instrumentId,
    marketType: "perpetual",
    baseQuantity,
    fundingSnapshot,
  };
}

function isEligibleInstrument(instrument: CanonicalInstrument, parameters: FundingArbitragePlanningParameters) {
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

function isFresh(fetchedAt: number, parameters: FundingArbitragePlanningParameters) {
  const age = parameters.now - fetchedAt;
  return age >= 0 && age <= parameters.maxSnapshotAgeMs;
}

function calculateExpiry(
  instruments: readonly [CanonicalInstrument, CanonicalInstrument],
  fundingRates: readonly [CanonicalFundingRate, CanonicalFundingRate],
  parameters: FundingArbitragePlanningParameters,
) {
  return Math.min(
    ...instruments.map((instrument) => instrument.fetchedAt + parameters.maxSnapshotAgeMs),
    ...fundingRates.map((funding) => funding.fetchedAt + parameters.maxSnapshotAgeMs),
    ...fundingRates.map((funding) => (funding.nextFundingAt ?? 0) - parameters.entryCutoffMs),
  );
}

function normalizeBaseQuantity(
  targetBaseQuantity: number,
  left: CanonicalInstrument,
  right: CanonicalInstrument,
) {
  const leftStep = baseQuantityStep(left);
  const rightStep = baseQuantityStep(right);
  const commonStep = commonQuantityStep(leftStep, rightStep);
  const quantity = Math.floor((targetBaseQuantity + 1e-12) / commonStep) * commonStep;
  const leftMinimum = baseMinimumQuantity(left);
  const rightMinimum = baseMinimumQuantity(right);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity + 1e-12 < Math.max(leftMinimum, rightMinimum)) {
    return null;
  }
  return roundQuantity(quantity);
}

function baseQuantityStep(instrument: CanonicalInstrument) {
  return instrument.quantityUnit === "base"
    ? instrument.quantityStep
    : instrument.quantityStep * instrument.contractSize;
}

function baseMinimumQuantity(instrument: CanonicalInstrument) {
  return instrument.quantityUnit === "base"
    ? instrument.minQuantity
    : instrument.minQuantity * instrument.contractSize;
}

function commonQuantityStep(left: number, right: number) {
  const decimalPlaces = Math.max(countDecimalPlaces(left), countDecimalPlaces(right));
  const scale = 10 ** decimalPlaces;
  const leftInteger = Math.round(left * scale);
  const rightInteger = Math.round(right * scale);
  return leastCommonMultiple(leftInteger, rightInteger) / scale;
}

function countDecimalPlaces(value: number) {
  const fixed = value.toFixed(12).replace(/0+$/u, "");
  const decimal = fixed.indexOf(".");
  return decimal === -1 ? 0 : fixed.length - decimal - 1;
}

function leastCommonMultiple(left: number, right: number) {
  return Math.abs(left * right) / greatestCommonDivisor(left, right);
}

function greatestCommonDivisor(left: number, right: number): number {
  return right === 0 ? left : greatestCommonDivisor(right, left % right);
}

function roundQuantity(value: number) {
  return Number(value.toFixed(12));
}

function confidenceFor(candidate: Candidate): FundingArbitrageConfidence {
  if (candidate.longFunding.markPrice === null || candidate.shortFunding.markPrice === null) return "low";
  return candidate.fundingTimeSkewMs === 0 ? "high" : "medium";
}

function fundingKey(venue: string, instrumentId: string) {
  return `${venue}:${instrumentId}`;
}

function assertPlanningParameters(parameters: FundingArbitragePlanningParameters) {
  if (!parameters.planId) throw new Error("Funding arbitrage planId is required.");
  const numericParameters = {
    targetBaseQuantity: parameters.targetBaseQuantity,
    minimumFundingSpreadRate: parameters.minimumFundingSpreadRate,
    maxSnapshotAgeMs: parameters.maxSnapshotAgeMs,
    maxFundingTimeSkewMs: parameters.maxFundingTimeSkewMs,
    entryCutoffMs: parameters.entryCutoffMs,
    now: parameters.now,
  };
  for (const [name, value] of Object.entries(numericParameters)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid funding arbitrage parameter: ${name}.`);
  }
  if (parameters.targetBaseQuantity <= 0 || parameters.maxSnapshotAgeMs <= 0) {
    throw new Error("Funding arbitrage quantity and snapshot age must be positive.");
  }
}
