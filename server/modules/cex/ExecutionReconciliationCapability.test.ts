import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionRecord } from "./ExecutionRecord";
import {
  applyExecutionReconciliationObservation,
  createExecutionReconciliationObservation,
  type ExecutionReconciliationCapability,
} from "./ExecutionReconciliationCapability";

const now = 1_800_000_000_000;

test("reconciliation reuses query observation semantics without storing filled quantity", async () => {
  const capability: ExecutionReconciliationCapability = {
    async reconcile() {
      return createExecutionReconciliationObservation({
        state: "PENDING_CONFIRMATION",
        filledBaseQuantity: "0.0015",
        observedAt: now + 1_000,
      });
    },
  };
  const record = executionRecord();
  const observation = await capability.reconcile(record);
  const updated = applyExecutionReconciliationObservation(record, observation);

  assert.equal(updated.status, "PENDING_CONFIRMATION");
  assert.equal(observation.filledBaseQuantity, "0.0015");
  assert.equal("filledBaseQuantity" in updated, false);
});

test("reconciliation preserves UNKNOWN instead of converting it to FAILED", () => {
  const record = executionRecord({ status: "UNKNOWN" });
  const updated = applyExecutionReconciliationObservation(record, {
    state: "UNKNOWN",
    filledBaseQuantity: "0",
    observedAt: now + 1_000,
  });

  assert.equal(updated.status, "UNKNOWN");
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
    status: "UNKNOWN",
    createdAt: now - 1_000,
    updatedAt: now,
    ...overrides,
  });
}
