import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageInstance } from "./ArbitrageInstance";
import {
  deriveRealizedAccounting,
  type ExecutionAccountingFact,
} from "./ExecutionAccountingFact";

test("matched opening and closing facts derive realized spread and signed net fee cost", () => {
  const instance = fixture([
    reference("lo", "long", "OPENING", "10"), reference("so", "short", "OPENING", "10"),
    reference("lc", "long", "CLOSING", "4"), reference("sc", "short", "CLOSING", "4"),
  ]);
  const result = deriveRealizedAccounting(instance, [
    fact("lo", "long", "OPENING", "10", "100", "0.2"),
    fact("so", "short", "OPENING", "10", "110", "0.2"),
    fact("lc", "long", "CLOSING", "4", "105", "0.1"),
    fact("sc", "short", "CLOSING", "4", "103", "0.1"),
  ]);
  assert.equal(result.realizedSpreadProfit, "48");
  assert.equal(result.realizedSpreadProfitCompleteness, "COMPLETE");
  assert.equal(result.tradingFeeNetCostUsdt, "0.6");
  assert.equal(result.tradingFeeCompleteness, "COMPLETE");
  assert.equal(result.cumulativeFundingIncome, null);
  assert.equal(result.realizedNetProfit, null);
});

test("asymmetric closes use cumulative proportional pairing and do not count unmatched excess quantity", () => {
  const instance = fixture([
    reference("lo", "long", "OPENING", "10"), reference("so", "short", "OPENING", "10"),
    reference("lc", "long", "CLOSING", "6"), reference("sc", "short", "CLOSING", "4"),
  ]);
  const result = deriveRealizedAccounting(instance, [
    fact("lo", "long", "OPENING", "10", "100", "0"),
    fact("so", "short", "OPENING", "10", "110", "0"),
    fact("lc", "long", "CLOSING", "6", "106", "0"),
    fact("sc", "short", "CLOSING", "4", "104", "0"),
  ]);
  assert.equal(result.realizedSpreadProfit, "48");
});

test("complete opening coverage and no close produces a real zero spread result", () => {
  const instance = fixture([
    reference("lo", "long", "OPENING", "10"), reference("so", "short", "OPENING", "10"),
  ]);
  const result = deriveRealizedAccounting(instance, [
    fact("lo", "long", "OPENING", "10", "100", "0"),
    fact("so", "short", "OPENING", "10", "110", "0"),
  ]);
  assert.equal(result.realizedSpreadProfit, "0");
  assert.equal(result.realizedSpreadProfitCompleteness, "COMPLETE");
});

test("missing opening price keeps spread incomplete while a rebate remains a signed negative fee cost", () => {
  const instance = fixture([
    reference("lo", "long", "OPENING", "10"), reference("so", "short", "OPENING", "10"),
  ]);
  const result = deriveRealizedAccounting(instance, [
    fact("lo", "long", "OPENING", "10", null, "-0.1"),
    fact("so", "short", "OPENING", "10", "110", "0.04"),
  ]);
  assert.equal(result.realizedSpreadProfit, null);
  assert.equal(result.realizedSpreadProfitCompleteness, "INCOMPLETE");
  assert.equal(result.tradingFeeNetCostUsdt, "-0.06");
});

test("missing fee stays null rather than becoming zero", () => {
  const instance = fixture([
    reference("lo", "long", "OPENING", "10"), reference("so", "short", "OPENING", "10"),
  ]);
  const facts = [
    fact("lo", "long", "OPENING", "10", "100", null),
    fact("so", "short", "OPENING", "10", "110", "0"),
  ];
  const result = deriveRealizedAccounting(instance, facts);
  assert.equal(result.tradingFeeNetCostUsdt, null);
  assert.equal(result.tradingFeeCompleteness, "INCOMPLETE");
});

test("missing expected opening fact keeps both aggregates incomplete", () => {
  const instance = fixture([
    reference("lo", "long", "OPENING", "10"), reference("so", "short", "OPENING", "10"),
  ]);
  const result = deriveRealizedAccounting(instance, [
    fact("lo", "long", "OPENING", "10", "100", "0.1"),
  ]);
  assert.equal(result.realizedSpreadProfit, null);
  assert.equal(result.realizedSpreadProfitCompleteness, "INCOMPLETE");
  assert.equal(result.tradingFeeNetCostUsdt, null);
  assert.equal(result.tradingFeeCompleteness, "INCOMPLETE");
});

