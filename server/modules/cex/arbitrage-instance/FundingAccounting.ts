import type { ArbitrageInstance, ArbitrageInstanceLeg } from "./ArbitrageInstance";
import type { ExecutionAccountingFact } from "./ExecutionAccountingFact";

export type FundingAttributionStatus = "ATTRIBUTED" | "AMBIGUOUS" | "INCOMPLETE";

export type ArbitrageFundingFact = Readonly<{
  providerFundingId: string;
  venue: string;
  accountId: string;
  instrumentId: string;
  positionSideOrBucket: string | null;
  providerPositionSize: string | null;
  settlementTime: number;
  amount: string;
  asset: string;
  amountUsdt: string | null;
  arbitrageId: string | null;
  attributionStatus: FundingAttributionStatus;
  integrityStatus: "VERIFIED" | "CONFLICT";
  createdAt: number;
}>;

export type FundingHistoryCoverage = Readonly<{
  venue: string;
  accountId: string;
  instrumentId: string;
  coveredFrom: number;
  coveredThrough: number;
  lastSuccessfulReadAt: number;
  paginationComplete: boolean;
}>;

export type FundingScheduleEvidence = Readonly<{
  legId: string;
  nextFundingTime: number | null;
  fundingIntervalHours: number | null;
  authoritative: boolean;
}>;

export type CumulativeFundingSummary = Readonly<{
  cumulativeFundingIncome: string | null;
  cumulativeFundingIncomeCompleteness: "COMPLETE" | "INCOMPLETE";
}>;

export function deriveCumulativeFundingIncome(input: Readonly<{
  instance: ArbitrageInstance;
  executionFacts: readonly ExecutionAccountingFact[];
  fundingFacts: readonly ArbitrageFundingFact[];
  coverage: readonly FundingHistoryCoverage[];
  schedules: readonly FundingScheduleEvidence[];
  now: number;
}>): CumulativeFundingSummary {
  const perpetualLegs = input.instance.legs.filter((leg) => leg.instrumentId.endsWith("-PERP"));
  if (perpetualLegs.length === 0) return incompleteFunding();

  const evidence = perpetualLegs.map((leg) => {
    const exposure = managedExposureTimeline(input.instance, input.executionFacts, leg, input.now);
    const schedule = input.schedules.find((candidate) => candidate.legId === leg.legId);
    return { leg, exposure, schedule };
  });
  if (evidence.some(({ exposure, schedule }) => !exposure.complete || exposure.startedAt === null
    || !validSchedule(schedule))) return incompleteFunding();

  const allBeforeFirstApplicableSettlement = evidence.every(({ exposure, schedule }) => {
    const firstSettlement = firstSettlementAtOrAfter(exposure.startedAt!, schedule!);
    const observationEnd = exposure.endedAt ?? input.now;
    return firstSettlement !== null && exposure.startedAt !== firstSettlement && observationEnd < firstSettlement;
  });
  if (allBeforeFirstApplicableSettlement) return completeFunding("0");

  let total = rational(0n, 1n);
  for (const { leg, exposure, schedule } of evidence) {
    const observationEnd = exposure.endedAt ?? input.now;
    const latestApplicableSettlement = latestSettlementAtOrBefore(observationEnd, schedule!);
    if (latestApplicableSettlement === null || exposure.startedAt! > latestApplicableSettlement) continue;
    if (exposure.startedAt === firstSettlementAtOrAfter(exposure.startedAt!, schedule!)
      || (exposure.endedAt !== null
        && exposure.endedAt === firstSettlementAtOrAfter(exposure.endedAt, schedule!))) return incompleteFunding();
    const coverage = input.coverage.find((candidate) => candidate.venue === leg.venue
      && candidate.accountId === leg.accountId && candidate.instrumentId === leg.instrumentId);
    if (!coverage?.paginationComplete || coverage.coveredFrom > exposure.startedAt!
      || coverage.coveredThrough < latestApplicableSettlement) return incompleteFunding();
    const relevant = input.fundingFacts.filter((fact) => fact.venue === leg.venue
      && fact.accountId === leg.accountId && fact.instrumentId === leg.instrumentId
      && fact.settlementTime >= exposure.startedAt! && fact.settlementTime <= latestApplicableSettlement);
    if (relevant.some((fact) => fact.integrityStatus !== "VERIFIED"
      || (fact.attributionStatus !== "ATTRIBUTED" && fact.arbitrageId === null))) {
      return incompleteFunding();
    }
    const attributed = relevant.filter((fact) => fact.attributionStatus === "ATTRIBUTED"
      && fact.arbitrageId === input.instance.arbitrageId && fact.positionSideOrBucket === leg.role);
    if (relevant.some((fact) => fact.attributionStatus === "ATTRIBUTED"
      && fact.arbitrageId === input.instance.arbitrageId && fact.positionSideOrBucket !== leg.role)) {
      return incompleteFunding();
    }
    if (attributed.some((fact) => fact.amountUsdt === null)) return incompleteFunding();
    const expectedSettlements = settlementsBetween(exposure.startedAt!, observationEnd, schedule!);
    if (expectedSettlements.some((settlement) => attributed.filter((fact) => fact.settlementTime === settlement).length !== 1)
      || attributed.some((fact) => !expectedSettlements.includes(fact.settlementTime))) return incompleteFunding();
    total = attributed.reduce((sum, fact) => add(sum, parseDecimal(fact.amountUsdt!)), total);
  }
  return completeFunding(formatRational(total));
}

