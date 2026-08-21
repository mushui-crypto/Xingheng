import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ExecutionPreMutationFailure } from "./ExecutionCapability";
import { ExecutionCoordinator } from "./ExecutionCoordinator";
import { createExecutionIntent, type ExecutionIntent } from "./ExecutionIntent";

const now = 1_800_000_000_000;

test("accepts an ExecutionIntent and calls the explicit capability once", async () => {
  const capability = new MockExecutionCapability();
  const coordinator = new ExecutionCoordinator(capability, () => now);
  const intent = executionIntent();

  await coordinator.execute(intent);

  assert.equal(capability.calls.length, 1);
  assert.deepEqual(capability.calls[0], intent);
});

test("passes the explicit arbitrage association through without interpreting the leg", async () => {
  const capability = new MockExecutionCapability();
  const coordinator = new ExecutionCoordinator(capability, () => now);
  const intent = executionIntent({ arbitrageId: "arbitrage-1", legId: "leg-short", side: "sell" });

  const coordinated = await coordinator.execute(intent);

  assert.equal(capability.calls[0]?.arbitrageId, "arbitrage-1");
  assert.equal(capability.calls[0]?.legId, "leg-short");
  assert.equal(coordinated.arbitrageId, "arbitrage-1");
  assert.equal(coordinated.legId, "leg-short");
});

test("returns the successful capability result", async () => {
  const capability = new MockExecutionCapability();
  const coordinator = new ExecutionCoordinator(capability, () => now);

  const coordinated = await coordinator.execute(executionIntent());

  assert.deepEqual(coordinated, {
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    status: "SUCCEEDED",
    executionState: {
      intentId: "intent-user-1",
      userId: "user-1",
      venue: "binance",
      accountId: "binance:account-1",
      instrumentId: "XAUT-USDT-PERP",
      status: "PENDING_CONFIRMATION",
      createdAt: now,
      updatedAt: now,
    },
    step: {
      stepId: "execution-capability",
      status: "SUCCEEDED",
      result: { executionAttemptId: "attempt-1" },
    },
  });
  assert.equal(Object.isFrozen(coordinated), true);
  assert.equal(Object.isFrozen(coordinated.executionState), true);
  assert.equal(Object.isFrozen(coordinated.step), true);
});

test("supports a future venue without changing the coordinator boundary", async () => {
  const capability = new MockExecutionCapability();
  const coordinator = new ExecutionCoordinator(capability, () => now);

  const coordinated = await coordinator.execute(executionIntent({ venue: "okx" }));

  assert.equal(coordinated.venue, "okx");
  assert.equal(coordinated.executionState.venue, "okx");
});

test("supports Binance, OKX, and Bitget through the same public capability boundary", async () => {
  const coordinator = new ExecutionCoordinator(new MockExecutionCapability(), () => now);
  const binance = await coordinator.execute(executionIntent({ venue: "binance" }));
  const okx = await coordinator.execute(executionIntent({ venue: "okx" }));
  const bybit = await coordinator.execute(executionIntent({ venue: "bybit" }));
  const bitget = await coordinator.execute(executionIntent({ venue: "bitget" }));

  assert.equal(binance.status, "SUCCEEDED");
  assert.equal(okx.status, "SUCCEEDED");
  assert.equal(bybit.status, "SUCCEEDED");
  assert.equal(bitget.status, "SUCCEEDED");
  assert.equal(binance.executionState.venue, "binance");
  assert.equal(okx.executionState.venue, "okx");
  assert.equal(bybit.executionState.venue, "bybit");
  assert.equal(bitget.executionState.venue, "bitget");
});

test("propagates resolved remote execution states from capability results", async () => {
  const confirmed = await new ExecutionCoordinator(
    new MockExecutionCapability({ state: "CONFIRMED" }),
    () => now,
  ).execute(executionIntent());
  const failed = await new ExecutionCoordinator(
    new MockExecutionCapability({ state: "FAILED" }),
    () => now,
  ).execute(executionIntent());
  const unknown = await new ExecutionCoordinator(
    new MockExecutionCapability({ state: "UNKNOWN" }),
    () => now,
  ).execute(executionIntent());

  assert.equal(confirmed.status, "SUCCEEDED");
  assert.equal(confirmed.executionState.status, "CONFIRMED");
  assert.equal(failed.status, "REMOTE_FAILED");
  assert.equal(failed.executionState.status, "FAILED");
  assert.equal(unknown.status, "REMOTE_UNKNOWN");
  assert.equal(unknown.executionState.status, "UNKNOWN");
});

