import assert from "node:assert/strict";
import test from "node:test";
import type { PerpetualPerpetualFundingArbitrageExecutionIntent } from "./FundingArbitrageExecutionIntent";
import {
  createFundingArbitrageExecutionState,
  updateFundingArbitrageLegExecution,
} from "./FundingArbitrageExecutionState";

const now = 1_800_000_000_000;

test("creates an in-memory state from an intent and initializes both legs", () => {
  const intent = perpetualIntent();
  const state = createFundingArbitrageExecutionState(intent, now);

  assert.equal(state.intentId, intent.intentId);
  assert.equal(state.sourcePlanId, intent.sourcePlanId);
  assert.equal(state.status, "CREATED");
  assert.equal(state.legs.length, 2);
  for (const index of [0, 1] as const) {
    assert.equal(state.legs[index].legId, intent.legs[index].legId);
    assert.equal(state.legs[index].intentId, intent.intentId);
    assert.equal(state.legs[index].plannedQuantity, "0.12");
    assert.equal(state.legs[index].confirmedExecutedQuantity, "0");
    assert.equal(state.legs[index].remainingQuantity, "0.12");
    assert.equal(state.legs[index].status, "NOT_STARTED");
    assert.equal(state.legs[index].remoteObservation, null);
  }
  assert.deepEqual(state.residualExposure.executedQuantity, { long: "0", short: "0" });
  assert.equal(state.residualExposure.residualQuantity, "0");
});

test("updates confirmed quantities without mutating the prior state and reports residual exposure", () => {
  const initial = createFundingArbitrageExecutionState(perpetualIntent(), now);
  const updated = updateFundingArbitrageLegExecution(initial, {
    legId: initial.legs[0].legId,
    confirmedExecutedQuantity: "0.07000000",
    status: "ACTIVE",
    remoteObservation: "OPEN",
    observedAt: now + 1,
  });

  assert.equal(initial.legs[0].confirmedExecutedQuantity, "0");
  assert.equal(updated.legs[0].confirmedExecutedQuantity, "0.07");
  assert.equal(updated.legs[0].remainingQuantity, "0.05");
  assert.equal(updated.residualExposure.residualQuantity, "0.07");
  assert.equal(updated.residualExposure.calculatedAt, now + 1);
  assert.equal(updated.status, "RESIDUAL");
});

test("marks the aggregate HEDGED only from equal confirmed completed quantities", () => {
  const initial = createFundingArbitrageExecutionState(perpetualIntent(), now);
  const longFilled = updateFundingArbitrageLegExecution(initial, {
    legId: initial.legs[0].legId,
    confirmedExecutedQuantity: "0.12",
    status: "TERMINAL",
    remoteObservation: "FILLED",
    observedAt: now + 1,
  });
  assert.equal(longFilled.status, "RESIDUAL");

  const hedged = updateFundingArbitrageLegExecution(longFilled, {
    legId: initial.legs[1].legId,
    confirmedExecutedQuantity: "0.120000",
    status: "TERMINAL",
    remoteObservation: "FILLED",
    observedAt: now + 2,
  });
  assert.equal(hedged.status, "HEDGED");
  assert.equal(hedged.residualExposure.residualQuantity, "0");
  assert.equal(hedged.legs[0].remainingQuantity, "0");
  assert.equal(hedged.legs[1].remainingQuantity, "0");
});

test("does not mark equal confirmed quantities HEDGED while a leg remains OPEN", () => {
  const initial = createFundingArbitrageExecutionState(perpetualIntent(), now);
  const longFilled = updateFundingArbitrageLegExecution(initial, {
    legId: initial.legs[0].legId,
    confirmedExecutedQuantity: "0.12",
    status: "TERMINAL",
    remoteObservation: "FILLED",
    observedAt: now + 1,
  });
  const stillOpen = updateFundingArbitrageLegExecution(longFilled, {
    legId: initial.legs[1].legId,
    confirmedExecutedQuantity: "0.12",
    status: "ACTIVE",
    remoteObservation: "OPEN",
    observedAt: now + 2,
  });

  assert.equal(stillOpen.residualExposure.residualQuantity, "0");
  assert.equal(stillOpen.legs[1].remainingQuantity, "0");
  assert.equal(stillOpen.status, "EXECUTING");
});

