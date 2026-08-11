import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutionIntent } from "../server/modules/cex/ExecutionIntent";
import { createExecutionQueryObservation } from "../server/modules/cex/ExecutionQueryCapability";
import { createExecutionRecord, type ExecutionRecord } from "../server/modules/cex/ExecutionRecord";
import type { FundingArbitrageExecutionState } from "../server/modules/cex/funding-arbitrage/FundingArbitrageExecutionState";
import type {
  FundingLegExecutionLink,
  FundingLegExecutionLinkStorePort,
} from "../server/modules/cex/funding-arbitrage/FundingLegExecutionLinkStore";
import { FundingLegExecutionStateBridge } from "../server/modules/cex/funding-arbitrage/FundingLegExecutionStateBridge";
import {
  assertNoUnexpectedExposure,
  BinanceCapitalTestRuntime,
  type BinanceCapitalTestRuntimeOptions,
  type BinanceCapitalTestStateSyncResult,
  type BinanceCapitalTestSubmitResult,
} from "../server/modules/binance/BinanceCapitalTestRuntime";
import type { BinanceIntentExecutionRuntimeRegistry } from "../server/modules/binance/BinanceIntentExecutionRuntime";
import { snapshotFixture } from "../server/modules/binance/binanceTestFixtures";
import type { BinancePreflightSnapshot } from "../server/modules/binance/BinanceTypes";
import {
  CAPITAL_TEST_CANONICAL_PERPETUAL,
  CAPITAL_TEST_CANONICAL_SPOT,
  CAPITAL_TEST_QUANTITY_XAUT,
  CAPITAL_TEST_USER_ID,
  createFileReceiptStore,
  executeCapitalTestHarness,
  parseCapitalTestArguments,
  type CapitalTestHarnessDependencies,
  type CapitalTestInvocation,
  type CapitalTestReceipt,
} from "./run-binance-capital-test-once";

const now = 1_800_000_000_000;
const revision = "a".repeat(40);
const receiptPath = "/app/data/binance-users/capital-test-harness.jsonl";

test("parses complete funding-cycle arguments and defaults count to one", () => {
  assert.deepEqual(parseCapitalTestArguments([
    "--venue", "binance",
    "--instrument", CAPITAL_TEST_CANONICAL_PERPETUAL,
    "--dry-run",
    "--confirm",
    "--receipt", receiptPath,
  ]), invocation());

  assert.deepEqual(parseCapitalTestArguments([
    "--count", "3",
    "--venue", "binance",
    "--instrument", CAPITAL_TEST_CANONICAL_SPOT,
    "--mode", "EXECUTION_PRIORITY",
    "--confirm",
    "--receipt", receiptPath,
  ]), invocation({
    count: 3,
    instrumentId: CAPITAL_TEST_CANONICAL_SPOT,
    dryRun: false,
    executionMode: "EXECUTION_PRIORITY",
  }));
});

test("requires confirmation and rejects legacy leg, malformed count, duplicate, or relative receipt arguments", () => {
  const required = [
    "--venue", "binance",
    "--instrument", CAPITAL_TEST_CANONICAL_PERPETUAL,
    "--receipt", receiptPath,
  ];
  assert.throws(() => parseCapitalTestArguments(required), /explicit --confirm/u);
  for (const args of [
    [...required, "--confirm", "--leg", "spot-long"],
    [...required, "--confirm", "--count", "0"],
    [...required, "--confirm", "--count", "21"],
    [...required, "--confirm", "--receipt", "relative.jsonl"],
    [...required, "--confirm", "--confirm"],
  ]) {
    assert.throws(() => parseCapitalTestArguments(args));
  }
});

test("future venue names remain explicit parameters without automatic routing", async () => {
  for (const venue of ["okx", "bybit", "bitget"] as const) {
    const fixture = harnessFixture();
    await assert.rejects(
      () => executeCapitalTestHarness(validEnvironment(), fixture.dependencies, invocation({ venue })),
      new RegExp(`not implemented: ${venue}`, "u"),
    );
    assert.equal(fixture.registryRuns, 0);
    assert.equal(fixture.providerMutations, 0);
  }
});

