import type { ExecutionAccountingEvidence } from "../ExecutionAccountingEvidence";
import type { ArbitrageInstance } from "./ArbitrageInstance";

export type ExecutionAccountingFact = Readonly<{
  executionRecordId: string;
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  providerOrderId: string;
  executionPhase: "OPENING" | "CLOSING";
  quantityEffect: "INCREASE" | "DECREASE";
  terminalExecutionStatus: "CONFIRMED" | "FAILED";
  filledQuantity: string;
  averageFillPrice: string | null;
  feeAmountProvider: string | null;
  feeAsset: string | null;
  tradingFeeNetCostUsdt: string | null;
  confirmedAt: number;
  priceCompleteness: "COMPLETE" | "INCOMPLETE";
  feeCompleteness: "COMPLETE" | "INCOMPLETE";
  integrityStatus: "VERIFIED" | "NEEDS_CHECK";
  completeness: "COMPLETE" | "INCOMPLETE";
  createdAt: number;
}>;

export type ExecutionAccountingFactCandidate = ExecutionAccountingEvidence;

export type RealizedAccountingSummary = Readonly<{
  cumulativeFundingIncome: null;
  cumulativeFundingIncomeCompleteness: "INCOMPLETE";
  tradingFeeNetCostUsdt: string | null;
  tradingFeeCompleteness: "COMPLETE" | "INCOMPLETE";
  realizedSpreadProfit: string | null;
  realizedSpreadProfitCompleteness: "COMPLETE" | "INCOMPLETE";
  realizedNetProfit: null;
  realizedNetProfitCompleteness: "INCOMPLETE";
}>;

export function deriveRealizedAccounting(
  instance: ArbitrageInstance,
  facts: readonly ExecutionAccountingFact[],
): RealizedAccountingSummary {
  const references = instance.executionReferences.filter((reference) => reference.phase === "OPENING"
    || reference.phase === "CLOSING");
  const terminalWithFill = references.filter((reference) => (reference.status === "CONFIRMED"
    || reference.status === "FAILED") && reference.confirmedQuantity !== "0");
  const factByIntent = new Map(facts.map((fact) => [fact.executionIntentId, fact]));
  const allTerminalFactsPresent = terminalWithFill.every((reference) => {
    const fact = factByIntent.get(reference.executionIntentId);
    return fact !== undefined
      && fact.executionRecordId === reference.executionRecordId
      && fact.integrityStatus === "VERIFIED"
      && decimalEqual(fact.filledQuantity, reference.confirmedQuantity);
  });
  const unresolvedWithFill = references.some((reference) => reference.status !== "CONFIRMED"
    && reference.status !== "FAILED" && reference.confirmedQuantity !== "0");
  const openingReferences = terminalWithFill.filter((reference) => reference.phase === "OPENING");
  const openingCoverage = instance.legs.every((leg) => openingReferences.some((reference) => reference.legId === leg.legId))
    && openingReferences.every((reference) => {
      const fact = factByIntent.get(reference.executionIntentId);
      return fact?.priceCompleteness === "COMPLETE" && fact.averageFillPrice !== null;
    });
  const closingReferences = terminalWithFill.filter((reference) => reference.phase === "CLOSING");
  const closingPriceCoverage = closingReferences.every((reference) => {
    const fact = factByIntent.get(reference.executionIntentId);
    return fact?.priceCompleteness === "COMPLETE" && fact.averageFillPrice !== null;
  });

  const feeComplete = allTerminalFactsPresent && !unresolvedWithFill && openingReferences.length > 0
    && terminalWithFill.every((reference) => {
      const fact = factByIntent.get(reference.executionIntentId);
      return fact?.feeCompleteness === "COMPLETE" && fact.tradingFeeNetCostUsdt !== null;
    });
  const tradingFeeNetCostUsdt = feeComplete
    ? sumSignedDecimals(terminalWithFill.map((reference) =>
      factByIntent.get(reference.executionIntentId)!.tradingFeeNetCostUsdt!))
    : null;

  const spreadComplete = allTerminalFactsPresent && !unresolvedWithFill && openingCoverage && closingPriceCoverage;
  const realizedSpreadProfit = spreadComplete
    ? realizedSpread(instance, openingReferences, closingReferences, factByIntent)
    : null;
  return Object.freeze({
    cumulativeFundingIncome: null,
    cumulativeFundingIncomeCompleteness: "INCOMPLETE",
    tradingFeeNetCostUsdt,
    tradingFeeCompleteness: feeComplete ? "COMPLETE" : "INCOMPLETE",
    realizedSpreadProfit,
    realizedSpreadProfitCompleteness: spreadComplete ? "COMPLETE" : "INCOMPLETE",
    realizedNetProfit: null,
    realizedNetProfitCompleteness: "INCOMPLETE",
  });
}

