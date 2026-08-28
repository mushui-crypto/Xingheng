import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { assertNoDuplicateMutationContract } from "../cex/RuntimeLifecycleContractAssertions";
import {
  InMemoryOkxExecutionOrderReferenceStore,
  type OkxExecutionOrderRecoveryReference,
  type OkxExecutionOrderReference,
  type OkxExecutionOrderReferenceStore,
} from "./OkxExecutionOrderReferenceStore";
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

test("Provider success upgrades the recovery anchor to a complete OKX order reference", async () => {
  const service = new FakeOkxRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new FailingCompleteReferenceStore(0);
  const runtime = runtimeFor(service, records, references, "execution-reference-success");
  const executionIntent = intent("intent-reference-success");

  const result = await runtime.execute(executionIntent);

  assert.equal(result.execution.status, "SUCCEEDED");
  assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(result.orderReference?.ordId, "9101");
  assert.equal(service.placeMutations, 1);
  assert.equal(await references.loadRecoveryForUser("user-a", "execution-reference-success"), null);
  assert.deepEqual(
    await references.loadForUser("user-a", "execution-reference-success"),
    result.orderReference,
  );
});

test("Provider success plus complete-reference persistence failure enters recoverable UNKNOWN", async () => {
  const service = new FakeOkxRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new FailingCompleteReferenceStore(1);
  const runtime = runtimeFor(service, records, references, "execution-reference-failure");
  const executionIntent = intent("intent-reference-failure");

  const result = await runtime.execute(executionIntent);

  assert.equal(result.execution.status, "SUCCEEDED");
  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(result.orderReference, null);
  assert.equal(service.placeMutations, 1);
  assert.equal(await references.loadForUser("user-a", "execution-reference-failure"), null);
  assert.deepEqual(
    await references.loadRecoveryForUser("user-a", "execution-reference-failure"),
    recoveryReference(result.executionRecord, okxClientOrderIdFor(executionIntent)),
  );
});

test("a restarted runtime recovers ordId by clOrdId and never repeats placeOrder", async () => {
  const service = new FakeOkxRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new FailingCompleteReferenceStore(1);
  const executionId = "execution-reference-recovery";
  const executionIntent = intent("intent-reference-recovery");
  const firstRuntime = runtimeFor(service, records, references, executionId);
  const submitted = await firstRuntime.execute(executionIntent);
  assert.equal(submitted.executionRecord.status, "UNKNOWN");
  const mutationsBeforeRecovery = service.providerMutations;

  const restartedRuntime = runtimeFor(service, records, references, "unused-after-restart");
  const recovered = await restartedRuntime.reconcile("user-a", executionId);

  assert.equal(recovered.executionRecord.status, "CONFIRMED");
  assert.equal(recovered.observation?.filledBaseQuantity, "12.5");
  assert.equal(recovered.orderReference?.ordId, "9101");
  assert.equal(recovered.orderReference?.clOrdId, okxClientOrderIdFor(executionIntent));
  assert.deepEqual(service.getRequests, [{
    instId: "DOGE-USDT-SWAP",
    clOrdId: okxClientOrderIdFor(executionIntent),
  }]);
  assert.equal(service.placeMutations, 1);
  assert.equal(service.providerMutations, mutationsBeforeRecovery);
  assertNoDuplicateMutationContract({
    mutationCountBeforeRecovery: mutationsBeforeRecovery,
    mutationCountAfterRecovery: service.providerMutations,
  });
  assert.equal(service.cancelMutations, 0);
  assert.equal(await references.loadRecoveryForUser("user-a", executionId), null);
  assert.equal((await references.loadForUser("user-a", executionId))?.ordId, "9101");
});

test("failed clOrdId recovery remains UNKNOWN without any repeated Provider mutation", async () => {
  const service = new FakeOkxRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new FailingCompleteReferenceStore(1);
  const executionId = "execution-reference-recovery-failure";
  const runtime = runtimeFor(service, records, references, executionId);
  const submitted = await runtime.execute(intent("intent-reference-recovery-failure"));
  assert.equal(submitted.executionRecord.status, "UNKNOWN");
  service.queryError = new Error("fake OKX order lookup unavailable");
  const mutationsBeforeRecovery = service.providerMutations;

  const first = await runtime.reconcile("user-a", executionId);
  const second = await runtime.reconcile("user-a", executionId);

  assert.equal(first.executionRecord.status, "UNKNOWN");
  assert.equal(first.observation?.state, "UNKNOWN");
  assert.equal(first.orderReference, null);
  assert.equal(second.executionRecord.status, "UNKNOWN");
  assert.equal(service.getRequests.length, 2);
  assert.equal(service.placeMutations, 1);
  assert.equal(service.providerMutations, mutationsBeforeRecovery);
  assert.equal(service.cancelMutations, 0);
  assert.notEqual(await references.loadRecoveryForUser("user-a", executionId), null);
});

test("Provider placeOrder failure remains CALL_FAILED and never creates a complete reference", async () => {
  const service = new FakeOkxRuntimeService();
  service.placeError = new Error("fake OKX placeOrder failure");
  const records = new MemoryExecutionRecordStore();
  const references = new FailingCompleteReferenceStore(0);
  const executionId = "execution-provider-failure";
  const runtime = runtimeFor(service, records, references, executionId);

  const result = await runtime.execute(intent("intent-provider-failure"));

  assert.equal(result.execution.status, "CALL_FAILED");
  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(result.orderReference, null);
  assert.equal(service.placeMutations, 1);
  assert.equal(await references.loadForUser("user-a", executionId), null);
  assert.notEqual(await references.loadRecoveryForUser("user-a", executionId), null);
});

