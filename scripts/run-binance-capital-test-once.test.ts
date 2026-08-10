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
  CAPITAL_TEST_MAX_RESIDUAL_XAUT,
  CAPITAL_TEST_QUANTITY_XAUT,
  CAPITAL_TEST_SYMBOL,
  CAPITAL_TEST_USER_ID,
  capitalTestReceiptPath,
  createFileReceiptStore,
  parseCapitalTestArguments,
  runBinanceCapitalTestOnce as executeCapitalTestHarness,
  type CapitalTestInvocation,
  type CapitalTestHarnessDependencies,
  type CapitalTestReceipt,
} from "./run-binance-capital-test-once";

const now = 1_800_000_000_000;
const revision = "a".repeat(40);
const defaultInvocation = invocation("PRICE_PRIORITY", "phase8b1-price-001");

test("uses only the fixed approved user, tolerance, and capital test parameters", async () => {
  const fixture = harnessFixture();

  const receipt = await runBinanceCapitalTestOnce(validEnvironment(), fixture.dependencies);

  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.runId, defaultInvocation.runId);
  assert.equal(receipt.executionMode, "PRICE_PRIORITY");
  assert.equal(receipt.executionPriceMode, "IOC_LIMIT");
  assert.equal(receipt.symbol, CAPITAL_TEST_SYMBOL);
  assert.equal(receipt.quantityXaut, CAPITAL_TEST_QUANTITY_XAUT);
  assert.equal(fixture.authenticatedUserId, CAPITAL_TEST_USER_ID);
  assert.equal(fixture.context?.userId, CAPITAL_TEST_USER_ID);
  assert.equal(fixture.intent?.strategyType, "SPOT_PERPETUAL");
  assert.equal(fixture.intent?.legs[0].role, "long");
  assert.equal(fixture.intent?.legs[0].marketType, "spot");
  assert.equal(fixture.intent?.legs[1].role, "short");
  assert.equal(fixture.intent?.legs[1].marketType, "perpetual");
  assert.equal(fixture.intent?.legs[0].targetDeltaBaseQuantity, CAPITAL_TEST_QUANTITY_XAUT);
  assert.equal(fixture.intent?.legs[1].targetDeltaBaseQuantity, CAPITAL_TEST_QUANTITY_XAUT);
  assert.equal(fixture.intent?.constraints.maxResidualBaseQuantity, CAPITAL_TEST_MAX_RESIDUAL_XAUT);
  assert.equal(fixture.runtimeOptions?.executionPriceMode, "IOC_LIMIT");
  assert.equal(fixture.runtimeCalls, 1);
  assert.equal(fixture.registryUserIds.every((userId) => userId === CAPITAL_TEST_USER_ID), true);
});

test("maps PRICE_PRIORITY to IOC_LIMIT and EXECUTION_PRIORITY to MARKET on the same runtime boundary", async () => {
  const price = harnessFixture();
  const execution = harnessFixture();

  const priceReceipt = await runBinanceCapitalTestOnce(
    validEnvironment(),
    price.dependencies,
    invocation("PRICE_PRIORITY", "price-run-001"),
  );
  const executionReceipt = await runBinanceCapitalTestOnce(
    validEnvironment(),
    execution.dependencies,
    invocation("EXECUTION_PRIORITY", "execution-run-001"),
  );

  assert.equal(price.runtimeOptions?.executionPriceMode, "IOC_LIMIT");
  assert.equal(execution.runtimeOptions?.executionPriceMode, "MARKET");
  assert.equal(priceReceipt.executionPriceMode, "IOC_LIMIT");
  assert.equal(executionReceipt.executionPriceMode, "MARKET");
  assert.equal(price.runtimeCalls, 1);
  assert.equal(execution.runtimeCalls, 1);
});

