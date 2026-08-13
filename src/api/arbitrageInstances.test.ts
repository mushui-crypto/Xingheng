import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchActiveArbitrageInstances,
  fetchArbitrageInstanceHistory,
  fetchArbitragePositionVerification,
  requireArbitrageInstanceList,
} from "./arbitrageInstances";

test("arbitrage instance API uses active and paginated history query boundaries", async () => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return Response.json([arbitrageInstance("OPENING")]);
  };
  try {
    await fetchActiveArbitrageInstances();
    await fetchArbitrageInstanceHistory(2, 50);
    assert.deepEqual(requested, [
      "/api/arbitrage-instances/active",
      "/api/arbitrage-instances/history?page=2&limit=50",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verification API maps decimal strings and preserves unknown actual quantity as null", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "/api/arbitrage-instances/arbitrage%2Fholding/verification");
    return Response.json({
      arbitrageId: "arbitrage/holding",
      checkedAt: 1_800_000_004_000,
      legs: [
        { arbitrageId: "arbitrage/holding", legId: "long-leg", expectedManagedQuantity: "0.3", actualQuantity: "0.3", verificationStatus: "MATCHED", checkedAt: 1_800_000_004_000 },
        { arbitrageId: "arbitrage/holding", legId: "short-leg", expectedManagedQuantity: "0.3", actualQuantity: null, verificationStatus: "UNKNOWN", checkedAt: 1_800_000_004_000 },
      ],
    });
  };
  try {
    const result = await fetchArbitragePositionVerification("arbitrage/holding");
    assert.equal(result.legs[0].expectedManagedQuantity, "0.3");
    assert.equal(result.legs[1].actualQuantity, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("arbitrage response preserves the authoritative instance without inferred market fields", () => {
  const [instance] = requireArbitrageInstanceList([{
    ...arbitrageInstance("HOLDING"),
    currentPrice: 123,
    apr: 9.9,
    position: { quantity: "1" },
  }]);

  assert.equal(instance?.status, "HOLDING");
  assert.deepEqual(instance?.legs.map(({ role }) => role), ["LONG", "SHORT"]);
  assert.equal("currentPrice" in instance!, false);
  assert.equal("apr" in instance!, false);
  assert.equal("position" in instance!, false);
});

export function arbitrageInstance(status: string) {
  const terminal = status === "CLOSED" || status === "FAILED";
  return {
    arbitrageId: `arbitrage-${status.toLowerCase()}`,
    userId: "user-a",
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0.001",
    status,
    createdAt: 1_800_000_000_000,
    openedAt: status === "OPENING" || status === "FAILED" ? null : 1_800_000_001_000,
    updatedAt: 1_800_000_002_000,
    closedAt: terminal ? 1_800_000_003_000 : null,
    legs: [
      {
        legId: "long-leg",
        role: "LONG",
        venue: "okx",
        accountId: "okx:private-account-1234",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
        confirmedOpenedQuantity: "1",
        confirmedClosedQuantity: terminal ? "1" : "0",
      },
      {
        legId: "short-leg",
        role: "SHORT",
        venue: "binance",
        accountId: "binance:private-account-5678",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
        confirmedOpenedQuantity: "1",
        confirmedClosedQuantity: terminal ? "1" : "0",
      },
    ],
    executionReferences: [],
    pnl: {
      asset: null,
      cumulativeFundingPnl: null,
      realizedTradingPnl: null,
      feesCosts: null,
      cumulativeNetPnl: null,
      updatedAt: null,
    },
  };
}
