import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionIntent } from "./ExecutionIntent";
import {
  attachExecutionAttempt,
  createExecutionRecord,
  createExecutionRecordFromIntent,
  syncExecutionRecordState,
} from "./ExecutionRecord";
import { createExecutionState, transitionExecutionState } from "./ExecutionState";

const now = 1_800_000_000_000;

test("associates an ExecutionIntent with an ExecutionRecord", () => {
  const intent = executionIntent();
  const record = createExecutionRecordFromIntent("execution-1", intent);

  assert.deepEqual(record, {
    executionId: "execution-1",
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    symbol: "XAUTUSDT",
    status: "CREATED",
    createdAt: now,
    updatedAt: now,
  });
  assert.equal(Object.isFrozen(record), true);
});

test("tracks execution attempt and remote order reference without order details", () => {
  const record = attachExecutionAttempt(
    createExecutionRecordFromIntent("execution-1", executionIntent()),
    {
      executionAttemptId: "attempt-1",
      remoteOrderId: "binance-order-1",
      status: "SUBMITTED",
      observedAt: now + 1_000,
    },
  );

  assert.equal(record.executionAttemptId, "attempt-1");
  assert.equal(record.remoteOrderId, "binance-order-1");
  assert.equal(record.status, "SUBMITTED");
  assert.deepEqual(Object.keys(record).sort(), [
    "accountId",
    "createdAt",
    "executionAttemptId",
    "executionId",
    "intentId",
    "remoteOrderId",
    "status",
    "symbol",
    "updatedAt",
    "userId",
    "venue",
  ]);
});

test("keeps status flow aligned with ExecutionState", () => {
  const intent = executionIntent();
  const record = createExecutionRecordFromIntent("execution-1", intent);
  const submittedState = transitionExecutionState(createExecutionState(intent), {
    type: "SUBMISSION_STARTED",
    occurredAt: now + 100,
  });
  const pendingState = transitionExecutionState(submittedState, {
    type: "SUBMISSION_ACCEPTED",
    occurredAt: now + 200,
  });

  const synced = syncExecutionRecordState(record, pendingState);

  assert.equal(synced.status, "PENDING_CONFIRMATION");
  assert.equal(synced.updatedAt, now + 200);
});

test("preserves UNKNOWN instead of forcing failed", () => {
  const intent = executionIntent();
  const pendingState = transitionExecutionState(
    transitionExecutionState(createExecutionState(intent), {
      type: "SUBMISSION_STARTED",
      occurredAt: now + 100,
    }),
    {
      type: "SUBMISSION_ACCEPTED",
      occurredAt: now + 200,
    },
  );
  const unknownState = transitionExecutionState(pendingState, {
    type: "REMOTE_UNKNOWN",
    occurredAt: now + 300,
  });

  const synced = syncExecutionRecordState(
    createExecutionRecordFromIntent("execution-1", intent),
    unknownState,
  );

  assert.equal(synced.status, "UNKNOWN");
});

test("supports all execution venues with the same record model", () => {
  const venues = ["binance", "okx", "bybit", "bitget"] as const;

  for (const venue of venues) {
    const record = createExecutionRecordFromIntent(
      `execution-${venue}`,
      executionIntent({
        venue,
        accountId: `${venue}:account-1`,
        symbol: venue === "okx" ? "XAUTUSDT" : "BTCUSDT",
      }),
    );
    assert.equal(record.venue, venue);
    assert.equal(record.status, "CREATED");
  }
});

test("rejects order-manager, fill, fee, strategy, and order-book fields", () => {
  const base = {
    executionId: "execution-1",
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    symbol: "XAUTUSDT",
    status: "CREATED",
    createdAt: now,
    updatedAt: now,
  };

  for (const field of ["fills", "trades", "fee", "orderBook", "strategyData", "clientOrderRequest"]) {
    assert.throws(() => createExecutionRecord({ ...base, [field]: [] }), new RegExp(`unsupported field: ${field}`, "u"));
  }

  const source = readFileSync(new URL("./ExecutionRecord.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /OrderManager|RiskGuard|BinanceClient|fetch\(|placeOrder|cancelOrder/u);
  assert.doesNotMatch(source, /fills|trades|fee|orderBook|strategyData|retry|scheduler|worker|repair/iu);
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