export function managedExposureTimeline(
  instance: ArbitrageInstance,
  facts: readonly ExecutionAccountingFact[],
  leg: ArbitrageInstanceLeg,
  at: number,
) {
  const references = instance.executionReferences.filter((reference) => reference.legId === leg.legId);
  const factByIntent = new Map(facts.map((fact) => [fact.executionIntentId, fact]));
  let quantity = rational(0n, 1n);
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  for (const reference of references) {
    if (reference.createdAt < at && reference.updatedAt > at && reference.confirmedQuantity !== "0") {
      return { complete: false as const, quantity: "0", startedAt: null, endedAt: null };
    }
    if (reference.updatedAt === at && reference.confirmedQuantity !== "0") {
      return { complete: false as const, quantity: "0", startedAt: null, endedAt: null };
    }
    if (reference.updatedAt > at) continue;
    if (reference.status !== "CONFIRMED" && reference.status !== "FAILED") {
      return { complete: false as const, quantity: "0", startedAt: null, endedAt: null };
    }
    if (reference.confirmedQuantity === "0") continue;
    const fact = factByIntent.get(reference.executionIntentId);
    if (!fact || fact.executionRecordId !== reference.executionRecordId
      || fact.integrityStatus !== "VERIFIED" || fact.confirmedAt !== reference.updatedAt
      || !decimalEqual(fact.filledQuantity, reference.confirmedQuantity)) {
      return { complete: false as const, quantity: "0", startedAt: null, endedAt: null };
    }
    const signed = reference.quantityEffect === "INCREASE"
      ? parseDecimal(fact.filledQuantity) : negate(parseDecimal(fact.filledQuantity));
    quantity = add(quantity, signed);
    if (reference.quantityEffect === "INCREASE") {
      if (endedAt !== null) return { complete: false as const, quantity: "0", startedAt: null, endedAt: null };
      if (startedAt === null) startedAt = fact.confirmedAt;
    }
    if (quantity.numerator < 0n) return { complete: false as const, quantity: "0", startedAt: null, endedAt: null };
    if (startedAt !== null && quantity.numerator === 0n) endedAt = fact.confirmedAt;
  }
  for (const release of instance.managementReleases ?? []) {
    if (release.legId !== leg.legId || release.confirmedAt > at) continue;
    quantity = add(quantity, negate(parseDecimal(release.releasedQuantity)));
    if (quantity.numerator < 0n) return { complete: false as const, quantity: "0", startedAt: null, endedAt: null };
    if (startedAt !== null && quantity.numerator === 0n) endedAt = release.confirmedAt;
  }
  return { complete: true as const, quantity: formatRational(quantity), startedAt, endedAt };
}

function latestSettlementAtOrBefore(now: number, schedule: FundingScheduleEvidence) {
  if (!validSchedule(schedule)) return null;
  const intervalMs = schedule.fundingIntervalHours * 3_600_000;
  const intervals = Math.floor((now - schedule.nextFundingTime) / intervalMs);
  return schedule.nextFundingTime + intervals * intervalMs;
}

function firstSettlementAtOrAfter(at: number, schedule: FundingScheduleEvidence) {
  if (!validSchedule(schedule)) return null;
  const intervalMs = schedule.fundingIntervalHours * 3_600_000;
  const intervals = Math.ceil((at - schedule.nextFundingTime) / intervalMs);
  return schedule.nextFundingTime + intervals * intervalMs;
}

function settlementsBetween(startedAt: number, endedAt: number, schedule: FundingScheduleEvidence) {
  const first = firstSettlementAtOrAfter(startedAt, schedule);
  if (first === null || first > endedAt) return [];
  const intervalMs = schedule.fundingIntervalHours! * 3_600_000;
  const values: number[] = [];
  for (let settlement = first; settlement <= endedAt; settlement += intervalMs) values.push(settlement);
  return values;
}

function validSchedule(schedule: FundingScheduleEvidence | undefined): schedule is FundingScheduleEvidence & {
  nextFundingTime: number; fundingIntervalHours: number;
} {
  return Boolean(schedule?.authoritative && Number.isSafeInteger(schedule.nextFundingTime)
    && schedule.nextFundingTime! >= 0 && Number.isFinite(schedule.fundingIntervalHours)
    && schedule.fundingIntervalHours! > 0);
}

function incompleteFunding(): CumulativeFundingSummary {
  return Object.freeze({ cumulativeFundingIncome: null, cumulativeFundingIncomeCompleteness: "INCOMPLETE" as const });
}

function completeFunding(value: string): CumulativeFundingSummary {
  return Object.freeze({ cumulativeFundingIncome: value, cumulativeFundingIncomeCompleteness: "COMPLETE" as const });
}

type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;
function rational(numerator: bigint, denominator: bigint): Rational { return { numerator, denominator }; }
function negate(value: Rational) { return rational(-value.numerator, value.denominator); }
function add(left: Rational, right: Rational) {
  return rational(left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator);
}
function parseDecimal(value: string): Rational {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) throw new Error("Funding decimal is invalid.");
  const fraction = match[3] ?? "";
  const numerator = BigInt(`${match[2]}${fraction}`) * (match[1] === "-" ? -1n : 1n);
  return rational(numerator, 10n ** BigInt(fraction.length));
}
function decimalEqual(left: string, right: string) {
  const a = parseDecimal(left); const b = parseDecimal(right);
  return a.numerator * b.denominator === b.numerator * a.denominator;
}
function formatRational(value: Rational, precision = 12) {
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const scale = 10n ** BigInt(precision);
  const scaled = (numerator * scale + value.denominator / 2n) / value.denominator;
  const integer = scaled / scale;
  const fraction = String(scaled % scale).padStart(precision, "0").replace(/0+$/u, "");
  const result = fraction ? `${integer}.${fraction}` : String(integer);
  return negative && result !== "0" ? `-${result}` : result;
}
