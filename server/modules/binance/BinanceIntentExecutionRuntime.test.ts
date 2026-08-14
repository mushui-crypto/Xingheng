import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import { BinanceIntentExecutionCapability } from "./BinanceIntentExecutionCapability";
import { BinanceIntentExecutionRuntime } from "./BinanceIntentExecutionRuntime";
import { binanceExecutionIdempotencyKeyFor } from "./BinanceIntentExecutionService";
import type { BinanceOrderInput } from "./BinanceOrderManager";
import type { BinanceStoredOrder } from "./BinanceOrderStore";
import type { BinanceProviderOrder } from "./BinanceTypes";
import { snapshotFixture } from "./binanceTestFixtures";

const now = 1_800_000_000_000;

test("user A intent runs through user A Binance service", async () => {
  const registry = new FakeBinanceIntentRegistry({
    "user-a": new FakeBinanceIntentRuntimeService("binance:account-user-a"),
    "user-b": new FakeBinanceIntentRuntimeService("binance:account-user-b"),
  });
  const records = new FakeExecutionRecordStore();
  const runtime = new BinanceIntentExecutionRuntime(
    registry,
    { maxSlippageBps: 20 },
    records,
    { clock: () => now, createExecutionId: () => "execution-1" },
  );

  const result = await runtime.execute(executionIntent({
    userId: "user-a",
    accountId: "binance:account-user-a",
  }));

  assert.equal(result.execution.status, "SUCCEEDED");
  assert.equal(result.executionRecord.executionId, "execution-1");
  assert.equal(result.executionRecord.intentId, "intent-user-1");
  assert.equal(result.executionRecord.status, "CONFIRMED");
  assert.equal(result.executionRecord.executionAttemptId, "intent-user-1");
  assert.equal(result.executionRecord.remoteOrderId, "binance-order-1");
  assert.deepEqual(records.created.map((record) => record.status), ["CREATED"]);
  assert.deepEqual(records.updated.map((record) => record.status), ["CONFIRMED"]);
  assert.deepEqual(registry.runUserIds, ["user-a"]);
  assert.equal(registry.services["user-a"]!.providerMutations, 1);
  assert.equal(registry.services["user-b"]!.providerMutations, 0);
});

test("account mismatch rejects before provider mutation or capability creation", async () => {
  let capabilityCreations = 0;
  const service = new FakeBinanceIntentRuntimeService("binance:actual-account");
  const runtime = new BinanceIntentExecutionRuntime(
    new FakeBinanceIntentRegistry({ "user-a": service }),
    { maxSlippageBps: 20 },
    new FakeExecutionRecordStore(),
    {
      clock: () => now,
      createCapability: (intentService) => {
        capabilityCreations += 1;
        return new BinanceIntentExecutionCapability(intentService);
      },
    },
  );

  await assert.rejects(
    () => runtime.execute(executionIntent({
      userId: "user-a",
      accountId: "binance:wrong-account",
    })),
    /accountId does not match/u,
  );
  assert.equal(service.accountCalls, 1);
  assert.equal(service.marketCalls, 0);
  assert.equal(service.providerMutations, 0);
  assert.equal(capabilityCreations, 0);
});

test("venue mismatch rejects before registry lookup or provider mutation", async () => {
  const service = new FakeBinanceIntentRuntimeService("binance:account-user-a");
  const registry = new FakeBinanceIntentRegistry({ "user-a": service });
  const runtime = new BinanceIntentExecutionRuntime(registry, { maxSlippageBps: 20 }, new FakeExecutionRecordStore());

  await assert.rejects(
    () => runtime.execute(executionIntent({
      venue: "okx",
      accountId: "okx:account-user-a",
    })),
    /Unsupported execution venue: okx/u,
  );
  assert.deepEqual(registry.runUserIds, []);
  assert.equal(service.providerMutations, 0);
});

