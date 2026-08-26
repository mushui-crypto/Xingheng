import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import { SqliteExecutionRecordStore, type ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import {
  assertCoordinatorBoundaryContract,
  assertExecutionIdentityContract,
  assertPreparationFailureContract,
} from "../cex/RuntimeLifecycleContractAssertions";
import {
  InMemoryOkxExecutionOrderReferenceStore,
  type OkxExecutionOrderReference,
} from "./OkxExecutionOrderReferenceStore";
import { OkxClient } from "./OkxClient";
import { OkxIntentExecutionCapability } from "./OkxIntentExecutionCapability";
import { OkxIntentExecutionRuntime } from "./OkxIntentExecutionRuntime";
import { okxClientOrderIdFor } from "./OkxIntentExecutionService";
import { okxTestQuantityRulesSource } from "./OkxTestFixtures";
import type {
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "./OkxTypes";

const now = 1_800_000_000_000;
const fakeMutationGuard = () => new ExecutionMutationSafetyGuard({ liveTradingEnabled: true, killSwitchActive: false });
const runtimeOptions = (executionId?: string) => ({
  ...(executionId === undefined ? {} : { createExecutionId: () => executionId }),
  clock: () => now,
  mutationSafetyGuard: fakeMutationGuard(),
  quantityRulesSource: okxTestQuantityRulesSource(now),
  spotQuantityRulesSource: async () => ({
    instType: "SPOT" as const,
    instId: "DOGE-USDT",
    baseCcy: "DOGE",
    quoteCcy: "USDT",
    lotSz: "0.1",
    minSz: "1",
    tickSz: "0.00001",
    state: "live",
    fetchedAt: now,
  }),
});

test("runtime reports its configured opening execution-mode capability without Provider access", () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    new FakeExecutionRecordStore(),
    new InMemoryOkxExecutionOrderReferenceStore(),
    runtimeOptions(),
  );

  assert.equal(runtime.supportsOpeningExecutionMode({
    executionMode: "EXECUTION_PRIORITY",
    marketType: "spot",
  }), true);
  assert.equal(runtime.supportsOpeningExecutionMode({
    executionMode: "EXECUTION_PRIORITY",
    marketType: "perpetual",
  }), true);
  assert.equal(runtime.supportsOpeningExecutionMode({
    executionMode: "PRICE_PRIORITY",
    marketType: "spot",
  }), false);
  assert.equal(runtime.supportsOpeningExecutionMode({
    executionMode: "PRICE_PRIORITY",
    marketType: "perpetual",
  }), false);
  assert.equal(service.placeRequests.length, 0);
});

test("runtime submits through the authenticated user's OKX service and saves order identity", async () => {
  const serviceA = new FakeOkxRuntimeService("okx:account-user-a");
  const serviceB = new FakeOkxRuntimeService("okx:account-user-b");
  const records = new FakeExecutionRecordStore();
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": serviceA, "user-b": serviceB }),
    records,
    references,
    runtimeOptions("execution-okx-1"),
  );
  const intent = executionIntent({ userId: "user-a", accountId: "okx:account-user-a" });

  const result = await runtime.execute(intent);

  assert.equal(result.execution.status, "SUCCEEDED");
  assert.equal(result.executionRecord.executionId, "execution-okx-1");
  assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(result.executionRecord.remoteOrderId, "8001");
  assert.equal(result.orderReference?.ordId, "8001");
  assert.equal(result.orderReference?.clOrdId, okxClientOrderIdFor(intent));
  assert.equal(result.orderReference?.instId, "DOGE-USDT-SWAP");
  assert.deepEqual(await references.loadForUser("user-a", "execution-okx-1"), result.orderReference);
  assert.equal(serviceA.placeRequests.length, 1);
  assert.equal(serviceB.placeRequests.length, 0);
  assert.deepEqual(records.created.map((record) => record.status), ["CREATED"]);
  assert.deepEqual(records.updated.map((record) => record.status), ["PENDING_CONFIRMATION"]);
});