function realizedSpread(
  instance: ArbitrageInstance,
  openingReferences: ArbitrageInstance["executionReferences"],
  closingReferences: ArbitrageInstance["executionReferences"],
  facts: ReadonlyMap<string, ExecutionAccountingFact>,
) {
  const longLeg = instance.legs.find((leg) => leg.role === "LONG")!;
  const shortLeg = instance.legs.find((leg) => leg.role === "SHORT")!;
  const longOpening = aggregate(openingReferences, facts, longLeg.legId);
  const shortOpening = aggregate(openingReferences, facts, shortLeg.legId);
  const longClosing = aggregate(closingReferences, facts, longLeg.legId);
  const shortClosing = aggregate(closingReferences, facts, shortLeg.legId);
  if (longOpening.quantity.numerator === 0n || shortOpening.quantity.numerator === 0n) return null;
  const pairedClosedQuantity = minRational(longClosing.quantity, shortClosing.quantity);
  if (pairedClosedQuantity.numerator === 0n) return "0";
  const longOpenAverage = divideRational(longOpening.notional, longOpening.quantity);
  const shortOpenAverage = divideRational(shortOpening.notional, shortOpening.quantity);
  const longCloseAverage = divideRational(longClosing.notional, longClosing.quantity);
  const shortCloseAverage = divideRational(shortClosing.notional, shortClosing.quantity);
  const spreadPerBase = subtractRational(
    addRational(longCloseAverage, shortOpenAverage),
    addRational(longOpenAverage, shortCloseAverage),
  );
  return formatRational(multiplyRational(spreadPerBase, pairedClosedQuantity));
}

function aggregate(
  references: ArbitrageInstance["executionReferences"],
  facts: ReadonlyMap<string, ExecutionAccountingFact>,
  legId: string,
) {
  let quantity = rational(0n, 1n);
  let notional = rational(0n, 1n);
  for (const reference of references.filter((candidate) => candidate.legId === legId)) {
    const fact = facts.get(reference.executionIntentId)!;
    const fillQuantity = parseDecimal(fact.filledQuantity);
    quantity = addRational(quantity, fillQuantity);
    notional = addRational(notional, multiplyRational(fillQuantity, parseDecimal(fact.averageFillPrice!)));
  }
  return { quantity, notional };
}

type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;

function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new Error("Accounting division by zero.");
  const sign = denominator < 0n ? -1n : 1n;
  return { numerator: numerator * sign, denominator: denominator * sign };
}

function parseDecimal(value: string): Rational {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const numerator = BigInt(`${integer}${fraction}`) * (negative ? -1n : 1n);
  return rational(numerator, 10n ** BigInt(fraction.length));
}

function addRational(left: Rational, right: Rational) {
  return rational(left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function subtractRational(left: Rational, right: Rational) {
  return rational(left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function multiplyRational(left: Rational, right: Rational) {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divideRational(left: Rational, right: Rational) {
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function minRational(left: Rational, right: Rational) {
  return left.numerator * right.denominator <= right.numerator * left.denominator ? left : right;
}

function formatRational(value: Rational, precision = 12) {
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const scale = 10n ** BigInt(precision);
  const scaled = (numerator * scale + value.denominator / 2n) / value.denominator;
  const integer = scaled / scale;
  const fraction = String(scaled % scale).padStart(precision, "0").replace(/0+$/u, "");
  const formatted = fraction ? `${integer}.${fraction}` : String(integer);
  return negative && formatted !== "0" ? `-${formatted}` : formatted;
}

function sumSignedDecimals(values: readonly string[]) {
  return formatRational(values.reduce((total, value) => addRational(total, parseDecimal(value)), rational(0n, 1n)));
}

function decimalEqual(left: string, right: string) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  return a.numerator * b.denominator === b.numerator * a.denominator;
}