test("reports a capability call failure without retrying or asserting provider failure", async () => {
  const capability = new MockExecutionCapability();
  const failure = new Error("provider state is unknown");
  capability.failure = failure;
  const coordinator = new ExecutionCoordinator(capability, () => now);

  const coordinated = await coordinator.execute(executionIntent());

  assert.equal(capability.calls.length, 1);
  assert.deepEqual(coordinated, {
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    status: "CALL_FAILED",
    executionState: {
      intentId: "intent-user-1",
      userId: "user-1",
      venue: "binance",
      accountId: "binance:account-1",
      instrumentId: "XAUT-USDT-PERP",
      status: "UNKNOWN",
      createdAt: now,
      updatedAt: now,
    },
    step: {
      stepId: "execution-capability",
      status: "CALL_FAILED",
      result: null,
      error: failure,
    },
  });
  assert.equal(coordinated.step.status === "CALL_FAILED" && coordinated.step.error, failure);
});

test("maps explicitly proven pre-mutation rejects to FAILED for every formal venue", async () => {
  for (const venue of ["binance", "okx", "bybit"] as const) {
    const capability = new MockExecutionCapability();
    capability.failure = new ExecutionPreMutationFailure("deterministic pre-mutation rejection");

    const coordinated = await new ExecutionCoordinator(capability, () => now)
      .execute(executionIntent({ venue }));

    assert.equal(capability.calls.length, 1);
    assert.equal(coordinated.status, "CALL_FAILED");
    assert.equal(coordinated.executionState.status, "FAILED");
    assert.equal(coordinated.step.status, "CALL_FAILED");
  }
});

test("preserves a non-Error capability failure without retrying", async () => {
  const capability = new MockExecutionCapability();
  const failure = Object.freeze({ category: "provider_response_invalid" });
  capability.failure = failure;

  const coordinated = await new ExecutionCoordinator(capability, () => now).execute(executionIntent());

  assert.equal(capability.calls.length, 1);
  assert.equal(coordinated.status, "CALL_FAILED");
  assert.equal(coordinated.executionState.status, "UNKNOWN");
  assert.equal(coordinated.step.status, "CALL_FAILED");
  if (coordinated.step.status === "CALL_FAILED") assert.equal(coordinated.step.error, failure);
});

test("an expired intent is rejected before the capability call", async () => {
  const capability = new MockExecutionCapability();
  const coordinator = new ExecutionCoordinator(capability, () => now + 60_000);

  const coordinated = await coordinator.execute(executionIntent());

  assert.equal(capability.calls.length, 0);
  assert.equal(coordinated.status, "EXPIRED");
  assert.equal(coordinated.executionState.status, "CREATED");
  assert.equal(coordinated.step.status, "SKIPPED_EXPIRED");
});

test("has no Binance, strategy, scheduler, worker, API, or provider dependency", () => {
  const source = readFileSync(new URL("./ExecutionCoordinator.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /type\s+ExplicitExecutionCapability/u);
  assert.doesNotMatch(source, /Binance|Funding|Strategy|Scheduler|Worker|Queue|OrderManager|RiskGuard|Client/iu);
  assert.doesNotMatch(source, /setInterval|setTimeout|cron|fetch\(|placeOrder|cancelOrder/iu);
  assert.deepEqual(
    [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]),
    ["./ExecutionIntent", "./ExecutionState", "./ExecutionCapability"],
  );

  const server = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(server, /ExecutionCoordinator/u);
});

class MockExecutionCapability {
  readonly calls: ExecutionIntent[] = [];
  failure: unknown = null;

  constructor(private readonly result: Record<string, unknown> = { executionAttemptId: "attempt-1" }) {}

  async execute(intent: ExecutionIntent) {
    this.calls.push(intent);
    if (this.failure) throw this.failure;
    return this.result;
  }
}

function executionIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionIntent({
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    instrumentId: "XAUT-USDT-PERP",
    side: "buy",
    quantity: {
      asset: { symbol: "XAUT", type: "RWA_ASSET" },
      quantity: "0.002",
    },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  });
}
