import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionIntent } from "./ExecutionIntent";
import { createExecutionState, transitionExecutionState } from "./ExecutionState";

const now = 1_800_000_000_000;

test("tracks the explicit execution lifecycle with immutable states", () => {
  const created = createExecutionState(executionIntent());
  const submitted = transitionExecutionState(created, { type: "SUBMISSION_STARTED", occurredAt: now + 1 });
  const pending = transitionExecutionState(submitted, { type: "SUBMISSION_ACCEPTED", occurredAt: now + 2 });
  const confirmed = transitionExecutionState(pending, { type: "REMOTE_CONFIRMED", occurredAt: now + 3 });

  assert.equal(created.status, "CREATED");
  assert.equal(submitted.status, "SUBMITTED");
  assert.equal(pending.status, "PENDING_CONFIRMATION");
  assert.equal(confirmed.status, "CONFIRMED");
  assert.equal(Object.isFrozen(confirmed), true);
});

test("a provider call anomaly becomes UNKNOWN instead of FAILED", () => {
  const submitted = transitionExecutionState(
    createExecutionState(executionIntent()),
    { type: "SUBMISSION_STARTED", occurredAt: now + 1 },
  );

  const unknown = transitionExecutionState(submitted, { type: "REMOTE_UNKNOWN", occurredAt: now + 2 });

  assert.equal(unknown.status, "UNKNOWN");
  assert.throws(
    () => transitionExecutionState(submitted, { type: "SUBMISSION_ACCEPTED", occurredAt: now }),
    /cannot move backwards/u,
  );
});

test("UNKNOWN can resolve only from an authoritative remote fact", () => {
  const submitted = transitionExecutionState(
    createExecutionState(executionIntent()),
    { type: "SUBMISSION_STARTED", occurredAt: now + 1 },
  );
  const unknown = transitionExecutionState(submitted, { type: "REMOTE_UNKNOWN", occurredAt: now + 2 });

  assert.equal(
    transitionExecutionState(unknown, { type: "REMOTE_CONFIRMED", occurredAt: now + 3 }).status,
    "CONFIRMED",
  );
  assert.equal(
    transitionExecutionState(unknown, { type: "REMOTE_FAILED", occurredAt: now + 3 }).status,
    "FAILED",
  );
});

test("future venue values are preserved in execution state", () => {
  const state = createExecutionState(executionIntent({ venue: "okx" }));
  assert.equal(state.venue, "okx");
});

function executionIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionIntent({
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    symbol: "XAUTUSDT",
    side: "buy",
    quantity: "0.002",
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  });
}