test("creates a fresh capability for each explicit runtime call", async () => {
  let capabilityCreations = 0;
  const service = new FakeBinanceIntentRuntimeService("binance:account-user-a");
  const runtime = new BinanceIntentExecutionRuntime(
    new FakeBinanceIntentRegistry({ "user-a": service }),
    { maxSlippageBps: 20 },
    new FakeExecutionRecordStore(),
    {
      clock: () => now,
      createCapability: (intentService) => {
        capabilityCreations += 1;
        return new BinanceIntentExecutionCapability(intentService);
      },
    },
  );

  await runtime.execute(executionIntent({ intentId: "intent-user-1" }));
  await runtime.execute(executionIntent({ intentId: "intent-user-2" }));

  assert.equal(capabilityCreations, 2);
  assert.equal(service.providerMutations, 2);
});

test("saves FAILED without a provider mutation when capability rejects execution", async () => {
  const service = new FakeBinanceIntentRuntimeService("binance:account-user-a");
  const records = new FakeExecutionRecordStore();
  const runtime = new BinanceIntentExecutionRuntime(
    new FakeBinanceIntentRegistry({ "user-a": service }),
    { maxSlippageBps: 20 },
    records,
    {
      clock: () => now,
      createExecutionId: () => "execution-failed",
      createCapability: () => ({
        async execute(intent) {
          return { executionAttemptId: intent.intentId, state: "FAILED" as const };
        },
      }),
    },
  );

  const result = await runtime.execute(executionIntent());

  assert.equal(result.executionRecord.status, "FAILED");
  assert.equal(result.executionRecord.executionId, "execution-failed");
  assert.equal(result.executionRecord.intentId, "intent-user-1");
  assert.equal(records.updated[0]?.status, "FAILED");
  assert.equal(service.providerMutations, 0);
});

test("saves UNKNOWN when capability throws before provider mutation", async () => {
  const service = new FakeBinanceIntentRuntimeService("binance:account-user-a");
  const records = new FakeExecutionRecordStore();
  const runtime = new BinanceIntentExecutionRuntime(
    new FakeBinanceIntentRegistry({ "user-a": service }),
    { maxSlippageBps: 20 },
    records,
    {
      clock: () => now,
      createExecutionId: () => "execution-unknown",
      createCapability: () => ({
        async execute() {
          throw new Error("RiskGuard rejected before provider mutation.");
        },
      }),
    },
  );

  const result = await runtime.execute(executionIntent());

  assert.equal(result.execution.status, "CALL_FAILED");
  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(result.executionRecord.executionId, "execution-unknown");
  assert.equal(records.updated[0]?.status, "UNKNOWN");
  assert.equal(service.providerMutations, 0);
});

test("queries a user-bound local order fact and updates ExecutionRecord without provider mutation", async () => {
  const record = queryRecord();
  const records = new FakeExecutionRecordStore([record]);
  const service = new FakeBinanceIntentRuntimeService("binance:account-user-a");
  service.orders = [queryStoredOrder(record, { status: "PartiallyFilled", filledQuantity: 0.0015 })];
  const runtime = new BinanceIntentExecutionRuntime(
    new FakeBinanceIntentRegistry({ "user-a": service }),
    { maxSlippageBps: 20 },
    records,
    { clock: () => now + 1_000 },
  );

  const result = await runtime.query("user-a", "execution-query-1");

  assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(result.observation.filledBaseQuantity, "0.0015");
  assert.equal(records.updated.at(-1)?.executionId, "execution-query-1");
  assert.equal(service.orderStateReads, 1);
  assert.equal(service.providerMutations, 0);
});

test("reconciles a user-bound remote order fact and updates ExecutionRecord without provider mutation", async () => {
  const record = queryRecord();
  const records = new FakeExecutionRecordStore([record]);
  const service = new FakeBinanceIntentRuntimeService("binance:account-user-a");
  service.orders = [queryStoredOrder(record, { status: "New", filledQuantity: 0 })];
  service.remoteOrder = providerOrder({ status: "PartiallyFilled", filledQuantity: 0.0015 });
  const runtime = new BinanceIntentExecutionRuntime(
    new FakeBinanceIntentRegistry({ "user-a": service }),
    { maxSlippageBps: 20 },
    records,
    { clock: () => now + 2_000 },
  );

  const result = await runtime.reconcile("user-a", "execution-query-1");

  assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(result.observation?.filledBaseQuantity, "0.0015");
  assert.equal(result.terminalShortCircuit, false);
  assert.equal(records.updated.at(-1)?.executionId, "execution-query-1");
  assert.deepEqual(service.providerQueries, [{
    category: "linear",
    symbol: "XAUTUSDT",
    clientOrderId: "binance-client-query-1",
  }]);
  assert.equal(service.providerMutations, 0);
});

