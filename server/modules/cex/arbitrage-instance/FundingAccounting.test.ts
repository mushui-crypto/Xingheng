import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageInstance } from "./ArbitrageInstance";
import type { ExecutionAccountingFact } from "./ExecutionAccountingFact";
import { deriveCumulativeFundingIncome, type ArbitrageFundingFact } from "./FundingAccounting";

const settlement = 8 * 60 * 60 * 1000;

test("authoritative exposure after the previous settlement proves zero before the next settlement", () => {
  const result = derive(1_000, settlement - 1);
  assert.deepEqual(result, { cumulativeFundingIncome: "0", cumulativeFundingIncomeCompleteness: "COMPLETE" });
});

test("exposure immediately after settlement remains complete zero until the next settlement", () => {
  const result = derive(1, settlement - 1);
  assert.equal(result.cumulativeFundingIncome, "0");
  assert.equal(result.cumulativeFundingIncomeCompleteness, "COMPLETE");
});

test("crossed settlement without complete provider history remains incomplete", () => {
  const result = derive(1_000, settlement + 1, [], []);
  assert.equal(result.cumulativeFundingIncome, null);
  assert.equal(result.cumulativeFundingIncomeCompleteness, "INCOMPLETE");
});

test("complete provider history with no settlement record remains incomplete after settlement", () => {
  const result = derive(1_000, settlement + 1, [], [{
    venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP",
    coveredFrom: 1_000, coveredThrough: settlement, lastSuccessfulReadAt: settlement + 1,
    paginationComplete: true,
  }]);
  assert.equal(result.cumulativeFundingIncome, null);
  assert.equal(result.cumulativeFundingIncomeCompleteness, "INCOMPLETE");
});

test("unique attributed provider funding preserves its signed cashflow", () => {
  const result = derive(1_000, settlement + 1, [funding("-0.0025", "ATTRIBUTED", "arb")], [{
    venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP",
    coveredFrom: 1_000, coveredThrough: settlement, lastSuccessfulReadAt: settlement + 1,
    paginationComplete: true,
  }]);
  assert.equal(result.cumulativeFundingIncome, "-0.0025");
  assert.equal(result.cumulativeFundingIncomeCompleteness, "COMPLETE");
});

test("ambiguous provider funding is never converted to zero", () => {
  const result = derive(1_000, settlement + 1, [funding("0.001", "AMBIGUOUS", null)], [{
    venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP",
    coveredFrom: 1_000, coveredThrough: settlement, lastSuccessfulReadAt: settlement + 1,
    paginationComplete: true,
  }]);
  assert.equal(result.cumulativeFundingIncome, null);
  assert.equal(result.cumulativeFundingIncomeCompleteness, "INCOMPLETE");
});

test("execution spanning the settlement boundary cannot prove exposure", () => {
  const instance = fixture(1_000, [{
    ...reference(1_000), createdAt: settlement - 100, updatedAt: settlement + 100,
  }]);
  const result = deriveCumulativeFundingIncome({
    instance, executionFacts: [fact(settlement + 100)], fundingFacts: [], coverage: [],
    schedules: [schedule(settlement * 2)], now: settlement,
  });
  assert.equal(result.cumulativeFundingIncomeCompleteness, "INCOMPLETE");
});

test("exposure closed before its first applicable settlement proves zero without later history", () => {
  const opened = hour;
  const closed = 4 * hour;
  const instance = fixture(opened, [reference(opened), {
    ...reference(closed), phase: "CLOSING", quantityEffect: "DECREASE",
    executionIntentId: "close-intent", executionRecordId: "close-record",
  }]);
  const closeFact = {
    ...fact(closed), executionRecordId: "close-record", executionIntentId: "close-intent",
    executionPhase: "CLOSING", quantityEffect: "DECREASE",
  } as ExecutionAccountingFact;
  const result = deriveCumulativeFundingIncome({
    instance, executionFacts: [fact(opened), closeFact], fundingFacts: [], coverage: [],
    schedules: [schedule(settlement * 2)], now: settlement + hour,
  });
  assert.deepEqual(result, { cumulativeFundingIncome: "0", cumulativeFundingIncomeCompleteness: "COMPLETE" });
});

function derive(
  startedAt: number,
  now: number,
  fundingFacts: readonly ArbitrageFundingFact[] = [],
  coverage: Parameters<typeof deriveCumulativeFundingIncome>[0]["coverage"] = [],
) {
  return deriveCumulativeFundingIncome({
    instance: fixture(startedAt), executionFacts: [fact(startedAt)], fundingFacts, coverage,
    schedules: [schedule(settlement)], now,
  });
}

const hour = 60 * 60 * 1000;

function fixture(startedAt: number, references = [reference(startedAt)]): ArbitrageInstance {
  return {
    arbitrageId: "arb", userId: "user", strategyType: "SPOT_PERPETUAL", sourcePlanId: null,
    maxResidualBaseQuantity: "1", status: "HOLDING", createdAt: 0, openedAt: startedAt,
    updatedAt: startedAt, closedAt: null,
    legs: [
      { legId: "spot", role: "LONG", venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "68", confirmedOpenedQuantity: "68", confirmedClosedQuantity: "0" },
      { legId: "perp", role: "SHORT", venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "68", confirmedOpenedQuantity: "68", confirmedClosedQuantity: "0" },
    ],
    executionReferences: references,
    managementReleases: [], legacyUnresolvedExecutionSeals: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}

function reference(at: number): ArbitrageInstance["executionReferences"][number] {
  return {
    arbitrageId: "arb", legId: "perp", phase: "OPENING", quantityEffect: "INCREASE",
    executionIntentId: "intent", executionRecordId: "record", requestedQuantity: "68",
    confirmedQuantity: "68", status: "CONFIRMED", createdAt: at - 1, updatedAt: at,
  };
}

function fact(at: number): ExecutionAccountingFact {
  return {
    executionRecordId: "record", arbitrageId: "arb", legId: "perp", executionIntentId: "intent",
    providerOrderId: "order", executionPhase: "OPENING", quantityEffect: "INCREASE",
    terminalExecutionStatus: "CONFIRMED", filledQuantity: "68", averageFillPrice: "0.1",
    feeAmountProvider: "0", feeAsset: "USDT", tradingFeeNetCostUsdt: "0", confirmedAt: at,
    priceCompleteness: "COMPLETE", feeCompleteness: "COMPLETE", integrityStatus: "VERIFIED",
    completeness: "COMPLETE", createdAt: at,
  };
}

function schedule(nextFundingTime: number) {
  return { legId: "perp", nextFundingTime, fundingIntervalHours: 8, authoritative: true } as const;
}

function funding(
  amount: string,
  attributionStatus: ArbitrageFundingFact["attributionStatus"],
  arbitrageId: string | null,
): ArbitrageFundingFact {
  return {
    providerFundingId: "funding-1", venue: "bybit", accountId: "account",
    instrumentId: "DOGE-USDT-PERP", positionSideOrBucket: "SHORT", settlementTime: settlement,
    providerPositionSize: "-68",
    amount, asset: "USDT", amountUsdt: amount, arbitrageId, attributionStatus, createdAt: settlement + 1,
    integrityStatus: "VERIFIED",
  };
}