test("keeps unknown remote state pending reconciliation instead of failing", () => {
  const initial = createFundingArbitrageExecutionState(perpetualIntent(), now);
  const pending = updateFundingArbitrageLegExecution(initial, {
    legId: initial.legs[0].legId,
    confirmedExecutedQuantity: "0",
    status: "PENDING_RECONCILIATION",
    remoteObservation: "UNKNOWN_REMOTE_STATE",
    observedAt: now + 1,
  });

  assert.equal(pending.status, "PENDING_RECONCILIATION");
  assert.notEqual(pending.status, "FAILED");
  assert.equal(pending.legs[0].remoteObservation, "UNKNOWN_REMOTE_STATE");
});

test("rejects long, short, and equal two-leg overfill observations", () => {
  const initial = createFundingArbitrageExecutionState(perpetualIntent(), now);
  assert.throws(
    () => updateFundingArbitrageLegExecution(initial, {
      legId: initial.legs[0].legId,
      confirmedExecutedQuantity: "0.121",
      status: "TERMINAL",
      remoteObservation: "FILLED",
      observedAt: now + 1,
    }),
    /cannot exceed the planned quantity/u,
  );
  assert.throws(
    () => updateFundingArbitrageLegExecution(initial, {
      legId: initial.legs[1].legId,
      confirmedExecutedQuantity: "0.121",
      status: "TERMINAL",
      remoteObservation: "FILLED",
      observedAt: now + 1,
    }),
    /cannot exceed the planned quantity/u,
  );
  for (const leg of initial.legs) {
    assert.throws(
      () => updateFundingArbitrageLegExecution(initial, {
        legId: leg.legId,
        confirmedExecutedQuantity: "0.13",
        status: "TERMINAL",
        remoteObservation: "FILLED",
        observedAt: now + 1,
      }),
      /cannot exceed the planned quantity/u,
    );
  }
  assert.equal(initial.status, "CREATED");
  assert.deepEqual(initial.residualExposure.executedQuantity, { long: "0", short: "0" });
});

test("rejects non-decimal, signed, numeric, and non-positive planned quantities", () => {
  const intent = perpetualIntent();
  for (const invalid of ["1e-3", "-0.1", ".1", "01.0", 0.1] as unknown[]) {
    const invalidIntent = {
      ...intent,
      legs: [{ ...intent.legs[0], targetDeltaBaseQuantity: invalid }, intent.legs[1]],
    } as unknown as PerpetualPerpetualFundingArbitrageExecutionIntent;
    assert.throws(() => createFundingArbitrageExecutionState(invalidIntent, now), /decimal strings/u);
  }
  const zeroIntent = {
    ...intent,
    legs: [{ ...intent.legs[0], targetDeltaBaseQuantity: "0" }, intent.legs[1]],
  } as PerpetualPerpetualFundingArbitrageExecutionIntent;
  assert.throws(() => createFundingArbitrageExecutionState(zeroIntent, now), /must be positive/u);
});

test("state contains no order, provider, credential, API, or persistence fields", () => {
  const state = createFundingArbitrageExecutionState(perpetualIntent(), now);
  const forbiddenFields = new Set([
    "orderId",
    "clientOrderId",
    "providerSymbol",
    "credential",
    "api",
    "storage",
    "accountId",
  ]);
  for (const key of collectKeys(state)) {
    assert.equal(forbiddenFields.has(key), false, `unexpected execution-bound field: ${key}`);
  }
});

function perpetualIntent(): PerpetualPerpetualFundingArbitrageExecutionIntent {
  return {
    intentId: "intent-phase-6a",
    sourcePlanId: "plan-phase-5",
    strategyType: "PERPETUAL_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt: now - 1_000,
    expiresAt: now + 60_000,
    constraints: { maxResidualBaseQuantity: "0.001" },
    legs: [
      {
        legId: "leg-long",
        role: "long",
        venue: "binance",
        instrumentId: "binance:perpetual:linear:BTC:USDT:USDT",
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.1200",
      },
      {
        legId: "leg-short",
        role: "short",
        venue: "okx",
        instrumentId: "okx:perpetual:linear:BTC:USDT:USDT",
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.12",
      },
    ],
  };
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}
