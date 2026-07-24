import assert from "node:assert/strict";
import test from "node:test";
import {
  RwaAutomationGovernance,
  RwaAutomationGovernanceError,
  loadRwaAutomationGovernanceConfig,
  type RwaAutomationGovernanceConfig,
} from "./RwaAutomationGovernance";

const context = {
  operation: "preflight" as const,
  sourceIp: "203.0.113.10",
  userId: "user-a",
  venue: "bybit" as const,
  accountId: "account-a",
};

test("rate policies share user/account budgets across IPs while isolating users and accounts", () => {
  const governor = createGovernor({
    preflightBurstMax: 1,
    preflightSustainedMax: 10,
  });
  governor.enter(context).release();
  assert.throws(
    () => governor.enter({ ...context, sourceIp: "203.0.113.11" }),
    rateLimited,
  );
  governor.enter({ ...context, sourceIp: "203.0.113.13", userId: "user-b" }).release();
  governor.enter({ ...context, sourceIp: "203.0.113.12", accountId: "account-b" }).release();
});

test("burst and sustained windows recover deterministically", () => {
  let now = 10_000;
  const governor = createGovernor({
    preflightBurstMax: 2,
    preflightBurstWindowMs: 1_000,
    preflightSustainedMax: 3,
    preflightSustainedWindowMs: 10_000,
  }, () => now);
  governor.enter(context).release();
  governor.enter(context).release();
  assert.throws(() => governor.enter(context), rateLimited);
  now += 1_001;
  governor.enter(context).release();
  assert.throws(() => governor.enter(context), rateLimited);
  now += 10_001;
  governor.enter(context).release();
});

test("execute and exit concurrency are atomic per user venue account", () => {
  const governor = createGovernor({
    executeBurstMax: 5,
    executeSustainedMax: 10,
    exitOperationMax: 10,
    exitSharedMax: 10,
  });
  const execute = { ...context, operation: "execute" as const };
  const first = governor.enter(execute);
  assert.throws(
    () => governor.enter(execute),
    (error: unknown) => error instanceof RwaAutomationGovernanceError
      && error.category === "automation_concurrency_limited",
  );
  first.release();
  governor.enter(execute).release();

  const close = { ...context, operation: "close_all" as const };
  const exiting = governor.enter(close);
  assert.throws(
    () => governor.enter({ ...close, operation: "position_close" }),
    (error: unknown) => error instanceof RwaAutomationGovernanceError
      && error.category === "automation_concurrency_limited",
  );
  exiting.release();
});

test("in-flight state enforces global and per-user hard capacity", () => {
  const global = createGovernor({
    executeBurstMax: 5,
    executeSustainedMax: 10,
    maxInFlight: 1,
    maxInFlightPerUser: 1,
  });
  const first = global.enter({ ...context, operation: "execute" });
  assert.throws(
    () => global.enter({
      ...context,
      operation: "execute",
      sourceIp: "203.0.113.20",
      userId: "user-b",
      accountId: "account-b",
    }),
    capacityExceeded,
  );
  first.release();

  const perUser = createGovernor({
    executeBurstMax: 5,
    executeSustainedMax: 10,
    maxInFlight: 10,
    maxInFlightPerUser: 1,
  });
  const active = perUser.enter({ ...context, operation: "execute" });
  assert.throws(
    () => perUser.enter({
      ...context,
      operation: "execute",
      sourceIp: "203.0.113.21",
      accountId: "account-b",
    }),
    capacityExceeded,
  );
  active.release();
});

test("exit uses a bounded reserve without sharing entry budgets", () => {
  const governor = createGovernor({
    exitOperationMax: 1,
    exitSharedMax: 1,
    exitReserveMax: 1,
  });
  const close = { ...context, operation: "close_all" as const };
  const first = governor.enter(close);
  assert.equal(first.usedExitReserve, false);
  first.release();
  const second = governor.enter(close);
  assert.equal(second.usedExitReserve, true);
  second.release();
  assert.throws(() => governor.enter(close), rateLimited);

  governor.enter({ ...context, operation: "execute" }).release();
});

test("bucket capacity fails closed before any partial state expansion", () => {
  const governor = createGovernor({ maxBuckets: 2, maxBucketsPerUser: 2 });
  assert.throws(
    () => governor.enter(context),
    (error: unknown) => error instanceof RwaAutomationGovernanceError
      && error.category === "automation_capacity_exceeded",
  );
  assert.equal(governor.inspect().bucketCount, 0);
});

test("governance audit contains stable categories but no source, account, or internal domains", () => {
  const governor = createGovernor();
  governor.enter(context).release();
  const serialized = JSON.stringify(governor.auditForUser(context.userId));
  assert.match(serialized, /preflight|allowed/);
  assert.doesNotMatch(serialized, /203\.0\.113\.10|user-a|account-a|rwa-governance|bucket/i);
});

test("unsafe zero, negative, oversized, or inconsistent production configuration is rejected", () => {
  for (const environment of [
    { RWA_AUTOMATION_EXECUTE_BURST_MAX: "0" },
    { RWA_AUTOMATION_EXIT_RESERVE_MAX: "-1" },
    { RWA_AUTOMATION_MAX_RATE_BUCKETS: "999999999" },
    {
      RWA_AUTOMATION_STATE_MAX_BYTES: "10485760",
      RWA_AUTOMATION_STATE_MAX_BYTES_HARD: "1048576",
    },
    { RWA_AUTOMATION_IDEMPOTENCY_RETENTION_SECONDS: String(29 * 86_400) },
  ]) {
    assert.throws(
      () => loadRwaAutomationGovernanceConfig(environment),
      (error: unknown) => error instanceof RwaAutomationGovernanceError
        && error.category === "automation_capacity_exceeded",
    );
  }
  assert.equal(
    loadRwaAutomationGovernanceConfig({
      RWA_AUTOMATION_IDEMPOTENCY_RETENTION_SECONDS: String(30 * 86_400),
    }).stateCompletedExecutionRetentionMs,
    30 * 86_400_000,
  );
});

function createGovernor(
  overrides: Partial<RwaAutomationGovernanceConfig> = {},
  now: () => number = () => 10_000,
) {
  return new RwaAutomationGovernance({
    ...loadRwaAutomationGovernanceConfig({}),
    ...overrides,
  }, now);
}

function rateLimited(error: unknown) {
  return error instanceof RwaAutomationGovernanceError
    && error.statusCode === 429
    && error.category === "automation_rate_limited"
    && Number.isInteger(error.retryAfterSeconds)
    && !JSON.stringify(error).includes("203.0.113");
}

function capacityExceeded(error: unknown) {
  return error instanceof RwaAutomationGovernanceError
    && error.statusCode === 503
    && error.category === "automation_capacity_exceeded";
}