test("runtime upgrades the recovery anchor from the real OKX place-order response shape", async () => {
  let providerMutations = 0;
  let providerReads = 0;
  const providerClient = new OkxClient(() => okxCredentials(), {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/v5/trade/order");
      assert.equal(init?.method, "POST");
      providerMutations += 1;
      const body = JSON.parse(String(init?.body)) as { clOrdId: string };
      return Response.json({
        code: "0",
        data: [{ ordId: "8002", clOrdId: body.clOrdId, sCode: "0", sMsg: "" }],
      });
    }) as typeof fetch,
  });
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  service.placeOrderDelegate = (request) => providerClient.placeOrder(request);
  service.getOrderDelegate = async (request) => {
    providerReads += 1;
    return providerClient.getOrder(request);
  };
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    new FakeExecutionRecordStore(),
    references,
    runtimeOptions("execution-okx-real-response"),
  );

  const result = await runtime.execute(executionIntent({ intentId: "intent-okx-real-response" }));

  assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(result.executionRecord.remoteOrderId, "8002");
  assert.equal(result.orderReference?.ordId, "8002");
  assert.equal(result.orderReference?.instId, "DOGE-USDT-SWAP");
  assert.equal(await references.loadRecoveryForUser("user-a", "execution-okx-real-response"), null);
  assert.equal((await references.loadForUser("user-a", "execution-okx-real-response"))?.ordId, "8002");
  assert.equal(service.placeRequests.length, 1);
  assert.equal(providerMutations, 1);
  assert.equal(providerReads, 0);
});

test("runtime promotes an OKX HEDGE recovery reference without dropping bucket identity", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  service.readPositionMode = async () => "HEDGE";
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    new FakeExecutionRecordStore(),
    references,
    runtimeOptions("execution-okx-hedge-promotion"),
  );

  const result = await runtime.execute(executionIntent({
    intentId: "intent-okx-hedge-promotion",
    positionDirection: "SHORT",
    side: "sell",
  }));

  assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(result.orderReference?.positionMode, "HEDGE");
  assert.equal(result.orderReference?.positionDirection, "SHORT");
  assert.equal(result.orderReference?.posSide, "short");
  assert.equal(await references.loadRecoveryForUser("user-a", "execution-okx-hedge-promotion"), null);
});

test("runtime selects the OKX Spot capability and persists the normal order reference", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    new FakeExecutionRecordStore(),
    references,
    runtimeOptions("execution-okx-spot-1"),
  );
  const intent = executionIntent({
    intentId: "intent-okx-spot-runtime",
    instrumentId: "DOGE-USDT-SPOT",
    quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "100" },
  });
  const result = await runtime.execute(intent);

  assert.equal(service.placeRequests.length, 1);
  assert.deepEqual(service.placeRequests[0], {
    instId: "DOGE-USDT", tdMode: "cash", side: "buy", ordType: "market", quantity: "100",
    clOrdId: okxClientOrderIdFor(intent), targetCurrency: "base_ccy",
  });
  assert.equal(result.orderReference?.instId, "DOGE-USDT");
  assert.equal(result.orderReference?.expectedProviderQuantity, "100");
  assert.equal(result.orderReference?.expectedSide, "buy");
  assert.equal((await references.loadForUser("user-a", "execution-okx-spot-1"))?.instrumentId, "DOGE-USDT-SPOT");
});

test("pre-mutation preparation failure closes the created record without provider mutation", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  const records = new FakeExecutionRecordStore();
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  const preparationError = new Error("capability preparation failed");
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    records,
    references,
    {
      ...runtimeOptions("execution-okx-preparation-failure"),
      createCapability: () => { throw preparationError; },
    },
  );

  await assert.rejects(
    () => runtime.execute(executionIntent({ intentId: "intent-okx-preparation-failure" })),
    (error: unknown) => error === preparationError,
  );

  const failed = await records.loadForUser("user-a", "execution-okx-preparation-failure");
  assert.equal(failed?.status, "FAILED");
  assert.equal(failed?.executionAttemptId, undefined);
  assert.equal(failed?.remoteOrderId, undefined);
  assert.equal(await references.loadForUser("user-a", "execution-okx-preparation-failure"), null);
  assert.equal(await references.loadRecoveryForUser("user-a", "execution-okx-preparation-failure"), null);
  assert.deepEqual(records.created.map((record) => record.status), ["CREATED"]);
  assert.deepEqual(records.updated.map((record) => record.status), ["FAILED"]);
  assert.equal(service.placeRequests.length, 0);
  await assertPreparationFailureContract({
    initialRecord: records.created[0]!,
    finalRecord: failed,
    loadRecord: () => records.loadForUser("user-a", "execution-okx-preparation-failure"),
    mutationCount: service.placeRequests.length,
    error: preparationError,
    originalError: preparationError,
  });
  assertExecutionIdentityContract(failed!, executionIntent({ intentId: "intent-okx-preparation-failure" }));
});