test("dry-run count executes two canonical intents per complete cycle with zero provider mutation", async () => {
  const fixture = harnessFixture();
  const receipts = await executeCapitalTestHarness(
    validEnvironment({ LIVE_TRADING_ENABLED: "false", BINANCE_KILL_SWITCH: "true" }),
    fixture.dependencies,
    invocation({ count: 3 }),
  );

  assert.equal(receipts.length, 3);
  assert.equal(fixture.submitCalls.length, 6);
  assert.equal(fixture.queryCalls, 6);
  assert.equal(fixture.providerMutations, 0);
  assert.equal(new Set(receipts.map((receipt) => receipt.fundingExecutionId)).size, 3);
  assert.equal(new Set(receipts.map((receipt) => receipt.fundingIntentId)).size, 3);
  assert.equal(new Set(receipts.flatMap((receipt) => receipt.legs.map((leg) => leg.executionIntentId))).size, 6);
  assert.equal(new Set(receipts.flatMap((receipt) => receipt.legs.map((leg) => leg.executionRecordId))).size, 6);
  assert.equal(receipts.every((receipt) => receipt.result === "DRY_RUN"), true);
  assert.equal(receipts.every((receipt) => receipt.legs[0].role === "spot-long"), true);
  assert.equal(receipts.every((receipt) => receipt.legs[1].role === "perpetual-short"), true);
  assert.equal(receipts.every((receipt) => receipt.legs.every((leg) => leg.executionRecordId !== null)), true);
  assert.equal(receipts.every((receipt) => receipt.residualResult !== null), true);
  assert.equal(fixture.runtimeOptions.every((options) => typeof options.createCapability === "function"), true);
  assert.equal(fixture.links.size, 6);
});

test("real count isolates cycle ownership and rejects the next cycle while prior exposure remains", async () => {
  const fixture = harnessFixture({ liveConfirmed: true });
  const receipts = await executeCapitalTestHarness(
    validEnvironment(),
    fixture.dependencies,
    invocation({ count: 2, dryRun: false }),
  );

  assert.equal(receipts.length, 2);
  assert.equal(receipts[0]?.result, "HEDGED");
  assert.equal(receipts[1]?.result, "PREFLIGHT_FAILED");
  assert.notEqual(receipts[0]?.fundingExecutionId, receipts[1]?.fundingExecutionId);
  assert.equal(fixture.submitCalls.length, 2);
  assert.equal(fixture.providerMutations, 2);
  assert.equal(fixture.snapshot.existingSpotQuantityXaut, 0.002);
  assert.equal(fixture.snapshot.existingPerpetualQuantityXaut, 0.002);
});

test("flat account executes leg A then leg B and derives HEDGED", async () => {
  const fixture = harnessFixture({ liveConfirmed: true });
  const [receipt] = await executeCapitalTestHarness(
    validEnvironment(),
    fixture.dependencies,
    invocation({ dryRun: false }),
  );

  assert.deepEqual(fixture.submitCalls.map((call) => call.role), ["spot-long", "perpetual-short"]);
  assert.equal(receipt?.result, "HEDGED");
  assert.equal(receipt?.legs[0].executionState?.status, "CONFIRMED");
  assert.equal(receipt?.legs[1].executionState?.status, "CONFIRMED");
  assert.equal(receipt?.legs[0].fundingLegState?.status, "TERMINAL");
  assert.equal(receipt?.legs[1].fundingLegState?.status, "TERMINAL");
  assert.equal(receipt?.fundingState?.status, "HEDGED");
  assert.equal(receipt?.residualResult?.residualQuantity, "0");
});

test("leg B is not submitted when leg A is not authoritatively confirmed", async () => {
  const fixture = harnessFixture({ queryStates: ["UNKNOWN"] });
  const [receipt] = await executeCapitalTestHarness(
    validEnvironment(),
    fixture.dependencies,
    invocation({ dryRun: false }),
  );

  assert.equal(fixture.submitCalls.length, 1);
  assert.equal(fixture.providerMutations, 1);
  assert.equal(receipt?.result, "PENDING_RECONCILIATION");
  assert.equal(receipt?.legs[1].executionRecordId, null);
  assert.equal(receipt?.legs[1].fundingLegState, null);
});

test("leg A FAILED does not execute leg B", async () => {
  const fixture = harnessFixture({ queryStates: ["FAILED"] });
  const [receipt] = await executeCapitalTestHarness(
    validEnvironment(),
    fixture.dependencies,
    invocation({ dryRun: false }),
  );

  assert.equal(fixture.submitCalls.length, 1);
  assert.equal(receipt?.result, "FAILED");
  assert.equal(receipt?.legs[0].executionState?.status, "FAILED");
  assert.equal(receipt?.legs[1].executionRecordId, null);
});