test("confirmed reconciliation short-circuits before registry or provider access", async () => {
  const confirmed = createExecutionRecord({ ...queryRecord(), status: "CONFIRMED" });
  const records = new FakeExecutionRecordStore([confirmed]);
  const service = new FakeBinanceIntentRuntimeService("binance:account-user-a");
  const registry = new FakeBinanceIntentRegistry({ "user-a": service });
  const runtime = new BinanceIntentExecutionRuntime(
    registry,
    { maxSlippageBps: 20 },
    records,
    { clock: () => now + 2_000 },
  );

  const result = await runtime.reconcile("user-a", "execution-query-1");

  assert.equal(result.executionRecord, confirmed);
  assert.equal(result.observation, null);
  assert.equal(result.terminalShortCircuit, true);
  assert.deepEqual(registry.runUserIds, []);
  assert.equal(records.updated.length, 0);
  assert.equal(service.providerQueries.length, 0);
  assert.equal(service.providerMutations, 0);
});

test("reconciliation rejects user and account mismatch before remote order GET", async () => {
  const record = queryRecord();
  const records = new FakeExecutionRecordStore([record]);
  const service = new FakeBinanceIntentRuntimeService("binance:other-account");
  service.orders = [queryStoredOrder(record, { status: "New" })];
  const runtime = new BinanceIntentExecutionRuntime(
    new FakeBinanceIntentRegistry({ "user-a": service }),
    { maxSlippageBps: 20 },
    records,
  );

  await assert.rejects(
    () => runtime.reconcile("user-b", "execution-query-1"),
    /not found for the authenticated user/u,
  );
  await assert.rejects(
    () => runtime.reconcile("user-a", "execution-query-1"),
    /accountId does not match/u,
  );
  assert.equal(service.providerQueries.length, 0);
  assert.equal(service.providerMutations, 0);
});

test("pending execution can be explicitly cancelled through the bound OrderManager path", async () => {
  const record = queryRecord();
  const records = new FakeExecutionRecordStore([record]);
  const service = new FakeBinanceIntentRuntimeService("binance:account-user-a");
  service.cancelResult = providerOrder({ status: "Cancelled" });
  const runtime = new BinanceIntentExecutionRuntime(
    new FakeBinanceIntentRegistry({ "user-a": service }),
    { maxSlippageBps: 20 },
    records,
    { clock: () => now + 2_000 },
  );

  const result = await runtime.cancel("user-a", "execution-query-1");

  assert.equal(result.observation.state, "CANCELLED");
  assert.equal(result.executionRecord.status, "FAILED");
  assert.equal(records.updated.at(-1)?.status, "FAILED");
  assert.equal(service.providerMutations, 1);
});

test("unknown execution preserves UNKNOWN after an ambiguous explicit cancel", async () => {
  const record = queryRecord();
  const records = new FakeExecutionRecordStore([record]);
  const service = new FakeBinanceIntentRuntimeService("binance:account-user-a");
  service.cancelResult = new Error("cancel result unavailable");
  const runtime = new BinanceIntentExecutionRuntime(
    new FakeBinanceIntentRegistry({ "user-a": service }),
    { maxSlippageBps: 20 },
    records,
    { clock: () => now + 2_000 },
  );

  const result = await runtime.cancel("user-a", "execution-query-1");

  assert.equal(result.observation.state, "UNKNOWN");
  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(service.providerMutations, 1);
});

