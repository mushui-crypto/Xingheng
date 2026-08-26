import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageLegVerificationResult } from "../cex/arbitrage-instance/ArbitragePositionVerification";
import { ArbitrageOpeningSafetyEvaluator } from "./ArbitrageOpeningSafetyEvaluator";

const now = 1_800_000_000_000;

test("ONE_WAY SHORT opening allows FLAT and same direction but rejects LONG and UNKNOWN for every venue", async () => {
  for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
    for (const scenario of [
      { signed: "0", status: "MATCHED", safe: true, reason: "ONE_WAY_FLAT" },
      { signed: "-30", status: "MATCHED", safe: true, reason: "ONE_WAY_SAME_DIRECTION" },
      { signed: "30", status: "MATCHED", safe: false, reason: "ONE_WAY_OPPOSITE_DIRECTION" },
      { signed: null, status: "UNKNOWN", safe: false, reason: "PROVIDER_REALITY_UNKNOWN" },
    ] as const) {
      const result = await evaluate("SHORT", verification({
        actualSignedNetQuantity: scenario.signed,
        verificationStatus: scenario.status,
        positionMode: scenario.status === "UNKNOWN" ? null : "ONE_WAY",
      }), venue);
      assert.equal(result.openingAttributionSafe, scenario.safe, `${venue}:${String(scenario.signed)}`);
      assert.equal(result.reason, scenario.reason, `${venue}:${String(scenario.signed)}`);
    }
  }
});

test("ONE_WAY LONG opening is exactly symmetric", async () => {
  for (const scenario of [
    { signed: "0", safe: true },
    { signed: "30", safe: true },
    { signed: "-30", safe: false },
  ] as const) {
    const result = await evaluate("LONG", verification({ actualSignedNetQuantity: scenario.signed }));
    assert.equal(result.openingAttributionSafe, scenario.safe, scenario.signed);
  }
});

test("HEDGE opening ignores the unrelated bucket for every venue", async () => {
  for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
    const instance = fixture("SHORT", venue);
    const verifier = {
      verify: async () => ({
        arbitrageId: instance.arbitrageId,
        checkedAt: now,
        legs: [verification({
          legId: "perp-leg",
          positionMode: "HEDGE",
          actualSignedNetQuantity: null,
          actualLongQuantity: "50",
          actualShortQuantity: "20",
        }), verification({ legId: "spot-leg" })] as const,
      }),
    };
    const [result] = await new ArbitrageOpeningSafetyEvaluator(verifier as never).evaluate("user-a", instance);
    assert.equal(result?.openingAttributionSafe, true, venue);
    assert.equal(result?.reason, "HEDGE_BUCKET_ISOLATED", venue);
  }
});

test("missing position mode fails closed", async () => {
  const result = await evaluate("SHORT", verification({
    positionMode: null,
    actualSignedNetQuantity: null,
    verificationStatus: "MATCHED",
  }));
  assert.equal(result.openingAttributionSafe, false);
  assert.equal(result.reason, "POSITION_MODE_UNKNOWN");
});

test("an explicitly shared UNKNOWN context fails closed without a fallback Provider read", async () => {
  const instance = fixture("SHORT", "binance");
  let reads = 0;
  const evaluator = new ArbitrageOpeningSafetyEvaluator({
    verify: async () => { reads += 1; throw new Error("must not refetch"); },
  } as never);

  const [result] = await evaluator.evaluate("user-a", instance, null);

  assert.equal(result?.openingAttributionSafe, false);
  assert.equal(result?.reason, "PROVIDER_REALITY_UNKNOWN");
  assert.equal(reads, 0);
});

async function evaluate(
  role: "LONG" | "SHORT",
  reality: ArbitrageLegVerificationResult,
  venue: "binance" | "okx" | "bybit" | "bitget" = "binance",
) {
  const instance = fixture(role, venue);
  const verifier = {
    verify: async () => ({
      arbitrageId: instance.arbitrageId,
      checkedAt: now,
      legs: [reality, verification({ legId: "spot-leg" })] as const,
    }),
  };
  const [result] = await new ArbitrageOpeningSafetyEvaluator(verifier as never).evaluate("user-a", instance);
  assert.ok(result);
  return result;
}

function verification(overrides: Partial<ArbitrageLegVerificationResult> = {}): ArbitrageLegVerificationResult {
  return {
    arbitrageId: "arb-1",
    legId: "perp-leg",
    expectedManagedQuantity: "0",
    actualQuantity: "0",
    actualSignedNetQuantity: "0",
    positionMode: "ONE_WAY",
    actualLongQuantity: "0",
    actualShortQuantity: "0",
    availableQuantity: null,
    verificationStatus: "MATCHED",
    reason: null,
    checkedAt: now,
    ...overrides,
  };
}

function fixture(role: "LONG" | "SHORT", venue: "binance" | "okx" | "bybit" | "bitget"): ArbitrageInstance {
  return {
    arbitrageId: "arb-1",
    userId: "user-a",
    strategyType: "SPOT_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0",
    status: "OPENING",
    createdAt: now,
    openedAt: null,
    updatedAt: now,
    closedAt: null,
    legs: [
      { legId: "perp-leg", role, venue, accountId: `${venue}:account-a`, instrumentId: "BTC-USDT-PERP", plannedQuantity: "100", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" },
      { legId: "spot-leg", role: "LONG", venue, accountId: `${venue}:account-a`, instrumentId: "BTC-USDT-SPOT", plannedQuantity: "100", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" },
    ],
    executionReferences: [],
    managementReleases: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}