test("pre-mutation failure remains FAILED after SQLite store restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stellax-okx-preparation-"));
  const dbPath = join(directory, "trading.sqlite");
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  const firstStore = new SqliteExecutionRecordStore({ dbPath });
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    firstStore,
    references,
    {
      ...runtimeOptions("execution-okx-preparation-restart"),
      createCapability: () => { throw new Error("preparation failed before coordinator"); },
    },
  );

  try {
    await assert.rejects(() => runtime.execute(executionIntent({ intentId: "intent-okx-preparation-restart" })));
    firstStore.close();
    const restarted = new SqliteExecutionRecordStore({ dbPath });
    try {
      const record = restarted.loadForUser("user-a", "execution-okx-preparation-restart");
      assert.equal(record?.status, "FAILED");
      assert.equal(record?.executionAttemptId, undefined);
      assert.equal(record?.remoteOrderId, undefined);
      assert.equal(await references.loadForUser("user-a", "execution-okx-preparation-restart"), null);
      assert.equal(await references.loadRecoveryForUser("user-a", "execution-okx-preparation-restart"), null);
      assert.equal(service.placeRequests.length, 0);
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capability failure after Coordinator starts keeps the existing UNKNOWN semantics", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  const records = new FakeExecutionRecordStore();
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    records,
    references,
    {
      ...runtimeOptions("execution-okx-coordinator-failure"),
      createCapability: () => new OkxIntentExecutionCapability({
        execute: async () => { throw new Error("capability call failed"); },
      }),
    },
  );

  const result = await runtime.execute(executionIntent({ intentId: "intent-okx-coordinator-failure" }));

  assert.equal(result.execution.step.status, "CALL_FAILED");
  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.deepEqual(records.updated.map((record) => record.status), ["UNKNOWN"]);
  assert.equal(service.placeRequests.length, 0);
  assert.equal(await references.loadForUser("user-a", "execution-okx-coordinator-failure"), null);
  assert.equal(await references.loadRecoveryForUser("user-a", "execution-okx-coordinator-failure"), null);
  assertCoordinatorBoundaryContract({
    executionRecord: result.executionRecord,
    persistedRecords: records.updated,
    expectedStatus: "UNKNOWN",
    mutationCount: service.placeRequests.length,
    expectedMutationCount: 0,
  });
});

test("runtime close accepts non-reduceOnly reversal intents", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    new FakeExecutionRecordStore(),
    new InMemoryOkxExecutionOrderReferenceStore(),
    runtimeOptions("execution-close-runtime-non-reduce"),
  );

  await runtime.close(executionIntent({
    userId: "user-a",
    accountId: "okx:account-user-a",
    intentId: "intent-close-runtime-non-reduce",
    orderConstraints: { reduceOnly: false },
  }));
  assert.equal(service.placeRequests.length, 1);
  assert.equal(service.placeRequests[0]?.reduceOnly, false);
});

test("runtime close sends reduceOnly=true for perpetual close", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    new FakeExecutionRecordStore(),
    new InMemoryOkxExecutionOrderReferenceStore(),
    runtimeOptions("execution-close-1"),
  );

  await runtime.close(executionIntent({
    intentId: "intent-close-runtime",
    userId: "user-a",
    accountId: "okx:account-user-a",
    side: "sell",
    orderConstraints: { reduceOnly: true },
  }));

  assert.equal(service.placeRequests[0]?.reduceOnly, true);
  assert.equal(service.placeRequests[0]?.side, "sell");
});

test("query uses saved OKX identity and updates record state", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  service.orderState = "filled";
  const record = executionRecord();
  const records = new FakeExecutionRecordStore([record]);
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  references.create(orderReference());
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    records,
    references,
    { ...runtimeOptions(), clock: () => now + 1_000, quantityRulesSource: okxTestQuantityRulesSource(now + 1_000) },
  );

  const result = await runtime.query("user-a", "execution-query-okx");

  assert.equal(result.executionRecord.status, "CONFIRMED");
  assert.equal(result.observation.filledBaseQuantity, "12.5");
  assert.equal(result.orderReference.ordId, "8001");
  assert.equal(result.orderReference.clOrdId, "sxokxquery0000000000000000000");
  assert.deepEqual(service.getRequests, [{
    instId: "DOGE-USDT-SWAP",
    ordId: "8001",
    clOrdId: "sxokxquery0000000000000000000",
  }]);
});

