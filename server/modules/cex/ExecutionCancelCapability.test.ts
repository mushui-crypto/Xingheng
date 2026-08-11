import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionRecord } from "./ExecutionRecord";
import {
  applyExecutionCancelObservation,
  createExecutionCancelObservation,
} from "./ExecutionCancelCapability";

const now = 1_800_000_000_000;

test("CANCELLED makes a pending execution terminal without adding a cancel state to ExecutionState", () => {
  const updated = applyExecutionCancelObservation(executionRecord(), {
    state: "CANCELLED",
    observedAt: now + 1_000,
  });

  assert.equal(updated.status, "FAILED");
  assert.equal("cancelState" in updated, false);
});

test("CANCEL_REQUESTED and UNKNOWN preserve an UNKNOWN execution", () => {
  for (const state of ["CANCEL_REQUESTED", "UNKNOWN"] as const) {
    const updated = applyExecutionCancelObservation(
      executionRecord({ status: "UNKNOWN" }),
      createExecutionCancelObservation({ state, observedAt: now + 1_000 }),
    );
    assert.equal(updated.status, "UNKNOWN");
  }
});

test("rejects cancellation updates for confirmed and failed records", () => {
  for (const status of ["CONFIRMED", "FAILED"] as const) {
    assert.throws(
      () => applyExecutionCancelObservation(
        executionRecord({ status }),
        { state: "CANCELLED", observedAt: now + 1_000 },
      ),
      /cannot accept cancellation/u,
    );
  }
});

function executionRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionRecord({
    executionId: "execution-1",
    intentId: "intent-1",
    executionAttemptId: "intent-1",
    remoteOrderId: "binance-order-1",
    userId: "user-a",
    venue: "binance",
    accountId: "binance:account-user-a",
    instrumentId: "XAUT-USDT-PERP",
    status: "PENDING_CONFIRMATION",
    createdAt: now - 1_000,
    updatedAt: now,
    ...overrides,
  });
}
