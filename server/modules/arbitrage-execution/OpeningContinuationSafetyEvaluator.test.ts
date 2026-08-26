import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageLegVerificationResult } from "../cex/arbitrage-instance/ArbitragePositionVerification";
import { OpeningContinuationSafetyEvaluator } from "./OpeningContinuationSafetyEvaluator";

const now = 1_800_000_000_000;

test("Spot continuation uses total Account Reality, not available or unrelated sizing", async () => {
  for (const scenario of [
    { total: "100", available: "0", status: "SUPPORTED" },
    { total: "0", available: "100", status: "UNSUPPORTED" },
    { total: "500", available: "0", status: "SUPPORTED" },
  ] as const) {
    const instance = fixture("BTC-USDT-SPOT", "LONG");
    const result = await evaluator(instance, verification(instance, {
      actualQuantity: scenario.total,
      availableQuantity: scenario.available,
      actualSignedNetQuantity: scenario.total,
    })).evaluate("user-a", instance, "first-intent");
    assert.equal(result.status, scenario.status);
    assert.equal(result.activeAttributedExposure, "100");
  }
});

test("ONE_WAY continuation requires the confirmed direction and full quantity", async () => {
  for (const scenario of [
    { net: "-100", status: "SUPPORTED" },
    { net: "-20", status: "UNSUPPORTED" },
    { net: "20", status: "UNSUPPORTED" },
  ] as const) {
    const instance = fixture("BTC-USDT-PERP", "SHORT");
    const result = await evaluator(instance, verification(instance, {
      actualQuantity: scenario.net.replace("-", ""),
      actualSignedNetQuantity: scenario.net,
    })).evaluate("user-a", instance, "first-intent");
    assert.equal(result.status, scenario.status);
  }
});

test("HEDGE continuation reads only the first-leg target bucket and fails UNKNOWN closed", async () => {
  const instance = fixture("BTC-USDT-PERP", "SHORT");
  const supported = await evaluator(instance, verification(instance, {
    positionMode: "HEDGE",
    actualQuantity: "100",
    actualSignedNetQuantity: null,
    actualLongQuantity: "100",
    actualShortQuantity: "100",
  })).evaluate("user-a", instance, "first-intent");
  assert.equal(supported.status, "SUPPORTED");

  const missingBucket = await evaluator(instance, verification(instance, {
    positionMode: "HEDGE",
    actualQuantity: "0",
    actualSignedNetQuantity: null,
    actualLongQuantity: "100",
    actualShortQuantity: "0",
  })).evaluate("user-a", instance, "first-intent");
  assert.equal(missingBucket.status, "UNSUPPORTED");

  const unknown = await evaluator(instance, verification(instance, { verificationStatus: "UNKNOWN",
    positionMode: null, actualQuantity: null, actualSignedNetQuantity: null,
    actualLongQuantity: null, actualShortQuantity: null })).evaluate("user-a", instance, "first-intent");
  assert.equal(unknown.status, "UNKNOWN");
});

test("authoritative terminal partial is eligible for the same fresh Reality safety evaluation", async () => {
  const base = fixture("BTC-USDT-PERP", "SHORT");
  const instance: ArbitrageInstance = { ...base,
    executionReferences: [{ ...base.executionReferences[0]!, status: "FAILED",
      requestedQuantity: "100", confirmedQuantity: "40" }],
    legs: [{ ...base.legs[0], confirmedOpenedQuantity: "40" }, base.legs[1]],
  };
  const result = await evaluator(instance, verification(instance, {
    expectedManagedQuantity: "40", actualQuantity: "40", actualSignedNetQuantity: "-40",
    actualLongQuantity: "0", actualShortQuantity: "40",
  })).evaluate("user-a", instance, "first-intent");
  assert.equal(result.status, "SUPPORTED");
  assert.equal(result.activeAttributedExposure, "40");
});

test("an explicitly shared UNKNOWN context blocks continuation without a fallback Provider read", async () => {
  const instance = fixture("BTC-USDT-SPOT", "LONG");
  let reads = 0;
  const subject = new OpeningContinuationSafetyEvaluator({
    verify: async () => { reads += 1; throw new Error("must not refetch"); },
  } as never);

  const result = await subject.evaluate(
    "user-a",
    instance,
    "first-intent",
    null,
  );

  assert.equal(result.status, "UNKNOWN");
  assert.equal(reads, 0);
});

function evaluator(instance: ArbitrageInstance, first: ArbitrageLegVerificationResult) {
  return new OpeningContinuationSafetyEvaluator({
    verify: async () => ({ arbitrageId: instance.arbitrageId, checkedAt: now,
      legs: [first, verification(instance, {}, "second-leg")] }),
  } as never);
}

function fixture(instrumentId: string, role: "LONG" | "SHORT"): ArbitrageInstance {
  return {
    arbitrageId: "arbitrage-1", userId: "user-a", strategyType: "SPOT_PERPETUAL", sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0", status: "RESIDUAL", createdAt: now - 10, openedAt: null, updatedAt: now,
    closedAt: null,
    legs: [
      { legId: "first-leg", role, venue: "binance", accountId: "account-a", instrumentId,
        plannedQuantity: "100", confirmedOpenedQuantity: "100", confirmedClosedQuantity: "0" },
      { legId: "second-leg", role: role === "LONG" ? "SHORT" : "LONG", venue: "binance", accountId: "account-a",
        instrumentId: instrumentId.endsWith("-SPOT") ? "BTC-USDT-PERP" : "BTC-USDT-SPOT",
        plannedQuantity: "100", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" },
    ],
    executionReferences: [{ arbitrageId: "arbitrage-1", legId: "first-leg", phase: "OPENING", quantityEffect: "INCREASE",
      executionIntentId: "first-intent", executionRecordId: "first-record", requestedQuantity: "100",
      confirmedQuantity: "100", status: "CONFIRMED", createdAt: now - 5, updatedAt: now - 4 }],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null,
      cumulativeNetPnl: null, updatedAt: null },
  };
}

function verification(
  instance: ArbitrageInstance,
  overrides: Partial<ArbitrageLegVerificationResult>,
  legId = "first-leg",
): ArbitrageLegVerificationResult {
  return {
    arbitrageId: instance.arbitrageId, legId, expectedManagedQuantity: legId === "first-leg" ? "100" : "0",
    actualQuantity: "100", actualSignedNetQuantity: "100", positionMode: "ONE_WAY",
    actualLongQuantity: "100", actualShortQuantity: "0", availableQuantity: null,
    verificationStatus: "MATCHED", reason: null, checkedAt: now, ...overrides,
  };
}