test("Spot recovery uses the persisted client-order anchor and never repeats mutation", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  service.orderOverride = {
    status: "CONFIRMED",
    rawState: "filled",
    requestedQuantity: "100",
    filledQuantity: "100",
    averagePrice: "0.1",
    fee: "0",
    feeCcy: null,
    updatedAt: now + 50,
    side: "buy",
  };
  const record = createExecutionRecord({
    executionId: "execution-spot-recovery",
    intentId: "intent-spot-recovery",
    executionAttemptId: "intent-spot-recovery",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-SPOT",
    status: "UNKNOWN",
    createdAt: now,
    updatedAt: now,
  });
  const records = new FakeExecutionRecordStore([record]);
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  references.createRecovery({
    executionId: record.executionId,
    intentId: record.intentId,
    userId: record.userId,
    accountId: record.accountId,
    instrumentId: record.instrumentId,
    instId: "DOGE-USDT",
    clOrdId: "sxokxspotrecovery00000000000001",
    expectedProviderQuantity: "100",
    expectedSide: "buy",
    createdAt: now,
    updatedAt: now,
  });
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    records,
    references,
    {
      ...runtimeOptions(),
      clock: () => now + 100,
      spotQuantityRulesSource: async () => ({
        instType: "SPOT", instId: "DOGE-USDT", baseCcy: "DOGE", quoteCcy: "USDT",
        lotSz: "0.1", minSz: "1", tickSz: "0.00001", state: "live", fetchedAt: now + 100,
      }),
    },
  );

  const result = await runtime.reconcile("user-a", record.executionId);

  assert.equal(result.executionRecord.status, "CONFIRMED");
  assert.equal(result.observation?.filledBaseQuantity, "100");
  assert.equal(service.placeRequests.length, 0);
  assert.equal((await references.loadForUser("user-a", record.executionId))?.clOrdId, "sxokxspotrecovery00000000000001");
  assert.equal((await references.loadForUser("user-a", record.executionId))?.expectedProviderQuantity, "100");
  assert.equal((await references.loadForUser("user-a", record.executionId))?.expectedSide, "buy");
});

test("OKX HEDGE recovery keeps the recovery anchor when Provider evidence is from another bucket", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  service.orderOverride = {
    status: "CONFIRMED",
    rawState: "filled",
    requestedQuantity: "125",
    filledQuantity: "125",
    side: "sell",
    posSide: "long",
  };
  const record = createExecutionRecord({
    executionId: "execution-okx-hedge-wrong-bucket",
    intentId: "intent-okx-hedge-wrong-bucket",
    executionAttemptId: "intent-okx-hedge-wrong-bucket",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    status: "UNKNOWN",
    createdAt: now,
    updatedAt: now,
  });
  const records = new FakeExecutionRecordStore([record]);
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  references.createRecovery({
    executionId: record.executionId,
    intentId: record.intentId,
    userId: record.userId,
    accountId: record.accountId,
    instrumentId: record.instrumentId,
    instId: "DOGE-USDT-SWAP",
    clOrdId: "sxokxhedgewrongevidence0000001",
    expectedProviderQuantity: "125",
    expectedSide: "sell",
    positionMode: "HEDGE",
    positionDirection: "SHORT",
    posSide: "short",
    createdAt: now,
    updatedAt: now,
  });
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    records,
    references,
    { ...runtimeOptions(), clock: () => now + 100, quantityRulesSource: okxTestQuantityRulesSource(now + 100) },
  );

  const result = await runtime.reconcile("user-a", record.executionId);

  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(result.orderReference, null);
  assert.equal(await references.loadForUser("user-a", record.executionId), null);
  assert.equal((await references.loadRecoveryForUser("user-a", record.executionId))?.posSide, "short");
});