test("cancel rejects terminal, user-mismatched, and account-mismatched records before provider mutation", async () => {
  for (const status of ["CONFIRMED", "FAILED"] as const) {
    const record = createExecutionRecord({ ...queryRecord(), status });
    const service = new FakeBinanceIntentRuntimeService("binance:account-user-a");
    const runtime = new BinanceIntentExecutionRuntime(
      new FakeBinanceIntentRegistry({ "user-a": service }),
      { maxSlippageBps: 20 },
      new FakeExecutionRecordStore([record]),
    );
    await assert.rejects(() => runtime.cancel("user-a", "execution-query-1"), /cannot be cancelled/u);
    assert.equal(service.providerMutations, 0);
  }

  const record = queryRecord();
  const service = new FakeBinanceIntentRuntimeService("binance:other-account");
  const runtime = new BinanceIntentExecutionRuntime(
    new FakeBinanceIntentRegistry({ "user-a": service }),
    { maxSlippageBps: 20 },
    new FakeExecutionRecordStore([record]),
  );
  await assert.rejects(() => runtime.cancel("user-b", "execution-query-1"), /not found/u);
  await assert.rejects(() => runtime.cancel("user-a", "execution-query-1"), /accountId does not match/u);
  assert.equal(service.providerMutations, 0);
});

