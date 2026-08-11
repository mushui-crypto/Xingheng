import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ExecutionStateReconciliation, type RemoteExecutionState } from "./ExecutionReconciliation";
import { createExecutionIntent } from "./ExecutionIntent";
import { createExecutionState, transitionExecutionState } from "./ExecutionState";

const now = 1_800_000_000_000;

test("matching local and remote states reconcile as CONFIRMED", () => {
  const local = confirmedLocalState();
  const result = new ExecutionStateReconciliation().reconcile(local, remoteState("CONFIRMED"));

  assert.deepEqual(result, {
    intentId: "intent-user-1",
    status: "CONFIRMED",
    localStatus: "CONFIRMED",
    remoteStatus: "CONFIRMED",
    reconciledAt: now + 4,
  });
  assert.equal(Object.isFrozen(result), true);
});

test("different local and remote states reconcile as UNKNOWN", () => {
  const local = confirmedLocalState();
  const result = new ExecutionStateReconciliation().reconcile(local, remoteState("FAILED"));

  assert.equal(result.status, "UNKNOWN");
});

test("unknown or mismatched remote identity cannot confirm consistency", () => {
  const local = confirmedLocalState();
  const unknown = new ExecutionStateReconciliation().reconcile(local, remoteState("UNKNOWN"));
  const wrongAccount = new ExecutionStateReconciliation().reconcile(local, {
    ...remoteState("CONFIRMED"),
    accountId: "okx:another-account",
  });

  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(wrongAccount.status, "UNKNOWN");
});

test("a stale remote observation cannot confirm current local state", () => {
  const local = confirmedLocalState();
  const stale = new ExecutionStateReconciliation().reconcile(local, {
    ...remoteState("CONFIRMED"),
    observedAt: now + 2,
  });

  assert.equal(stale.status, "UNKNOWN");
});

test("reconciliation boundary is pure and has no execution or provider dependency", () => {
  const source = readFileSync(new URL("./ExecutionReconciliation.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Binance|OrderManager|RiskGuard|Client|placeOrder|cancelOrder|fetch\(/u);
  assert.doesNotMatch(source, /retry|setInterval|setTimeout|cron|queue/iu);
});

function confirmedLocalState() {
  const created = createExecutionState(createExecutionIntent({
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
  }));
  const submitted = transitionExecutionState(created, { type: "SUBMISSION_STARTED", occurredAt: now + 1 });
  const pending = transitionExecutionState(submitted, { type: "SUBMISSION_ACCEPTED", occurredAt: now + 2 });
  return transitionExecutionState(pending, { type: "REMOTE_CONFIRMED", occurredAt: now + 3 });
}

function remoteState(status: RemoteExecutionState["status"]): RemoteExecutionState {
  return {
    intentId: "intent-user-1",
    venue: "binance",
    accountId: "binance:account-1",
    symbol: "XAUTUSDT",
    status,
    observedAt: now + 4,
  };
}
