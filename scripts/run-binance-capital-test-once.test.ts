import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FundingArbitrageExecutionIntent } from "../server/modules/cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import type { BinanceCapitalTestRuntimeResult } from "../server/modules/binance/BinanceCapitalTestRuntime";
import { snapshotFixture } from "../server/modules/binance/binanceTestFixtures";
import type { BinancePreflightSnapshot } from "../server/modules/binance/BinanceTypes";
import {
  CAPITAL_TEST_QUANTITY_XAUT,
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
    BINANCE_CAPITAL_TEST_RECEIPT_PATH: "/app/data/binance-users/xaut-capital-test-once.jsonl",
    GCP_KMS_CREDENTIAL_KEY_NAME: "projects/test/locations/global/keyRings/test/cryptoKeys/test",
    BINANCE_ALLOWED_EGRESS_IPS: "203.0.113.10",
    MAX_ORDER_USD: "25",
    MAX_POSITION_USD: "100",
    BINANCE_MAX_SLIPPAGE_BPS: "20",
  };
}

function harnessFixture(snapshot: BinancePreflightSnapshot = accountSnapshot()) {
  const claimed: CapitalTestReceipt[] = [];
  const appended: CapitalTestReceipt[] = [];
  const registryUserIds: string[] = [];
  let runtimeCalls = 0;
  let authenticatedUserId: string | null = null;
  let context: Parameters<CapitalTestHarnessDependencies["executeCapitalTest"]>[2] | null = null;
  let intent: FundingArbitrageExecutionIntent | null = null;
  let apiStopped = true;
  const registry = {
    run: async <T>(userId: string, operation: (service: { account: () => Promise<BinancePreflightSnapshot> }) => T) => {
      registryUserIds.push(userId);
      return operation({ account: async () => snapshot });
    },
  };
  const fixture = {
    claimed,
    appended,
    registryUserIds,
    runtimeCalls,
    authenticatedUserId,
    context,
    intent,
    apiStopped,
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
    createRegistry: () => ({
      registry: registry as unknown as Parameters<CapitalTestHarnessDependencies["executeCapitalTest"]>[0],
      close: () => undefined,
    }),
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
