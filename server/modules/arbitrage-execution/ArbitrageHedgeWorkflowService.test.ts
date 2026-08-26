import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import { deriveArbitrageHedgeWorkflow } from "./ArbitrageHedgeWorkflowService";

test("workflow snapshot is derived from immutable execution facts and distinguishes first-leg stop states", () => {
  assert.equal(deriveArbitrageHedgeWorkflow(instance([], "OPENING")).phase, "NOT_STARTED");

  const failedZero = deriveArbitrageHedgeWorkflow(instance([reference("FAILED", "0")]));
  assert.equal(failedZero.phase, "FIRST_LEG_FAILED_ZERO");
  assert.equal(failedZero.riskAction, "RESTART_HEDGE");

  const partial = deriveArbitrageHedgeWorkflow(instance([reference("FAILED", "40")]));
  assert.equal(partial.phase, "FIRST_LEG_PARTIAL");
  assert.equal(partial.riskAction, "CONTINUE_PARTIAL_HEDGE");
  assert.equal(partial.firstLeg?.requestedQuantity, "100");
  assert.equal(partial.firstLeg?.confirmedQuantity, "40");
  assert.equal(partial.firstLeg?.activeManagedQuantity, "40");

  const unknown = deriveArbitrageHedgeWorkflow(instance([reference("UNKNOWN", "40")]));
  assert.equal(unknown.phase, "FIRST_LEG_UNKNOWN");
  assert.equal(unknown.riskAction, "RECONCILE");

  const livePartial = deriveArbitrageHedgeWorkflow(instance([reference("PENDING_CONFIRMATION", "40")]));
  assert.equal(livePartial.phase, "FIRST_LEG_PENDING");
  assert.equal(livePartial.requiresUserAction, false);
});

test("second terminal partial stops as residual and full two-leg facts complete", () => {
  const partial = deriveArbitrageHedgeWorkflow(instance([
    reference("CONFIRMED", "100", "first", 1),
    reference("FAILED", "30", "second", 2),
  ], "RESIDUAL"));
  assert.equal(partial.phase, "SECOND_LEG_PARTIAL");
  assert.equal(partial.riskAction, "REVIEW_RESIDUAL");

  const completed = deriveArbitrageHedgeWorkflow(instance([
    reference("CONFIRMED", "100", "first", 1),
    reference("CONFIRMED", "100", "second", 2),
  ], "HOLDING"));
  assert.equal(completed.phase, "COMPLETED");
  assert.equal(completed.requiresUserAction, false);
});

function instance(
  executionReferences: ArbitrageInstance["executionReferences"],
  status: ArbitrageInstance["status"] = "RESIDUAL",
): ArbitrageInstance {
  return {
    arbitrageId: "arbitrage-1", userId: "user-a", strategyType: "SPOT_PERPETUAL", sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0", status, createdAt: 1, openedAt: null, updatedAt: 10, closedAt: null,
    legs: [
      { legId: "first", role: "LONG", venue: "binance", accountId: "a", instrumentId: "BTC-USDT-SPOT",
        plannedQuantity: "100", confirmedOpenedQuantity: executionReferences[0]?.confirmedQuantity ?? "0", confirmedClosedQuantity: "0" },
      { legId: "second", role: "SHORT", venue: "binance", accountId: "a", instrumentId: "BTC-USDT-PERP",
        plannedQuantity: "100", confirmedOpenedQuantity: executionReferences[1]?.confirmedQuantity ?? "0", confirmedClosedQuantity: "0" },
    ],
    executionReferences,
    managementReleases: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null,
      cumulativeNetPnl: null, updatedAt: null },
  };
}

function reference(
  status: ArbitrageInstance["executionReferences"][number]["status"],
  confirmedQuantity: string,
  legId = "first",
  createdAt = 1,
): ArbitrageInstance["executionReferences"][number] {
  return { arbitrageId: "arbitrage-1", legId, phase: "OPENING", quantityEffect: "INCREASE",
    executionIntentId: `intent-${legId}`, executionRecordId: `record-${legId}`, requestedQuantity: "100",
    confirmedQuantity, status, createdAt, updatedAt: createdAt + 1 };
}