test("confirmed reconciliation re-reads the persisted OKX order and restores its fill without mutation", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  service.orderState = "filled";
  const record = createExecutionRecord({
    ...executionRecord(),
    status: "CONFIRMED",
  });
  const records = new FakeExecutionRecordStore([record]);
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  references.create(orderReference());
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    records,
    references,
    { ...runtimeOptions(), clock: () => now + 1_000, quantityRulesSource: okxTestQuantityRulesSource(now + 1_000) },
  );

  const result = await runtime.reconcile("user-a", record.executionId);

  assert.equal(result.executionRecord.status, "CONFIRMED");
  assert.equal(result.observation?.filledBaseQuantity, "12.5");
  assert.equal(result.terminalShortCircuit, false);
  assert.equal(service.getRequests.length, 1);
  assert.equal(service.placeRequests.length, 0);
  assert.equal(service.cancelRequests.length, 0);
});

test("malformed Spot fee flows from OkxClient through Runtime to an UNKNOWN ExecutionRecord", async () => {
  const providerClient = new OkxClient(() => okxCredentials(), {
    now: () => now + 100,
    fetchImpl: (async () => Response.json({ code: "0", data: [{
      instId: "DOGE-USDT",
      ordId: "8001",
      clOrdId: "sxokxspotquery0000000000000001",
      side: "buy",
      state: "filled",
      sz: "100",
      accFillSz: "100",
      avgPx: "0.1",
      fee: "malformed",
      feeCcy: "USDT",
      uTime: String(now + 100),
    }] })) as typeof fetch,
  });
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  service.getOrderDelegate = (request) => providerClient.getOrder(request);
  const fixture = spotQueryFixture(service, "execution-spot-malformed-fee");

  const result = await fixture.runtime.query("user-a", fixture.record.executionId);

  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.match(result.statusReason ?? "", /fee evidence/u);
  assert.equal(service.placeRequests.length, 0);
  assert.equal(fixture.records.updated.at(-1)?.status, "UNKNOWN");
});

test("cancel rejects user and account mismatch before OKX provider mutation", async () => {
  const record = executionRecord();
  const service = new FakeOkxRuntimeService("okx:other-account");
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    new FakeExecutionRecordStore([record]),
    new InMemoryOkxExecutionOrderReferenceStore(),
  );

  await assert.rejects(() => runtime.cancel("user-b", "execution-query-okx"), /not found/u);
  await assert.rejects(() => runtime.cancel("user-a", "execution-query-okx"), /accountId does not match/u);
  assert.equal(service.cancelRequests.length, 0);
});

test("runtime registration uses the generic capability registry without Binance execution coupling", () => {
  const source = readFileSync(new URL("./OkxIntentExecutionRuntime.ts", import.meta.url), "utf8");
  assert.match(source, /ExecutionCapabilityRegistry/u);
  assert.match(source, /RegistryBackedExecutionCapability/u);
  assert.doesNotMatch(source, /BinanceIntentExecution|BinanceOrderManager|BinanceRiskGuard/u);
});

class FakeOkxRuntimeRegistry {
  readonly runUserIds: string[] = [];

  constructor(readonly services: Record<string, FakeOkxRuntimeService>) {}

  async run<T>(userId: string, operation: (service: FakeOkxRuntimeService) => Promise<T> | T): Promise<T> {
    this.runUserIds.push(userId);
    const service = this.services[userId];
    if (!service) throw new Error("missing fake OKX service");
    return operation(service);
  }
}

class FakeOkxRuntimeService {
  readonly placeRequests: OkxPlaceOrderRequest[] = [];
  readonly getRequests: OkxGetOrderRequest[] = [];
  readonly cancelRequests: OkxCancelOrderRequest[] = [];
  orderState = "live";
  orderOverride: Partial<OkxProviderOrder> = {};
  placeOrderDelegate?: (request: OkxPlaceOrderRequest) => Promise<OkxCancelOrderResult>;
  getOrderDelegate?: (request: OkxGetOrderRequest) => Promise<OkxProviderOrder>;
  readPositionMode?: () => Promise<"ONE_WAY" | "HEDGE">;

  constructor(private readonly accountId: string) {}

  executionAccountIdentity() {
    return { accountId: this.accountId };
  }