test("legacy capability files are removed and runtime has no old execution dependency", () => {
  assert.equal(existsSync(new URL("./BinanceExecutionCapability.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL(
    "../cex/funding-arbitrage/FundingArbitrageExecutionCapability.ts",
    import.meta.url,
  )), false);

  const source = readFileSync(new URL("./BinanceIntentExecutionRuntime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /BinanceClient|BinanceRiskGuard|Credential|Scheduler|Worker|Queue|FundingArbitrage|BinanceExecutionCapability/u);
  assert.doesNotMatch(source, /setInterval|setTimeout|fetch\(|new\s+BinancePersonalTradingService/u);
});

class FakeBinanceIntentRegistry {
  readonly runUserIds: string[] = [];

  constructor(readonly services: Record<string, FakeBinanceIntentRuntimeService>) {}

  async run<T>(
    userId: string,
    operation: (service: FakeBinanceIntentRuntimeService) => Promise<T> | T,
  ): Promise<T> {
    this.runUserIds.push(userId);
    const service = this.services[userId];
    if (!service) throw new Error(`Missing service for ${userId}.`);
    return operation(service);
  }
}

class FakeExecutionRecordStore {
  readonly created: ExecutionRecord[] = [];
  readonly updated: ExecutionRecord[] = [];
  private readonly records = new Map<string, ExecutionRecord>();

  constructor(records: readonly ExecutionRecord[] = []) {
    for (const record of records) this.records.set(record.executionId, record);
  }

  create(record: ExecutionRecord) {
    this.created.push(record);
    this.records.set(record.executionId, record);
  }

  update(record: ExecutionRecord) {
    this.updated.push(record);
    this.records.set(record.executionId, record);
  }

  loadForUser(userId: string, executionId: string) {
    const record = this.records.get(executionId);
    return record?.userId === userId ? record : null;
  }
}

class FakeBinanceIntentRuntimeService {
  readonly placeInputs: BinanceOrderInput[] = [];
  accountCalls = 0;
  marketCalls = 0;
  orderStateReads = 0;
  providerMutations = 0;
  readonly providerQueries: Array<{ category: "spot" | "linear"; symbol: string; clientOrderId: string }> = [];
  orders: BinanceStoredOrder[] = [];
  remoteOrder: BinanceProviderOrder | null | Error = providerOrder();
  cancelResult: BinanceProviderOrder | Error = providerOrder({ status: "Cancelled" });

  constructor(private readonly accountId: string) {}

  async account() {
    this.accountCalls += 1;
    return snapshotFixture({ accountId: this.accountId });
  }

  async executionAccountIdentity() {
    const snapshot = await this.account();
    return {
      accountId: snapshot.accountId,
      accountFingerprint: snapshot.accountFingerprint,
      uidSnapshot: snapshot.uidSnapshot ?? "uid-test",
      accountMode: "single_asset_one_way" as const,
      ipWhitelistVerificationMode: "provider_list_exact" as const,
      permissions: snapshot.permissions,
    };
  }

  async market() {
    this.marketCalls += 1;
    const snapshot = snapshotFixture();
    return {
      fetchedAt: snapshot.fetchedAt,
      productAvailability: snapshot.productAvailability,
      spot: snapshot.spot,
      perpetual: snapshot.perpetual,
      fees: snapshot.fees,
    };
  }

  async loadExecutionReadContext(instrumentId: string) {
    return xautExecutionContext(instrumentId);
  }

  async placeExecutionOrder(
    input: BinanceOrderInput,
    beforeProviderMutation?: (riskValuationPrice: number) => void | Promise<void>,
  ) {
    await beforeProviderMutation?.(input.limitPrice === undefined ? 1_004.1 : Number(input.limitPrice));
    this.providerMutations += 1;
    this.placeInputs.push(input);
    return providerOrder();
  }

  ordersState() {
    this.orderStateReads += 1;
    return { orders: this.orders };
  }

  async findExecutionOrderByClientOrderId(category: "spot" | "linear", symbol: string, clientOrderId: string) {
    this.providerQueries.push({ category, symbol, clientOrderId });
    if (this.remoteOrder instanceof Error) throw this.remoteOrder;
    return this.remoteOrder;
  }

  async cancelOrder() {
    this.providerMutations += 1;
    if (this.cancelResult instanceof Error) throw this.cancelResult;
    return this.cancelResult;
  }
}

function executionIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionIntent({
    intentId: "intent-user-1",
    userId: "user-a",
    venue: "binance",
    accountId: "binance:account-user-a",
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

function providerOrder(overrides: Partial<BinanceProviderOrder> = {}): BinanceProviderOrder {
  return {
    orderId: "binance-order-1",
    orderLinkId: "binance-client-order-1",
    status: "Filled",
    requestedQuantity: 0.002,
    filledQuantity: 0.002,
    averagePrice: 1_004,
    feeUsd: 0,
    updatedAt: now + 1_000,
    ...overrides,
  };
}

function queryRecord() {
  return createExecutionRecord({
    executionId: "execution-query-1",
    intentId: "intent-query-1",
    executionAttemptId: "intent-query-1",
    remoteOrderId: "binance-order-query-1",
    userId: "user-a",
    venue: "binance",
    accountId: "binance:account-user-a",
    instrumentId: "XAUT-USDT-PERP",
    status: "UNKNOWN",
    createdAt: now - 1_000,
    updatedAt: now,
  });
}

function queryStoredOrder(
  record: ExecutionRecord,
  orderOverrides: Partial<BinanceProviderOrder>,
): BinanceStoredOrder {
  const order = providerOrder({
    orderId: "binance-order-query-1",
    orderLinkId: "binance-client-query-1",
    updatedAt: now + 1_000,
    ...orderOverrides,
  });
  return {
    idempotencyKey: binanceExecutionIdempotencyKeyFor(record),
    requestFingerprint: "query-request-fingerprint",
    clientOrderId: order.orderLinkId,
    providerOrderId: order.orderId,
    category: "linear",
    symbol: "XAUTUSDT",
    executionMode: "production_ioc",
    status: "processing",
    order,
    error: null,
    cancelRequestedAt: null,
    createdAt: now - 1_000,
    updatedAt: now + 1_000,
  };
}

function xautExecutionContext(instrumentId: string) {
  const spot = instrumentId.endsWith("-SPOT");
  return {
    instrument: {
      instrumentId,
      venue: "binance" as const,
      providerSymbol: "XAUTUSDT",
      baseAsset: { symbol: "XAUT", type: "RWA_ASSET" as const },
      quoteAsset: "USDT",
      ...(spot ? {} : { settlementAsset: "USDT" }),
      marketType: spot ? "spot" as const : "perpetual" as const,
      contractType: spot ? "spot" as const : "linear_perpetual" as const,
      quantityUnit: "base" as const,
      contractSize: "1" as const,
      status: "trading" as const,
    },
    tradingRules: {
      quantityStep: "0.001",
      minQuantity: "0.001",
      priceTick: spot ? "1" : "0.1",
      minNotional: "5",
      precision: {},
    },
    quote: { bid: spot ? "999" : "1000", ask: spot ? "1001" : "1002", fetchedAt: now },
  };
}
