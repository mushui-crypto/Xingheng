import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import {
  InMemoryOkxExecutionOrderReferenceStore,
  type OkxExecutionOrderReference,
} from "./OkxExecutionOrderReferenceStore";
import { OkxIntentExecutionRuntime } from "./OkxIntentExecutionRuntime";
import { okxClientOrderIdFor } from "./OkxIntentExecutionService";
import type {
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "./OkxTypes";

const now = 1_800_000_000_000;
const fakeMutationGuard = () => new ExecutionMutationSafetyGuard({ liveTradingEnabled: true, killSwitchActive: false });

test("runtime submits through the authenticated user's OKX service and saves order identity", async () => {
  const serviceA = new FakeOkxRuntimeService("okx:account-user-a");
  const serviceB = new FakeOkxRuntimeService("okx:account-user-b");
  const records = new FakeExecutionRecordStore();
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": serviceA, "user-b": serviceB }),
    records,
    references,
    { clock: () => now, createExecutionId: () => "execution-okx-1", mutationSafetyGuard: fakeMutationGuard() },
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

test("runtime close rejects missing reduceOnly before provider mutation", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    new FakeExecutionRecordStore(),
    new InMemoryOkxExecutionOrderReferenceStore(),
  );

  await assert.rejects(
    () => runtime.close(executionIntent({ userId: "user-a", accountId: "okx:account-user-a" })),
    /requires reduceOnly=true/u,
  );
  assert.equal(service.placeRequests.length, 0);
});

test("runtime close sends reduceOnly=true for perpetual close", async () => {
  const service = new FakeOkxRuntimeService("okx:account-user-a");
  const runtime = new OkxIntentExecutionRuntime(
    new FakeOkxRuntimeRegistry({ "user-a": service }),
    new FakeExecutionRecordStore(),
    new InMemoryOkxExecutionOrderReferenceStore(),
    { clock: () => now, createExecutionId: () => "execution-close-1", mutationSafetyGuard: fakeMutationGuard() },
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
    { clock: () => now + 1_000 },
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

  constructor(private readonly accountId: string) {}

  executionAccountIdentity() {
    return { accountId: this.accountId };
  }

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeRequests.push(request);
    return {
      instId: request.instId,
      ordId: "8001",
      clOrdId: request.clOrdId,
    };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    this.getRequests.push(request);
    return {
      instId: request.instId,
      ordId: request.ordId ?? "8001",
      clOrdId: request.clOrdId ?? "sxokxquery0000000000000000000",
      status: this.orderState === "filled" ? "CONFIRMED" : "PENDING_CONFIRMATION",
      statusReason: null,
      rawState: this.orderState,
      requestedQuantity: "12.5",
      filledQuantity: this.orderState === "filled" ? "12.5" : "1.25",
      averagePrice: "0.123",
      fee: "-0.001",
      updatedAt: now + 100,
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
  return createExecutionIntent({
    intentId: "intent-okx-runtime",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    side: "buy",
    quantity: {
      asset: { symbol: "DOGE", type: "DIGITAL_ASSET" },
      quantity: "12.5",
    },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
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