test("leg B UNKNOWN is preserved with both execution identities and residual evidence", async () => {
  const fixture = harnessFixture({
    queryStates: ["CONFIRMED", "UNKNOWN"],
    reconcileStates: ["CONFIRMED", "UNKNOWN"],
  });
  const [receipt] = await executeCapitalTestHarness(
    validEnvironment(),
    fixture.dependencies,
    invocation({ dryRun: false }),
  );

  assert.equal(fixture.submitCalls.length, 2);
  assert.equal(receipt?.result, "PENDING_RECONCILIATION");
  assert.equal(receipt?.legs[0].executionState?.status, "CONFIRMED");
  assert.equal(receipt?.legs[1].executionState?.status, "UNKNOWN");
  assert.ok(receipt?.legs[0].executionIntentId);
  assert.ok(receipt?.legs[1].executionIntentId);
  assert.ok(receipt?.legs[0].executionRecordId);
  assert.ok(receipt?.legs[1].executionRecordId);
  assert.equal(receipt?.fundingState?.status, "PENDING_RECONCILIATION");
  assert.equal(receipt?.residualResult?.residualQuantity, CAPITAL_TEST_QUANTITY_XAUT);
});

test("real ExecutionIntent runtime traverses both legs in dry-run without reaching mutation ports", async () => {
  const fixture = harnessFixture({ actualRuntime: true });
  const [receipt] = await executeCapitalTestHarness(
    validEnvironment({ LIVE_TRADING_ENABLED: "false", BINANCE_KILL_SWITCH: "true" }),
    fixture.dependencies,
    invocation(),
  );

  assert.equal(receipt?.result, "DRY_RUN");
  assert.equal(receipt?.legs.every((leg) => leg.executionRecordId !== null), true);
  assert.equal(receipt?.legs.every((leg) => leg.executionState?.status === "UNKNOWN"), true);
  assert.equal(fixture.providerMutations, 0);
  assert.equal(fixture.links.size, 2);
});

test("historical unknown exposure rejects before funding leg claim or provider mutation", async () => {
  const fixture = harnessFixture({
    initialExposure: { spot: 0.001, perpetual: 0, side: "flat" },
  });
  const [receipt] = await executeCapitalTestHarness(validEnvironment(), fixture.dependencies, invocation());

  assert.equal(receipt?.result, "PREFLIGHT_FAILED");
  assert.match(receipt?.message ?? "", /not owned/u);
  assert.equal(fixture.claimCalls, 0);
  assert.equal(fixture.providerMutations, 0);
});

test("current funding execution exposure is allowed only with exact identity and canonical instruments", () => {
  const context = { userId: CAPITAL_TEST_USER_ID, accountId: "binance:test", venue: "binance" as const };
  const snapshot = validSnapshot({
    existingSpotQuantityXaut: 0.002,
    existingPerpetualQuantityXaut: 0.002,
    perpetualPositionSide: "short",
  });
  const binding = {
    fundingExecutionId: "funding-execution-1",
    exposureOwnerFundingExecutionId: "funding-execution-1",
    userId: CAPITAL_TEST_USER_ID,
    accountId: "binance:test",
    venue: "binance" as const,
    instrumentIds: [CAPITAL_TEST_CANONICAL_SPOT, CAPITAL_TEST_CANONICAL_PERPETUAL] as const,
    spotBaseQuantity: "0.002",
    perpetualBaseQuantity: "0.002",
  };

  assert.doesNotThrow(() => assertNoUnexpectedExposure(context, snapshot, binding));
  assert.throws(() => assertNoUnexpectedExposure(context, snapshot, {
    ...binding,
    fundingExecutionId: "",
  }), /fundingExecutionId/u);
  assert.throws(() => assertNoUnexpectedExposure(context, snapshot, {
    ...binding,
    userId: "another-user",
  }), /identity/u);
  assert.throws(() => assertNoUnexpectedExposure(context, snapshot, {
    ...binding,
    exposureOwnerFundingExecutionId: "funding-execution-2",
  }), /different funding execution/u);
  assert.throws(() => assertNoUnexpectedExposure(context, snapshot, {
    ...binding,
    instrumentIds: ["BTC-USDT-SPOT", "BTC-USDT-PERP"] as never,
  }), /canonical instruments/u);
  assert.throws(() => assertNoUnexpectedExposure(context, {
    ...snapshot,
    existingPerpetualQuantityXaut: 0.003,
  }, binding), /not managed/u);
});

