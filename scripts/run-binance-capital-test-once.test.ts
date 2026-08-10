import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FundingArbitrageExecutionIntent } from "../server/modules/cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import type { BinanceCapitalTestRuntimeResult } from "../server/modules/binance/BinanceCapitalTestRuntime";
import { snapshotFixture } from "../server/modules/binance/binanceTestFixtures";
import type { BinancePreflightSnapshot } from "../server/modules/binance/BinanceTypes";
import {
  CAPITAL_TEST_AUTHORIZATION_ORDINAL,
  CAPITAL_TEST_QUANTITY_XAUT,
  CAPITAL_TEST_RECEIPT_FILE_NAME,
  CAPITAL_TEST_RECEIPT_PATH,
  CAPITAL_TEST_USER_ID,
  createFileReceiptStore,
  runBinanceCapitalTestOnce,
  type CapitalTestHarnessDependencies,
  type CapitalTestReceipt,
} from "./run-binance-capital-test-once";

const now = 1_800_000_000_000;
const revision = "a".repeat(40);

test("uses only the fixed approved user and capital test parameters", async () => {
  const fixture = harnessFixture();

  const receipt = await runBinanceCapitalTestOnce(validEnvironment(), fixture.dependencies);

  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.authorizationOrdinal, CAPITAL_TEST_AUTHORIZATION_ORDINAL);
  assert.equal(fixture.authenticatedUserId, CAPITAL_TEST_USER_ID);
  assert.equal(fixture.context?.userId, CAPITAL_TEST_USER_ID);
  assert.equal(fixture.intent?.strategyType, "SPOT_PERPETUAL");
  assert.equal(fixture.intent?.legs[0].role, "long");
  assert.equal(fixture.intent?.legs[0].marketType, "spot");
  assert.equal(fixture.intent?.legs[1].role, "short");
  assert.equal(fixture.intent?.legs[1].marketType, "perpetual");
  assert.equal(fixture.intent?.legs[0].targetDeltaBaseQuantity, CAPITAL_TEST_QUANTITY_XAUT);
  assert.equal(fixture.intent?.legs[1].targetDeltaBaseQuantity, CAPITAL_TEST_QUANTITY_XAUT);
  assert.equal(fixture.intent?.constraints.maxResidualBaseQuantity, "0");
  assert.equal(fixture.runtimeCalls, 1);
  assert.equal(fixture.registryUserIds.every((userId) => userId === CAPITAL_TEST_USER_ID), true);
});

test("rejects an unauthorized user before claiming or invoking the runtime", async () => {
  const fixture = harnessFixture();
  const environment = { ...validEnvironment(), CAPITAL_TEST_USER_ID: "another-user" };

  await assert.rejects(
    () => runBinanceCapitalTestOnce(environment, fixture.dependencies),
    /restricted to the approved user/u,
  );

  assert.equal(fixture.claimed.length, 0);
  assert.equal(fixture.runtimeCalls, 0);
  assert.deepEqual(fixture.registryUserIds, []);
});

test("rejects any quantity outside the fixed approved scope", async () => {
  const fixture = harnessFixture();
  const environment = { ...validEnvironment(), CAPITAL_TEST_QUANTITY_XAUT: "0.003" };

  await assert.rejects(
    () => runBinanceCapitalTestOnce(environment, fixture.dependencies),
    /restricted to the approved quantity/u,
  );

  assert.equal(fixture.claimed.length, 0);
  assert.equal(fixture.runtimeCalls, 0);
});