test("unique run-ids produce distinct execution and receipt identities in the same mode", async () => {
  const first = await runBinanceCapitalTestOnce(
    validEnvironment(),
    harnessFixture().dependencies,
    invocation("PRICE_PRIORITY", "unique-run-001"),
  );
  const second = await runBinanceCapitalTestOnce(
    validEnvironment(),
    harnessFixture().dependencies,
    invocation("PRICE_PRIORITY", "unique-run-002"),
  );

  assert.notEqual(first.executionId, second.executionId);
  assert.notEqual(capitalTestReceiptPath(first.runId), capitalTestReceiptPath(second.runId));
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

test("CLI requires exactly one valid --mode and unique-safe --run-id", () => {
  assert.deepEqual(
    parseCapitalTestArguments(["--mode", "PRICE_PRIORITY", "--run-id", "phase8b1.price-001"]),
    { executionMode: "PRICE_PRIORITY", runId: "phase8b1.price-001" },
  );
  for (const args of [
    [],
    ["--mode", "MIXED", "--run-id", "run-1"],
    ["--mode", "PRICE_PRIORITY"],
    ["--run-id", "../escape", "--mode", "PRICE_PRIORITY"],
    ["--mode", "PRICE_PRIORITY", "--mode", "EXECUTION_PRIORITY", "--run-id", "run-1"],
    ["--mode", "PRICE_PRIORITY", "--run-id", "run-1", "--extra", "value"],
  ]) {
    assert.throws(() => parseCapitalTestArguments(args));
  }
});

test("an atomic receipt rejects repeated execution of the same one-time capital test", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stellax-capital-test-"));
  const path = join(directory, "receipt.jsonl");
  try {
    const store = createFileReceiptStore(path);
    const receipt: CapitalTestReceipt = {
      executionId: "execution-once",
      runId: "execution-once",
      timestamp: now,
      userId: CAPITAL_TEST_USER_ID,
      symbol: CAPITAL_TEST_SYMBOL,
      quantityXaut: CAPITAL_TEST_QUANTITY_XAUT,
      executionMode: "PRICE_PRIORITY",
      executionPriceMode: "IOC_LIMIT",
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

test("mode, run-id, execution, attempt, and order identities are isolated", async () => {
  const price = await runBinanceCapitalTestOnce(
    validEnvironment(),
    harnessFixture().dependencies,
    invocation("PRICE_PRIORITY", "identity-price-001"),
  );
  const execution = await runBinanceCapitalTestOnce(
    validEnvironment(),
    harnessFixture().dependencies,
    invocation("EXECUTION_PRIORITY", "identity-execution-001"),
  );

  assert.notEqual(price.executionId, execution.executionId);
  assert.equal(price.runId, "identity-price-001");
  assert.equal(execution.runId, "identity-execution-001");
  assert.ok(price.attempts?.every((attempt) => attempt.executionId === price.executionId));
  assert.ok(execution.attempts?.every((attempt) => attempt.executionId === execution.executionId));

  const priceIdentities = derivedIdentitySet(price.executionId);
  const executionIdentities = derivedIdentitySet(execution.executionId);
  assert.equal([...priceIdentities].every((identity) => !executionIdentities.has(identity)), true);
});

test("run-id deterministically selects a safe receipt below the fixed receipt root", async () => {
  assert.equal(
    capitalTestReceiptPath("safe-run_001"),
    "/app/data/binance-users/xaut-capital-test-once-safe-run_001.jsonl",
  );
  assert.throws(() => capitalTestReceiptPath("../escape"), /run-id/u);
  const fixture = harnessFixture();
  await assert.rejects(
    () => runBinanceCapitalTestOnce({
      ...validEnvironment(),
      BINANCE_USER_ORDER_DB_DIR: "/app/data/another-binance-users",
    }, fixture.dependencies, defaultInvocation),
    /inside BINANCE_USER_ORDER_DB_DIR/u,
  );
  assert.equal(fixture.claimed.length, 0);
  assert.equal(fixture.registryCalls, 0);
});

test("price and execution mode receipts do not conflict or alter old receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "stellax-capital-test-isolation-"));
  const oldPath = join(directory, "xaut-capital-test-once-authorization-2.jsonl");
  const pricePath = join(directory, "xaut-capital-test-once-price-run-001.jsonl");
  const executionPath = join(directory, "xaut-capital-test-once-execution-run-001.jsonl");
  const oldBytes = "{\"executionId\":\"authorization-2-fixture\",\"result\":\"PASS\"}\n";
  try {
    writeFileSync(oldPath, oldBytes);
    createFileReceiptStore(pricePath).claimReceipt({
      executionId: "price-priority-fixture",
      runId: "price-run-001",
      timestamp: now,
      userId: CAPITAL_TEST_USER_ID,
      symbol: CAPITAL_TEST_SYMBOL,
      quantityXaut: CAPITAL_TEST_QUANTITY_XAUT,
      executionMode: "PRICE_PRIORITY",
      executionPriceMode: "IOC_LIMIT",
      revision,
      result: "CLAIMED",
    });
    createFileReceiptStore(executionPath).claimReceipt({
      executionId: "execution-priority-fixture",
      runId: "execution-run-001",
      timestamp: now,
      userId: CAPITAL_TEST_USER_ID,
      symbol: CAPITAL_TEST_SYMBOL,
      quantityXaut: CAPITAL_TEST_QUANTITY_XAUT,
      executionMode: "EXECUTION_PRIORITY",
      executionPriceMode: "MARKET",
      revision,
      result: "CLAIMED",
    });

    assert.equal(readFileSync(oldPath, "utf8"), oldBytes);
    assert.notEqual(readFileSync(pricePath, "utf8"), readFileSync(executionPath, "utf8"));
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

test("unsafe permissions or processing orders fail preflight with zero runtime mutation calls", async () => {
  const permissionsFixture = harnessFixture(accountSnapshot({
    permissions: { ...snapshotFixture().permissions, withdraw: true },
  }));
  const permissionsReceipt = await runBinanceCapitalTestOnce(
    validEnvironment(),
    permissionsFixture.dependencies,
    invocation("PRICE_PRIORITY", "unsafe-permissions-001"),
  );
  assert.equal(permissionsReceipt.result, "PREFLIGHT_FAILED");
  assert.equal(permissionsReceipt.preflight?.status, "FAIL");
  assert.equal(permissionsFixture.runtimeCalls, 0);

  const processingFixture = harnessFixture();
  processingFixture.processingOrderCount = 1;
  const processingReceipt = await runBinanceCapitalTestOnce(
    validEnvironment(),
    processingFixture.dependencies,
    invocation("EXECUTION_PRIORITY", "processing-order-001"),
  );
  assert.equal(processingReceipt.result, "PREFLIGHT_FAILED");
  assert.equal(processingReceipt.preflight?.status, "FAIL");
  assert.equal(processingFixture.runtimeCalls, 0);
});

test("final FLAT_WITH_DUST is a successful closure", async () => {
  const finalDust = accountSnapshot({
    existingSpotQuantityXaut: 0.000092,
    spotFreeXaut: 0.000092,
    spotAvailableQuantityXaut: 0.000092,
    spotLockedXaut: 0,
  });
  const fixture = harnessFixture(finalDust);

  const receipt = await runBinanceCapitalTestOnce(validEnvironment(), fixture.dependencies);

  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.finalAccount?.flatOrDust, true);
  assert.equal(receipt.finalAccount?.spotQuantityXaut, 0.000092);
});

test("unresolved UNKNOWN remains PENDING_RECONCILIATION in the one-shot receipt", async () => {
  const fixture = harnessFixture();
  let runtimeCalls = 0;
  fixture.dependencies = {
    ...fixture.dependencies,
    executeCapitalTest: async (_registry, _userId, _context, intent) => {
      runtimeCalls += 1;
      return pendingRuntime(intent);
    },
  };

  const receipt = await runBinanceCapitalTestOnce(
    validEnvironment(),
    fixture.dependencies,
    invocation("EXECUTION_PRIORITY", "unknown-execution-001"),
  );

  assert.equal(receipt.result, "PENDING_RECONCILIATION");
  assert.equal(receipt.aggregateStatus, "PENDING_RECONCILIATION");
  assert.equal(receipt.exitStatus, null);
  assert.equal(runtimeCalls, 1);
});

test("a runtime throw permanently consumes the selected mode identity before another Registry call", async () => {
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

function runBinanceCapitalTestOnce(
  environment: NodeJS.ProcessEnv,
  dependencies: CapitalTestHarnessDependencies,
  selectedInvocation: CapitalTestInvocation = defaultInvocation,
) {
  return executeCapitalTestHarness(environment, dependencies, selectedInvocation);
}

function invocation(
  executionMode: CapitalTestInvocation["executionMode"],
  runId: string,
): CapitalTestInvocation {
  return { executionMode, runId };
}

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
  runtimeOptions: Parameters<CapitalTestHarnessDependencies["executeCapitalTest"]>[4] | null;
  processingOrderCount: number;
  apiStopped: boolean;
  dependencies: CapitalTestHarnessDependencies;
};

function harnessFixture(snapshot: BinancePreflightSnapshot = accountSnapshot()) {
  const claimed: CapitalTestReceipt[] = [];
  const appended: CapitalTestReceipt[] = [];
  const registryUserIds: string[] = [];
  const registry = {
    run: async <T>(userId: string, operation: (service: {
      account: () => Promise<BinancePreflightSnapshot>;
      ordersState: () => { orders: Array<{ idempotencyKey: string; status: "processing" }> };
    }) => T) => {
      registryUserIds.push(userId);
      return operation({
        account: async () => snapshot,
        ordersState: () => ({
          orders: Array.from({ length: fixture.processingOrderCount }, (_, index) => ({
            idempotencyKey: `processing-${index}`,
            status: "processing" as const,
          })),
        }),
      });
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
    runtimeOptions: null,
    processingOrderCount: 0,
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
    executeCapitalTest: async (runtimeRegistry, userId, runtimeContext, runtimeIntent, runtimeOptions) => {
      assert.equal(runtimeRegistry, registry);
      fixture.runtimeCalls += 1;
      fixture.authenticatedUserId = userId;
      fixture.context = runtimeContext;
      fixture.intent = runtimeIntent;
      fixture.runtimeOptions = runtimeOptions;
      return successfulRuntime(runtimeIntent);
    },
  };
  return fixture;
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

function pendingRuntime(intent: FundingArbitrageExecutionIntent): BinanceCapitalTestRuntimeResult {
  const runtime = successfulRuntime(intent);
  const state = runtime.executionState;
  if (!state) throw new Error("Fixture requires an execution state.");
  return {
    ...runtime,
    executionState: {
      ...state,
      status: "PENDING_RECONCILIATION",
      legs: state.legs.map((leg, index) => index === 0
        ? leg
        : {
          ...leg,
          confirmedExecutedQuantity: "0",
          remainingQuantity: CAPITAL_TEST_QUANTITY_XAUT,
          status: "PENDING_RECONCILIATION" as const,
          remoteObservation: "UNKNOWN_REMOTE_STATE" as const,
        }),
      residualExposure: {
        plannedQuantity: { long: CAPITAL_TEST_QUANTITY_XAUT, short: CAPITAL_TEST_QUANTITY_XAUT },
        executedQuantity: { long: CAPITAL_TEST_QUANTITY_XAUT, short: "0" },
        residualQuantity: CAPITAL_TEST_QUANTITY_XAUT,
        calculatedAt: now,
      },
    },
    residualExit: null,
  };
}