  validateExecutionProviderIdentity() {}

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeRequests.push(request);
    if (this.placeOrderDelegate) return this.placeOrderDelegate(request);
    return {
      instId: request.instId,
      ordId: "8001",
      clOrdId: request.clOrdId,
    };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    this.getRequests.push(request);
    if (this.getOrderDelegate) return this.getOrderDelegate(request);
    return {
      instId: request.instId,
      ordId: request.ordId ?? "8001",
      clOrdId: request.clOrdId ?? "sxokxquery0000000000000000000",
      status: this.orderState === "filled" ? "CONFIRMED" : "PENDING_CONFIRMATION",
      statusReason: null,
      rawState: this.orderState,
      requestedQuantity: "125",
      filledQuantity: this.orderState === "filled" ? "125" : "12.5",
      averagePrice: "0.123",
      fee: "-0.001",
      updatedAt: now + 100,
      ...this.orderOverride,
    };
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    this.cancelRequests.push(request);
    return {
      instId: request.instId,
      ordId: request.ordId ?? "8001",
      clOrdId: request.clOrdId ?? "sxokxquery0000000000000000000",
    };
  }
}

class FakeExecutionRecordStore implements ExecutionRecordStore {
  readonly created: ExecutionRecord[] = [];
  readonly updated: ExecutionRecord[] = [];
  private readonly records = new Map<string, ExecutionRecord>();

  constructor(records: readonly ExecutionRecord[] = []) {
    for (const record of records) {
      this.records.set(key(record.userId, record.executionId), record);
    }
  }

  create(record: ExecutionRecord) {
    this.created.push(record);
    this.records.set(key(record.userId, record.executionId), record);
  }

  update(record: ExecutionRecord) {
    this.updated.push(record);
    this.records.set(key(record.userId, record.executionId), record);
  }

  loadForUser(userId: string, executionId: string) {
    return this.records.get(key(userId, executionId)) ?? null;
  }
}

function key(userId: string, executionId: string) {
  return `${userId}\u0000${executionId}`;
}

function executionIntent(overrides: Partial<Record<string, unknown>> = {}) {
  const instrumentId = (overrides.instrumentId as string | undefined) ?? "DOGE-USDT-PERP";
  const positionDirection = (overrides.positionDirection as "LONG" | "SHORT" | undefined) ?? "LONG";
  const { instrumentId: _ignoredInstrumentId, positionDirection: _ignoredDirection, ...rest } = overrides;
  return createExecutionIntent({
    intentId: "intent-okx-runtime",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId,
    ...(instrumentId.endsWith("-PERP") ? { positionDirection } : {}),
    side: "buy",
    quantity: {
      asset: { symbol: "DOGE", type: "DIGITAL_ASSET" },
      quantity: "12.5",
    },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
    ...rest,
  });
}

function executionRecord() {
  return createExecutionRecord({
    executionId: "execution-query-okx",
    intentId: "intent-query-okx",
    executionAttemptId: "intent-query-okx",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    status: "PENDING_CONFIRMATION",
    remoteOrderId: "8001",
    createdAt: now,
    updatedAt: now,
  });
}

function orderReference(): OkxExecutionOrderReference {
  return {
    executionId: "execution-query-okx",
    intentId: "intent-query-okx",
    userId: "user-a",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    instId: "DOGE-USDT-SWAP",
    ordId: "8001",
    clOrdId: "sxokxquery0000000000000000000",
    createdAt: now,
    updatedAt: now,
  };
}

function okxCredentials() {
  return { apiKey: "okx-api-key", apiSecret: "okx-api-secret", passphrase: "okx-passphrase" };
}

function spotQueryFixture(service: FakeOkxRuntimeService, executionId: string) {
  const record = createExecutionRecord({
    executionId,
    intentId: `${executionId}-intent`,
    executionAttemptId: `${executionId}-intent`,
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-SPOT",
    status: "PENDING_CONFIRMATION",
    remoteOrderId: "8001",
    createdAt: now,
    updatedAt: now,
  });
  const records = new FakeExecutionRecordStore([record]);
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  references.create({
    executionId: record.executionId,
    intentId: record.intentId,
    userId: record.userId,
    accountId: record.accountId,
    instrumentId: record.instrumentId,
    instId: "DOGE-USDT",
    ordId: "8001",
    clOrdId: "sxokxspotquery0000000000000001",
    expectedProviderQuantity: "100",
    expectedSide: "buy",
    createdAt: now,
    updatedAt: now,
  });
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    records,
    references,
    { ...runtimeOptions(), clock: () => now + 200 },
  );
  return { runtime, record, records };
}