test("an atomic receipt rejects repeated execution of the same one-time capital test", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stellax-capital-test-"));
  const path = join(directory, "receipt.jsonl");
  try {
    const store = createFileReceiptStore(path);
    const receipt: CapitalTestReceipt = {
      executionId: "execution-once",
      authorizationOrdinal: CAPITAL_TEST_AUTHORIZATION_ORDINAL,
      timestamp: now,
      userId: CAPITAL_TEST_USER_ID,
      revision,
      result: "CLAIMED",
    };

    store.claimReceipt(receipt);
    assert.throws(() => store.claimReceipt(receipt), /already been claimed/u);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("authorization ordinal 2 creates a stable execution identity isolated from authorization 1", async () => {
  const firstRun = await runBinanceCapitalTestOnce(validEnvironment(), harnessFixture().dependencies);
  const secondRun = await runBinanceCapitalTestOnce(validEnvironment(), harnessFixture().dependencies);
  const authorizationOneExecutionId = legacyAuthorizationOneExecutionId(revision);

  assert.equal(firstRun.executionId, secondRun.executionId);
  assert.notEqual(firstRun.executionId, authorizationOneExecutionId);
  assert.equal(firstRun.authorizationOrdinal, 2);
  assert.ok(firstRun.attempts?.every((attempt) => attempt.executionId === firstRun.executionId));

  const secondIdentities = derivedIdentitySet(firstRun.executionId);
  const firstIdentities = derivedIdentitySet(authorizationOneExecutionId);
  assert.equal([...secondIdentities].every((identity) => !firstIdentities.has(identity)), true);
});

test("startup accepts only the fixed authorization 2 receipt path before claim", async () => {
  for (const receiptPath of [
    "/app/data/binance-users/xaut-capital-test-once.jsonl",
    "/app/data/binance-users/another.jsonl",
    "/app/data/binance-users/nested/xaut-capital-test-once-authorization-2.jsonl",
    "/app/data/binance-users/../binance-users/xaut-capital-test-once-authorization-2.jsonl",
  ]) {
    const fixture = harnessFixture();
    await assert.rejects(
      () => runBinanceCapitalTestOnce({
        ...validEnvironment(),
        BINANCE_CAPITAL_TEST_RECEIPT_PATH: receiptPath,
      }, fixture.dependencies),
      /receipt path must be exactly/u,
    );
    assert.equal(fixture.claimed.length, 0);
    assert.equal(fixture.registryCalls, 0);
    assert.equal(fixture.runtimeCalls, 0);
  }

  const fixture = harnessFixture();
  await assert.rejects(
    () => runBinanceCapitalTestOnce({
      ...validEnvironment(),
      BINANCE_USER_ORDER_DB_DIR: "/app/data/another-binance-users",
    }, fixture.dependencies),
    /inside BINANCE_USER_ORDER_DB_DIR/u,
  );
  assert.equal(fixture.claimed.length, 0);
  assert.equal(fixture.registryCalls, 0);
});

test("claiming authorization 2 leaves the authorization 1 receipt bytes unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "stellax-capital-test-isolation-"));
  const firstPath = join(directory, "xaut-capital-test-once.jsonl");
  const secondPath = join(directory, CAPITAL_TEST_RECEIPT_FILE_NAME);
  const firstBytes = "{\"executionId\":\"authorization-1-fixture\",\"result\":\"PASS\"}\n";
  try {
    writeFileSync(firstPath, firstBytes);
    createFileReceiptStore(secondPath).claimReceipt({
      executionId: "authorization-2-fixture",
      authorizationOrdinal: CAPITAL_TEST_AUTHORIZATION_ORDINAL,
      timestamp: now,
      userId: CAPITAL_TEST_USER_ID,
      revision,
      result: "CLAIMED",
    });

    assert.equal(readFileSync(firstPath, "utf8"), firstBytes);
    assert.equal(readFileSync(secondPath, "utf8").trim().length > 0, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restarting the same approved harness preserves identity and is rejected by the receipt claim", async () => {
  const fixture = harnessFixture();

  const first = await runBinanceCapitalTestOnce(validEnvironment(), fixture.dependencies);
  await assert.rejects(
    () => runBinanceCapitalTestOnce(validEnvironment(), fixture.dependencies),
    /already been claimed/u,
  );

  assert.equal(fixture.claimed.length, 1);
  assert.equal(fixture.claimed[0]?.executionId, first.executionId);
  assert.equal(fixture.runtimeCalls, 1);
});

test("a failed local preflight performs no runtime mutation call", async () => {
  const snapshot = accountSnapshot({ existingPerpetualQuantityXaut: 0.001 });
  const fixture = harnessFixture(snapshot);

  const receipt = await runBinanceCapitalTestOnce(validEnvironment(), fixture.dependencies);

  assert.equal(receipt.result, "PREFLIGHT_FAILED");
  assert.equal(receipt.preflight?.status, "FAIL");
  assert.equal(fixture.runtimeCalls, 0);
  assert.equal(fixture.appended.at(-1)?.result, "PREFLIGHT_FAILED");

  await assert.rejects(
    () => runBinanceCapitalTestOnce(validEnvironment(), fixture.dependencies),
    /already been claimed/u,
  );
  assert.equal(fixture.registryCalls, 1);
  assert.equal(fixture.runtimeCalls, 0);
});

test("a runtime throw permanently consumes authorization 2 before another Registry call", async () => {
  const fixture = harnessFixture();
  let throwingRuntimeCalls = 0;
  fixture.dependencies = {
    ...fixture.dependencies,
    executeCapitalTest: async () => {
      throwingRuntimeCalls += 1;
      throw new Error("fixture runtime failure");
    },
  };

  await assert.rejects(
    () => runBinanceCapitalTestOnce(validEnvironment(), fixture.dependencies),
    /stopped without a confirmed closed result/u,
  );
  await assert.rejects(
    () => runBinanceCapitalTestOnce(validEnvironment(), fixture.dependencies),
    /already been claimed/u,
  );

  assert.equal(fixture.claimed.length, 1);
  assert.equal(fixture.registryCalls, 1);
  assert.equal(throwingRuntimeCalls, 1);
});

test("startup fails closed unless revision, process switches, and API isolation are confirmed", async () => {
  for (const environment of [
    { ...validEnvironment(), CAPITAL_TEST_APPROVED_REVISION: "b".repeat(40) },
    { ...validEnvironment(), LIVE_TRADING_ENABLED: "false" },
    { ...validEnvironment(), BINANCE_KILL_SWITCH: "true" },
  ]) {
    const fixture = harnessFixture();
    await assert.rejects(() => runBinanceCapitalTestOnce(environment, fixture.dependencies));
    assert.equal(fixture.claimed.length, 0);
    assert.equal(fixture.runtimeCalls, 0);
  }

  const fixture = harnessFixture();
  fixture.apiStopped = false;
  await assert.rejects(
    () => runBinanceCapitalTestOnce(validEnvironment(), fixture.dependencies),
    /normal API process is reachable/u,
  );
  assert.equal(fixture.claimed.length, 0);
  assert.equal(fixture.runtimeCalls, 0);
});

test("harness imports only Registry and Runtime execution boundaries", () => {
  const source = readFileSync(new URL("./run-binance-capital-test-once.ts", import.meta.url), "utf8");
  assert.match(source, /BinancePersonalTradingServiceRegistry/u);
  assert.match(source, /executeBinanceCapitalTest/u);
  assert.match(source, /registry\.run\(CAPITAL_TEST_USER_ID/u);
  assert.doesNotMatch(source, /from\s+["'][^"']*BinanceClient["']/u);
  assert.doesNotMatch(source, /from\s+["'][^"']*BinanceOrderManager["']/u);
  assert.doesNotMatch(source, /\.placeOrder\s*\(|\.cancelOrder\s*\(/u);
});

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    GIT_COMMIT: revision,
    CAPITAL_TEST_APPROVED_REVISION: revision,
    CAPITAL_TEST_USER_ID,
    CAPITAL_TEST_QUANTITY_XAUT,
    LIVE_TRADING_ENABLED: "true",
    BINANCE_KILL_SWITCH: "false",
    USER_EXCHANGE_CREDENTIAL_DB_PATH: "/app/data/trading.sqlite",
    BINANCE_USER_ORDER_DB_DIR: "/app/data/binance-users",
    BINANCE_CAPITAL_TEST_RECEIPT_PATH: CAPITAL_TEST_RECEIPT_PATH,
    GCP_KMS_CREDENTIAL_KEY_NAME: "projects/test/locations/global/keyRings/test/cryptoKeys/test",
    BINANCE_ALLOWED_EGRESS_IPS: "203.0.113.10",
    MAX_ORDER_USD: "25",
    MAX_POSITION_USD: "100",
    BINANCE_MAX_SLIPPAGE_BPS: "20",
  };
}

type HarnessFixture = {
  claimed: CapitalTestReceipt[];
  appended: CapitalTestReceipt[];
  registryUserIds: string[];
  runtimeCalls: number;
  registryCalls: number;
  authenticatedUserId: string | null;
  context: Parameters<CapitalTestHarnessDependencies["executeCapitalTest"]>[2] | null;
  intent: FundingArbitrageExecutionIntent | null;
  apiStopped: boolean;
  dependencies: CapitalTestHarnessDependencies;
};

function harnessFixture(snapshot: BinancePreflightSnapshot = accountSnapshot()) {
  const claimed: CapitalTestReceipt[] = [];
  const appended: CapitalTestReceipt[] = [];
  const registryUserIds: string[] = [];
  const registry = {
    run: async <T>(userId: string, operation: (service: { account: () => Promise<BinancePreflightSnapshot> }) => T) => {
      registryUserIds.push(userId);
      return operation({ account: async () => snapshot });
    },
  };
  const fixture: HarnessFixture = {
    claimed,
    appended,
    registryUserIds,
    runtimeCalls: 0,
    registryCalls: 0,
    authenticatedUserId: null,
    context: null,
    intent: null,
    apiStopped: true,
    dependencies: null as unknown as CapitalTestHarnessDependencies,
  };
  fixture.dependencies = {
    now: () => now,
    assertApiStopped: async () => {
      if (!fixture.apiStopped) throw new Error("Capital test harness refuses to run while the normal API process is reachable.");
    },
    claimReceipt: (receipt) => {
      if (claimed.length) throw new Error("Capital test has already been claimed and cannot run again.");
      claimed.push(receipt);
    },
    appendReceipt: (receipt) => appended.push(receipt),
    createRegistry: () => {
      fixture.registryCalls += 1;
      return {
        registry: registry as unknown as Parameters<CapitalTestHarnessDependencies["executeCapitalTest"]>[0],
        close: () => undefined,
      };
    },
    executeCapitalTest: async (runtimeRegistry, userId, runtimeContext, runtimeIntent) => {
      assert.equal(runtimeRegistry, registry);
      fixture.runtimeCalls += 1;
      fixture.authenticatedUserId = userId;
      fixture.context = runtimeContext;
      fixture.intent = runtimeIntent;
      return successfulRuntime(runtimeIntent);
    },
  };
  return fixture;
}

function legacyAuthorizationOneExecutionId(approvedRevision: string) {
  const digest = createHash("sha256")
    .update(`${approvedRevision}\u0000${CAPITAL_TEST_USER_ID}\u0000binance-xaut-capital-test-once`)
    .digest("hex");
  return `binance-capital-test-once:${digest}`;
}

function derivedIdentitySet(executionId: string) {
  const legIds = [`${executionId}:spot-long`, `${executionId}:perpetual-short`];
  const identities = new Set<string>();
  for (const legId of legIds) {
    const attemptDigest = createHash("sha256")
      .update(`${executionId}\u0000${legId}\u0000submit\u00000`)
      .digest("hex");
    const attemptId = `funding-arbitrage-attempt:0:${attemptDigest}`;
    const orderDigest = createHash("sha256")
      .update(`${executionId}\u0000${legId}\u0000${attemptId}`)
      .digest("hex");
    const orderId = `funding-arbitrage:${orderDigest}`;
    identities.add(attemptId);
    identities.add(orderId);
    identities.add(`ptm${createHash("sha256").update(orderId).digest("hex").slice(0, 30)}`);
  }
  for (const identity of ["execution-attempt", "operation"] as const) {
    const digest = createHash("sha256")
      .update(`${executionId}\u0000residual-exit\u0000${identity}\u00000`)
      .digest("hex");
    identities.add(`funding-arbitrage-residual-exit:${identity}:${digest}`);
  }
  return identities;
}

function accountSnapshot(overrides: Partial<BinancePreflightSnapshot> = {}) {
  return snapshotFixture({
    accountId: "binance:approved-account",
    accountMode: "single_asset_one_way",
    existingSpotQuantityXaut: 0.000096,
    spotFreeXaut: 0.000096,
    spotAvailableQuantityXaut: 0.000096,
    existingPerpetualQuantityXaut: 0,
    openSpotOrderCount: 0,
    openPerpetualOrderCount: 0,
    spot: {
      ...snapshotFixture().spot,
      minOrderQty: 0.0001,
      qtyStep: 0.0001,
      minNotionalUsd: 5,
      bid: 4_339.99,
      ask: 4_340,
    },
    perpetual: {
      ...snapshotFixture().perpetual,
      minOrderQty: 0.001,
      qtyStep: 0.001,
      minNotionalUsd: 5,
      bid: 4_338.46,
      ask: 4_338.47,
      mark: 4_338.47,
      leverage: 1,
      marginMode: "cross",
    },
    ...overrides,
  });
}

function successfulRuntime(intent: FundingArbitrageExecutionIntent): BinanceCapitalTestRuntimeResult {
  return {
    preflight: { status: "PASS" },
    attempts: intent.legs.map((leg, index) => ({
      executionId: intent.intentId,
      executionAttemptId: `attempt-${index}`,
      legId: leg.legId,
    })),
    executionState: {
      intentId: intent.intentId,
      sourcePlanId: intent.sourcePlanId,
      strategyType: intent.strategyType,
      status: "HEDGED",
      legs: intent.legs.map((leg) => ({
        legId: leg.legId,
        intentId: intent.intentId,
        role: leg.role,
        plannedQuantity: CAPITAL_TEST_QUANTITY_XAUT,
        confirmedExecutedQuantity: CAPITAL_TEST_QUANTITY_XAUT,
        remainingQuantity: "0",
        status: "TERMINAL" as const,
        remoteObservation: "FILLED" as const,
      })) as BinanceCapitalTestRuntimeResult["executionState"] extends { legs: infer Legs } ? Legs : never,
      residualExposure: {
        plannedQuantity: { long: CAPITAL_TEST_QUANTITY_XAUT, short: CAPITAL_TEST_QUANTITY_XAUT },
        executedQuantity: { long: CAPITAL_TEST_QUANTITY_XAUT, short: CAPITAL_TEST_QUANTITY_XAUT },
        residualQuantity: "0",
        calculatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    },
    residualExit: {
      status: "EXITED",
      identity: null,
      reason: null,
      message: "Capital Test closed successfully",
    },
  };
}
