import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionQueryObservation, applyExecutionQueryObservation } from "./ExecutionQueryCapability";
import { createExecutionRecord } from "./ExecutionRecord";

const now = 1_800_000_000_000;

test("applies a pending query observation without storing filled quantity", () => {
  const record = executionRecord({ status: "UNKNOWN" });
  const observation = createExecutionQueryObservation({
    state: "PENDING_CONFIRMATION",
    filledBaseQuantity: "0.0015",
    observedAt: now + 1_000,
  });

  const updated = applyExecutionQueryObservation(record, observation);

  assert.equal(updated.status, "PENDING_CONFIRMATION");
  assert.equal(updated.updatedAt, now + 1_000);
  assert.equal("filledBaseQuantity" in updated, false);
  assert.equal(observation.filledBaseQuantity, "0.0015");
});

test("preserves repeated UNKNOWN observations instead of forcing failure", () => {
  const updated = applyExecutionQueryObservation(
    executionRecord({ status: "UNKNOWN" }),
    createExecutionQueryObservation({ state: "UNKNOWN", filledBaseQuantity: "0", observedAt: now + 1_000 }),
  );

  assert.equal(updated.status, "UNKNOWN");
  assert.equal(updated.updatedAt, now + 1_000);
});

test("rejects invalid query observations and backwards time", () => {
  assert.throws(
    () => createExecutionQueryObservation({ state: "FILLED", filledBaseQuantity: "0", observedAt: now }),
    /state is invalid/u,
  );
  assert.throws(
    () => createExecutionQueryObservation({ state: "UNKNOWN", filledBaseQuantity: 0.1, observedAt: now }),
    /unsigned decimal string/u,
  );
  assert.throws(
    () => applyExecutionQueryObservation(
      executionRecord(),
      createExecutionQueryObservation({ state: "UNKNOWN", filledBaseQuantity: "0", observedAt: now - 1 }),
    ),
    /cannot move record time backwards/u,
  );
});

function executionRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionRecord({
    executionId: "execution-1",
    intentId: "intent-user-1",
    executionAttemptId: "intent-user-1",
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