test("UNKNOWN observation performs GET-only reconciliation independently for each leg", async () => {
  const fixture = harnessFixture({
    queryStates: ["UNKNOWN", "UNKNOWN"],
    reconcileStates: ["CONFIRMED", "CONFIRMED"],
  });
  const [receipt] = await executeCapitalTestHarness(
    validEnvironment(),
    fixture.dependencies,
    invocation({ dryRun: false }),
  );

  assert.equal(fixture.reconcileCalls, 2);
  assert.equal(receipt?.legs.every((leg) => leg.reconciliationResult?.attempted === true), true);
  assert.equal(receipt?.result, "HEDGED");
});

test("receipt atomically claims cycles and stores both leg records and residual result", () => {
  const directory = mkdtempSync(join(tmpdir(), "stellax-capital-harness-"));
  const path = join(directory, "receipt.jsonl");
  try {
    const store = createFileReceiptStore(path);
    const receipt = receiptFixture();
    store.claimReceipts([receipt]);
    store.appendReceipt({ ...receipt, result: "DRY_RUN" });
    assert.throws(() => store.claimReceipts([receipt]), /already exists/u);
    const stored = store.readReceipts();
    assert.equal(stored.length, 2);
    assert.equal(stored[1]?.legs.length, 2);
    assert.equal(Object.hasOwn(stored[1]!, "residualResult"), true);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("harness contains no legacy capability, old coordinator, residual exit, retry, or automatic runtime", () => {
  const source = readFileSync(new URL("./run-binance-capital-test-once.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "BinanceExecutionCapability",
    "FundingArbitrageExecutionCoordinator",
    "residualExit",
    ".cancelLeg(",
    "scheduler",
    "worker",
    "queue",
    "retry",
  ]) {
    assert.equal(source.includes(forbidden), false, `unexpected legacy or automatic path: ${forbidden}`);
  }
});

type FakeState = "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED" | "UNKNOWN";

function harnessFixture(options: Readonly<{
  liveConfirmed?: boolean;
  actualRuntime?: boolean;
  queryStates?: readonly FakeState[];
  reconcileStates?: readonly FakeState[];
  initialExposure?: Readonly<{ spot: number; perpetual: number; side: "flat" | "short" }>;
}> = {}) {
  const bridge = new FundingLegExecutionStateBridge();
  const links = new Map<string, FundingLegExecutionLink>();
  const claims = new Set<string>();
  const runtimeOptions: BinanceCapitalTestRuntimeOptions[] = [];
  const submitCalls: Array<{ role: "spot-long" | "perpetual-short"; executionIntentId: string }> = [];
  const records = new Map<string, ExecutionRecord>();
  const snapshot = validSnapshot({
    existingSpotQuantityXaut: options.initialExposure?.spot ?? 0,
    existingPerpetualQuantityXaut: options.initialExposure?.perpetual ?? 0,
    perpetualPositionSide: options.initialExposure?.side ?? "flat",
  });
  let registryRuns = 0;
  let queryCalls = 0;
  let reconcileCalls = 0;
  let claimCalls = 0;
  let providerMutations = 0;
  let submittedLegIndex = 0;

  const registry = {
    async run<T>(userId: string, operation: (service: never) => Promise<T> | T): Promise<T> {
      registryRuns += 1;
      assert.equal(userId, CAPITAL_TEST_USER_ID);
      return operation({
        account: async () => snapshot,
        ordersState: () => ({ orders: [] }),
        findExecutionOrderByClientOrderId: async () => null,
        placeExecutionOrder: async () => {
          providerMutations += 1;
          throw new Error("dry-run reached provider mutation");
        },
        cancelOrder: async () => {
          providerMutations += 1;
          throw new Error("dry-run reached provider mutation");
        },
      } as never);
    },
  } as BinanceIntentExecutionRuntimeRegistry;

  const linkStore: FundingLegExecutionLinkStorePort = {
    findForUser(userId, fundingIntentId, legId) {
      assert.equal(userId, CAPITAL_TEST_USER_ID);
      return links.get(`${fundingIntentId}:${legId}`) ?? null;
    },
    claimForUser(userId, fundingIntentId, legId) {
      claimCalls += 1;
      assert.equal(userId, CAPITAL_TEST_USER_ID);
      const key = `${fundingIntentId}:${legId}`;
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    },
    linkForUser(userId, fundingIntentId, legId, link) {
      assert.equal(userId, CAPITAL_TEST_USER_ID);
      links.set(`${fundingIntentId}:${legId}`, link);
    },
  };

  const dependencies: CapitalTestHarnessDependencies = {
    now: () => now,
    assertApiStopped: async () => undefined,
    claimReceipts: () => undefined,
    appendReceipt: () => undefined,
    createRegistry: () => ({ registry, close: () => undefined }),
    createLinkStore: () => ({ store: linkStore, close: () => undefined }),
    createRecordStore: () => ({
      store: {
        create(record) {
          records.set(record.executionId, record);
        },
        update(record) {
          records.set(record.executionId, record);
        },
        loadForUser(userId, executionId) {
          const record = records.get(executionId);
          return record?.userId === userId ? record : null;
        },
      },
      close: () => undefined,
    }),
    createRuntime(_registry, recordStore, runtimeOption) {
      runtimeOptions.push(runtimeOption);
      if (options.actualRuntime) return new BinanceCapitalTestRuntime(_registry, recordStore, runtimeOption);
      return {
        async submitLeg(authenticatedUserId, context, fundingIntent, fundingState, request) {
          const selectedLeg = fundingIntent.legs.find((leg) => leg.legId === request.legId)!;
          const role = selectedLeg.role === "long" ? "spot-long" as const : "perpetual-short" as const;
          const canonicalInstrumentId = role === "spot-long"
            ? CAPITAL_TEST_CANONICAL_SPOT
            : CAPITAL_TEST_CANONICAL_PERPETUAL;
          submitCalls.push({ role, executionIntentId: request.executionIntentId });
          const executionIntent = createExecutionIntent({
            intentId: request.executionIntentId,
            userId: authenticatedUserId,
            venue: "binance",
            accountId: context.accountId,
            instrumentId: canonicalInstrumentId,
            side: role === "spot-long" ? "buy" : "sell",
            quantity: { asset: request.quantityAsset, quantity: selectedLeg.targetDeltaBaseQuantity },
            orderConstraints: request.orderConstraints,
            executionMode: request.executionMode,
            createdAt: now,
            expiresAt: request.expiresAt,
          });
          const link = {
            executionIntentId: executionIntent.intentId,
            executionRecordId: runtimeOption.createExecutionId?.() ?? "missing-record-id",
          };
          const record = executionRecord(link, canonicalInstrumentId, "PENDING_CONFIRMATION");
          records.set(link.executionRecordId, record);
          if (!runtimeOption.createCapability) {
            providerMutations += 1;
            if (role === "spot-long") snapshot.existingSpotQuantityXaut += Number(CAPITAL_TEST_QUANTITY_XAUT);
            else {
              snapshot.existingPerpetualQuantityXaut += Number(CAPITAL_TEST_QUANTITY_XAUT);
              snapshot.perpetualPositionSide = "short";
            }
          }
          submittedLegIndex += 1;
          const observation = createExecutionQueryObservation({
            state: "PENDING_CONFIRMATION",
            filledBaseQuantity: "0",
            observedAt: now,
          });
          return {
            preflight: { status: "PASS" },
            executionIntent,
            executionRecord: record,
            execution: null,
            observation,
            executionState: bridge.apply({
              authenticatedUserId,
              fundingState,
              legId: request.legId,
              link,
              executionRecord: record,
              observation,
            }),
            link,
          } satisfies BinanceCapitalTestSubmitResult;
        },
        async queryLeg(authenticatedUserId, fundingState, legId, link) {
          queryCalls += 1;
          const index = submittedLegIndex - 1;
          const state = options.queryStates?.[index]
            ?? (options.liveConfirmed ? "CONFIRMED" : "PENDING_CONFIRMATION");
          return syncResult(authenticatedUserId, fundingState, legId, link, state);
        },
        async reconcileLeg(authenticatedUserId, fundingState, legId, link) {
          reconcileCalls += 1;
          const index = submittedLegIndex - 1;
          return syncResult(
            authenticatedUserId,
            fundingState,
            legId,
            link,
            options.reconcileStates?.[index] ?? "UNKNOWN",
          );
        },
      };
    },
  };

  function syncResult(
    authenticatedUserId: string,
    fundingState: FundingArbitrageExecutionState,
    legId: string,
    link: FundingLegExecutionLink,
    state: FakeState,
  ): BinanceCapitalTestStateSyncResult {
    const current = records.get(link.executionRecordId)!;
    const record = createExecutionRecord({ ...current, status: state, updatedAt: now });
    records.set(link.executionRecordId, record);
    const observation = createExecutionQueryObservation({
      state,
      filledBaseQuantity: state === "CONFIRMED" ? CAPITAL_TEST_QUANTITY_XAUT : "0",
      observedAt: now,
    });
    return {
      executionRecord: record,
      observation,
      executionState: bridge.apply({
        authenticatedUserId,
        fundingState,
        legId,
        link,
        executionRecord: record,
        observation,
      }),
    };
  }

  return {
    dependencies,
    links,
    runtimeOptions,
    submitCalls,
    snapshot,
    get registryRuns() { return registryRuns; },
    get queryCalls() { return queryCalls; },
    get reconcileCalls() { return reconcileCalls; },
    get claimCalls() { return claimCalls; },
    get providerMutations() { return providerMutations; },
  };
}

function executionRecord(link: FundingLegExecutionLink, instrumentId: string, status: FakeState) {
  return createExecutionRecord({
    executionId: link.executionRecordId,
    intentId: link.executionIntentId,
    executionAttemptId: `${link.executionIntentId}:attempt`,
    userId: CAPITAL_TEST_USER_ID,
    venue: "binance",
    accountId: "binance:test",
    instrumentId,
    status,
    createdAt: now,
    updatedAt: now,
  });
}

function validSnapshot(overrides: Partial<BinancePreflightSnapshot> = {}): BinancePreflightSnapshot {
  const base = snapshotFixture({ accountId: "binance:test", fetchedAt: now });
  return {
    ...base,
    productAvailability: { ...base.productAvailability, checkedAt: now },
    spot: { ...base.spot, bid: 2_999, ask: 3_000 },
    perpetual: {
      ...base.perpetual,
      bid: 3_001,
      ask: 3_002,
      mark: 3_001,
      nextFundingTime: now + 3_600_000,
    },
    ...overrides,
  };
}

function invocation(overrides: Partial<CapitalTestInvocation> = {}): CapitalTestInvocation {
  return {
    count: 1,
    venue: "binance",
    instrumentId: CAPITAL_TEST_CANONICAL_PERPETUAL,
    dryRun: true,
    confirmed: true,
    receiptPath,
    executionMode: "PRICE_PRIORITY",
    ...overrides,
  };
}

function validEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    GIT_COMMIT: revision,
    CAPITAL_TEST_APPROVED_REVISION: revision,
    CAPITAL_TEST_USER_ID,
    CAPITAL_TEST_QUANTITY_XAUT,
    LIVE_TRADING_ENABLED: "true",
    BINANCE_KILL_SWITCH: "false",
    USER_EXCHANGE_CREDENTIAL_DB_PATH: "/app/data/credentials.sqlite",
    BINANCE_USER_ORDER_DB_DIR: "/app/data/binance-users",
    TRADING_DB_PATH: "/app/data/trading.sqlite",
    GCP_KMS_CREDENTIAL_KEY_NAME: "projects/test/locations/global/keyRings/test/cryptoKeys/test",
    BINANCE_ALLOWED_EGRESS_IPS: "203.0.113.10",
    MAX_ORDER_USD: "25",
    MAX_POSITION_USD: "100",
    BINANCE_MAX_SLIPPAGE_BPS: "20",
    ...overrides,
  };
}

function receiptFixture(): CapitalTestReceipt {
  const emptyLeg = (role: "spot-long" | "perpetual-short", instrumentId: string) => ({
    role,
    instrumentId,
    legId: `leg-${role}`,
    executionIntentId: `intent-${role}`,
    plannedExecutionRecordId: `record-${role}`,
    preflight: null,
    executionRecordId: null,
    executionRecord: null,
    executionState: null,
    fundingLegState: null,
    observation: null,
    reconciliationResult: null,
  });
  return {
    runIndex: 0,
    count: 1,
    timestamp: now,
    revision,
    dryRun: true,
    result: "CLAIMED",
    venue: "binance",
    instrumentId: CAPITAL_TEST_CANONICAL_PERPETUAL,
    fundingExecutionId: "funding-execution",
    fundingIntentId: "funding-intent",
    executionMode: "PRICE_PRIORITY",
    legs: [
      emptyLeg("spot-long", CAPITAL_TEST_CANONICAL_SPOT),
      emptyLeg("perpetual-short", CAPITAL_TEST_CANONICAL_PERPETUAL),
    ],
    residualResult: null,
  };
}