test("recovery-anchor persistence failure blocks placeOrder before Provider mutation", async () => {
  const service = new FakeOkxRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new FailingCompleteReferenceStore(0, 1);
  const executionId = "execution-recovery-anchor-failure";
  const runtime = runtimeFor(service, records, references, executionId);

  const result = await runtime.execute(intent("intent-recovery-anchor-failure"));

  assert.equal(result.execution.status, "CALL_FAILED");
  assert.equal(result.executionRecord.status, "FAILED");
  assert.equal(service.placeMutations, 0);
  assert.equal(service.cancelMutations, 0);
  assert.equal(service.providerMutations, 0);
  assert.equal(await references.loadForUser("user-a", executionId), null);
  assert.equal(await references.loadRecoveryForUser("user-a", executionId), null);
});

function runtimeFor(
  service: FakeOkxRuntimeService,
  records: MemoryExecutionRecordStore,
  references: OkxExecutionOrderReferenceStore,
  executionId: string,
) {
  return new OkxIntentExecutionRuntime(
    { run: async (_userId, operation) => operation(service) },
    records,
    references,
    {
      createExecutionId: () => executionId,
      clock: () => now,
      quantityRulesSource: okxTestQuantityRulesSource(now),
      mutationSafetyGuard: new ExecutionMutationSafetyGuard({
        liveTradingEnabled: true,
        killSwitchActive: false,
      }),
    },
  );
}

class FakeOkxRuntimeService {
  readonly placeRequests: OkxPlaceOrderRequest[] = [];
  readonly getRequests: OkxGetOrderRequest[] = [];
  readonly cancelRequests: OkxCancelOrderRequest[] = [];
  placeError: Error | null = null;
  queryError: Error | null = null;

  get placeMutations() {
    return this.placeRequests.length;
  }

  get cancelMutations() {
    return this.cancelRequests.length;
  }

  get providerMutations() {
    return this.placeMutations + this.cancelMutations;
  }

  executionAccountIdentity() {
    return { accountId: "okx:account-user-a" };
  }

  async readPositionMode() {
    return "ONE_WAY" as const;
  }

  validateExecutionProviderIdentity() {}

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeRequests.push(request);
    if (this.placeError) throw this.placeError;
    return { instId: request.instId, ordId: "9101", clOrdId: request.clOrdId };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    this.getRequests.push(request);
    if (this.queryError) throw this.queryError;
    return {
      instId: request.instId,
      ordId: "9101",
      clOrdId: request.clOrdId ?? "missing-clordid",
      status: "CONFIRMED",
      statusReason: null,
      rawState: "filled",
      side: "buy",
      posSide: "net",
      reduceOnly: false,
      tdMode: "cross",
      requestedQuantity: "125",
      filledQuantity: "125",
      averagePrice: "0.123",
      fee: "-0.001",
      updatedAt: now,
    };
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    this.cancelRequests.push(request);
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9101",
      clOrdId: request.clOrdId ?? "missing-clordid",
    };
  }
}

class FailingCompleteReferenceStore implements OkxExecutionOrderReferenceStore {
  private readonly references = new InMemoryOkxExecutionOrderReferenceStore();

  constructor(
    private completeFailuresRemaining: number,
    private recoveryFailuresRemaining = 0,
  ) {}

  create(reference: OkxExecutionOrderReference) {
    if (this.completeFailuresRemaining > 0) {
      this.completeFailuresRemaining -= 1;
      throw new Error("fake complete reference persistence failure");
    }
    this.references.create(reference);
  }

  createRecovery(reference: OkxExecutionOrderRecoveryReference) {
    if (this.recoveryFailuresRemaining > 0) {
      this.recoveryFailuresRemaining -= 1;
      throw new Error("fake recovery reference persistence failure");
    }
    this.references.createRecovery(reference);
  }

  loadForUser(userId: string, executionId: string) {
    return this.references.loadForUser(userId, executionId);
  }

  loadRecoveryForUser(userId: string, executionId: string) {
    return this.references.loadRecoveryForUser(userId, executionId);
  }
}

class MemoryExecutionRecordStore implements ExecutionRecordStore {
  private readonly records = new Map<string, ExecutionRecord>();

  create(record: ExecutionRecord) {
    this.records.set(key(record.userId, record.executionId), record);
  }

  update(record: ExecutionRecord) {
    this.records.set(key(record.userId, record.executionId), record);
  }

  loadForUser(userId: string, executionId: string) {
    return this.records.get(key(userId, executionId)) ?? null;
  }
}

function intent(intentId: string) {
  return createExecutionIntent({
    intentId,
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    positionDirection: "LONG",
    side: "buy",
    quantity: {
      asset: { symbol: "DOGE", type: "DIGITAL_ASSET" },
      quantity: "12.5",
    },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
  });
}

function recoveryReference(
  record: ExecutionRecord,
  clOrdId: string,
): OkxExecutionOrderRecoveryReference {
  return {
    executionId: record.executionId,
    intentId: record.intentId,
    userId: record.userId,
    accountId: record.accountId,
    instrumentId: record.instrumentId,
    instId: "DOGE-USDT-SWAP",
    clOrdId,
    expectedProviderQuantity: "125",
    expectedSide: "buy",
    positionMode: "ONE_WAY",
    positionDirection: "LONG",
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
  };
}

function key(userId: string, executionId: string) {
  return `${userId}\u0000${executionId}`;
}