test("missing expected closing fact cannot be mistaken for a complete paired close", () => {
  const instance = fixture([
    reference("lo", "long", "OPENING", "10"), reference("so", "short", "OPENING", "10"),
    reference("lc", "long", "CLOSING", "4"), reference("sc", "short", "CLOSING", "4"),
  ]);
  const result = deriveRealizedAccounting(instance, [
    fact("lo", "long", "OPENING", "10", "100", "0.1"),
    fact("so", "short", "OPENING", "10", "110", "0.1"),
    fact("lc", "long", "CLOSING", "4", "105", "0.1"),
  ]);
  assert.equal(result.realizedSpreadProfit, null);
  assert.equal(result.realizedSpreadProfitCompleteness, "INCOMPLETE");
});

test("mixed complete rows plus one missing expected row remain incomplete", () => {
  const instance = fixture([
    reference("lo", "long", "OPENING", "10"), reference("so", "short", "OPENING", "10"),
    reference("lc", "long", "CLOSING", "4"),
  ]);
  const result = deriveRealizedAccounting(instance, [
    fact("lo", "long", "OPENING", "10", "100", "0.1"),
    fact("lc", "long", "CLOSING", "4", "105", "0.1"),
  ]);
  assert.equal(result.realizedSpreadProfitCompleteness, "INCOMPLETE");
  assert.equal(result.tradingFeeCompleteness, "INCOMPLETE");
});

function fixture(executionReferences: ArbitrageInstance["executionReferences"]): ArbitrageInstance {
  return {
    arbitrageId: "arb", userId: "user", strategyType: "PERPETUAL_PERPETUAL", sourcePlanId: null,
    maxResidualBaseQuantity: "0", status: "HOLDING", createdAt: 1, openedAt: 2, updatedAt: 10, closedAt: null,
    legs: [
      { legId: "long", role: "LONG", venue: "okx", accountId: "a", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "10", confirmedOpenedQuantity: "10", confirmedClosedQuantity: "0" },
      { legId: "short", role: "SHORT", venue: "bybit", accountId: "b", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "10", confirmedOpenedQuantity: "10", confirmedClosedQuantity: "0" },
    ],
    executionReferences,
    managementReleases: [], legacyUnresolvedExecutionSeals: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}

function reference(
  executionIntentId: string,
  legId: string,
  phase: "OPENING" | "CLOSING",
  quantity: string,
): ArbitrageInstance["executionReferences"][number] {
  return {
    arbitrageId: "arb", legId, phase, quantityEffect: phase === "OPENING" ? "INCREASE" : "DECREASE",
    executionIntentId, executionRecordId: `record-${executionIntentId}`, requestedQuantity: quantity,
    confirmedQuantity: quantity, status: "CONFIRMED", createdAt: 2, updatedAt: 3,
  };
}

function fact(
  executionIntentId: string,
  legId: string,
  executionPhase: "OPENING" | "CLOSING",
  filledQuantity: string,
  averageFillPrice: string | null,
  tradingFeeNetCostUsdt: string | null,
): ExecutionAccountingFact {
  return {
    executionRecordId: `record-${executionIntentId}`, arbitrageId: "arb", legId, executionIntentId,
    providerOrderId: `order-${executionIntentId}`, executionPhase,
    quantityEffect: executionPhase === "OPENING" ? "INCREASE" : "DECREASE",
    terminalExecutionStatus: "CONFIRMED", filledQuantity, averageFillPrice,
    feeAmountProvider: tradingFeeNetCostUsdt, feeAsset: tradingFeeNetCostUsdt === null ? null : "USDT",
    tradingFeeNetCostUsdt, confirmedAt: 3,
    priceCompleteness: averageFillPrice === null ? "INCOMPLETE" : "COMPLETE",
    feeCompleteness: tradingFeeNetCostUsdt === null ? "INCOMPLETE" : "COMPLETE",
    integrityStatus: "VERIFIED",
    completeness: averageFillPrice !== null && tradingFeeNetCostUsdt !== null ? "COMPLETE" : "INCOMPLETE",
    createdAt: 3,
  };
}
