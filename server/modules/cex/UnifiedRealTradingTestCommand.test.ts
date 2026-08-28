import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FormalExecutionRuntimeRegistry, formalExecutionRuntime } from "../arbitrage-execution/FormalExecutionRuntimeRegistry";
import type { FormalExecutionRuntime } from "../arbitrage-execution/FormalExecutionRuntime";
import { createAssetQuantity } from "./AssetQuantity";
import type { ExecutionQuantityPlan } from "./ExecutionQuantityPlanner";
import { createExecutionRecord, type ExecutionRecord } from "./ExecutionRecord";
import type { ExecutionRecordStore } from "./ExecutionRecordStore";
import {
  UnifiedRealTradingTestCommand,
  UnifiedRealTradingTestMutationSafetyGuard,
  unifiedRealTradingTestExecutionId,
  unifiedRealTradingTestIntentId,
  type UnifiedRealTradingTestRequest,
  type UnifiedRealTradingTestVenuePreparation,
} from "./UnifiedRealTradingTestCommand";
import { InMemoryOkxExecutionOrderReferenceStore } from "../okx/OkxExecutionOrderReferenceStore";
import { OkxFormalArbitrageExecutionRuntime } from "../okx/OkxFormalArbitrageExecutionRuntime";
import { OkxIntentExecutionRuntime } from "../okx/OkxIntentExecutionRuntime";
import { okxTestQuantityRulesSource } from "../okx/OkxTestFixtures";
import { BinanceFormalArbitrageExecutionRuntime } from "../arbitrage-execution/BinanceFormalArbitrageExecutionRuntime";
import { BinanceIntentExecutionRuntime } from "../binance/BinanceIntentExecutionRuntime";
import type { BinanceGenericExecutionContext } from "../binance/BinanceGenericExecutionReadContext";
import type { BinanceOrderInput } from "../binance/BinanceOrderManager";
import type { BinanceStoredOrder } from "../binance/BinanceOrderStore";
import type { BinanceProviderOrder } from "../binance/BinanceTypes";
import { snapshotFixture } from "../binance/binanceTestFixtures";
import type {
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "../okx/OkxTypes";

const now = 1_800_000_000_000;

test("preview generates a canonical ExecutionIntent without entering the formal runtime", async () => {
  const runtime = new FakeFormalRuntime();
  const records = new MemoryExecutionRecordStore();
  const command = commandFor(runtime, records, preparation());

  const result = await command.run(request({ executeLive: false, reduceOnly: true }));

  assert.equal(result.action, "PREVIEW");
  assert.equal(result.runtimeResult, null);
  assert.equal(runtime.executeCalls.length, 0);
  assert.equal(result.intent.venue, "okx");
  assert.equal(result.intent.instrumentId, "DOGE-USDT-PERP");
  assert.equal(result.intent.side, "buy");
  assert.equal(result.intent.quantity.quantity, "80");
  assert.equal(result.intent.orderConstraints.reduceOnly, true);
  assert.equal(result.intent.executionMode, "EXECUTION_PRIORITY");
});

test("existing intent is reconciled through the formal runtime instead of being submitted again", async () => {
  const runtime = new FakeFormalRuntime();
  const records = new MemoryExecutionRecordStore();
  const input = request();
  const command = commandFor(runtime, records, preparation());
  const preview = await command.run({ ...input, executeLive: false });
  const executionId = unifiedRealTradingTestExecutionId(preview.intent);
  records.create(record({ intentId: preview.intent.intentId, executionId }));

  const result = await command.run(input);

  assert.equal(result.action, "RECONCILED");
  assert.equal(runtime.executeCalls.length, 0);
  assert.deepEqual(runtime.reconcileCalls, [{ userId: "user-a", executionId }]);
});

test("real command sends OKX Spot and Perpetual intents through the formal runtime", async () => {
  const fixture = okxFixture(new UnifiedRealTradingTestMutationSafetyGuard({
    liveTradingEnabled: true,
    killSwitchActive: false,
  }));

  const perpetual = await fixture.command.run(request({ requestId: "perpetual-long", instrumentId: "DOGE-USDT-PERP" }));
  const spot = await fixture.command.run(request({ requestId: "spot-buy", instrumentId: "DOGE-USDT-SPOT" }));

  assert.equal(perpetual.action, "EXECUTED");
  assert.equal(spot.action, "EXECUTED");
  assert.deepEqual(fixture.provider.placeRequests.map(({ instId, tdMode }) => ({ instId, tdMode })), [
    { instId: "DOGE-USDT-SWAP", tdMode: "cross" },
    { instId: "DOGE-USDT", tdMode: "cash" },
  ]);
  assert.equal(fixture.records.findByIntentId(perpetual.intent.intentId).length, 1);
  assert.equal(fixture.records.findByIntentId(spot.intent.intentId).length, 1);
});

test("real command dispatches Binance through the Formal Runtime registry", async () => {
  const runtime = new FakeFormalRuntime();
  const records = new MemoryExecutionRecordStore();
  const command = commandFor(runtime, records, preparationFor("binance"), undefined, "binance");

  const result = await command.run(request({
    venue: "binance",
    instrumentId: "DOGE-USDT-PERP",
    requestId: "binance-formal-dispatch",
  }));

  assert.equal(result.action, "EXECUTED");
  assert.equal(result.intent.venue, "binance");
  assert.equal(runtime.executeCalls.length, 1);
  assert.equal(runtime.executeCalls[0]?.venue, "binance");
});

test("Binance unified command recreates the real runtime and reconciles the deterministic execution without another place", async () => {
  const service = new FakeBinanceRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const input = request({
    venue: "binance",
    instrumentId: "DOGE-USDT-PERP",
    requestId: "binance-restart-recovery",
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "20" },
  });

  const first = await binanceCommand(service, records).run(input);
  const expectedExecutionId = unifiedRealTradingTestExecutionId(first.intent);
  const restarted = await binanceCommand(service, records).run(input);

  assert.equal(first.action, "EXECUTED");
  assert.equal(first.runtimeResult?.executionRecord.executionId, expectedExecutionId);
  assert.equal(records.loadForUser("user-a", expectedExecutionId)?.executionId, expectedExecutionId);
  assert.equal(service.placeCount, 1);
  assert.equal(restarted.action, "RECONCILED");
  assert.equal(restarted.runtimeResult?.executionRecord.executionId, expectedExecutionId);
  assert.equal(service.reconcileCount, 1);
  assert.equal(service.placeCount, 1);
});

for (const scenario of [
  { name: "side", overrides: { side: "sell" as const } },
  { name: "quantity", overrides: { quantityInput: { mode: "ASSET_QUANTITY" as const, quantity: "10" } } },
  { name: "reduceOnly", overrides: { reduceOnly: true } },
]) {
  test(`Binance unified recovery rejects changed ${scenario.name} before another place`, async () => {
    const service = new FakeBinanceRuntimeService();
    const records = new MemoryExecutionRecordStore();
    const input = request({
      venue: "binance",
      instrumentId: "DOGE-USDT-PERP",
      requestId: `binance-mismatch-${scenario.name}`,
      quantityInput: { mode: "ASSET_QUANTITY", quantity: "20" },
    });
    await binanceCommand(service, records).run(input);

    await assert.rejects(
      () => binanceCommand(service, records).run({ ...input, ...scenario.overrides }),
      /request semantics do not match/u,
    );

    assert.equal(service.placeCount, 1);
    assert.equal(service.reconcileCount, 0);
  });
}

test("live trading disabled and active kill switch return BLOCKED with Provider mutation at zero", async () => {
  for (const safety of [
    { liveTradingEnabled: false, killSwitchActive: false },
    { liveTradingEnabled: true, killSwitchActive: true },
  ]) {
    const fixture = okxFixture(new UnifiedRealTradingTestMutationSafetyGuard(safety));
    const result = await fixture.command.run(request({ requestId: `blocked-${String(safety.killSwitchActive)}` }));

    assert.equal(result.action, "BLOCKED");
    assert.equal(result.runtimeResult?.executionRecord.status, "FAILED");
    assert.equal(fixture.provider.placeRequests.length, 0);
    assert.equal(fixture.provider.cancelRequests.length, 0);
  }
});

for (const scenario of [
  { runtimeStatus: "FAILED", commandAction: "FAILED" },
  { runtimeStatus: "UNKNOWN", commandAction: "UNKNOWN" },
  { runtimeStatus: "CREATED", commandAction: "UNKNOWN" },
  { runtimeStatus: "SUBMITTED", commandAction: "UNKNOWN" },
] as const) {
  test(`an open safety state returns command-level ${scenario.commandAction} for formal runtime ${scenario.runtimeStatus}`, async () => {
    const { runtimeStatus, commandAction } = scenario;
    const runtime = new FakeFormalRuntime(runtimeStatus);
    const records = new MemoryExecutionRecordStore();
    const command = commandFor(
      runtime,
      records,
      preparation(),
      new UnifiedRealTradingTestMutationSafetyGuard({ liveTradingEnabled: true, killSwitchActive: false }),
    );

    const result = await command.run(request({ requestId: `remote-${runtimeStatus.toLowerCase()}` }));

    assert.equal(result.action, commandAction);
    assert.equal(result.runtimeResult?.executionRecord.status, runtimeStatus);
  });
}

test("re-running the same request reconciles the stored order and never repeats placeOrder", async () => {
  const fixture = okxFixture(new UnifiedRealTradingTestMutationSafetyGuard({
    liveTradingEnabled: true,
    killSwitchActive: false,
  }));
  const input = request({ requestId: "recover-same-request" });

  const first = await fixture.command.run(input);
  const second = await fixture.command.run(input);

  assert.equal(first.action, "EXECUTED");
  assert.equal(second.action, "RECONCILED");
  assert.equal(second.runtimeResult?.executionRecord.status, "CONFIRMED");
  assert.equal(fixture.provider.placeRequests.length, 1);
  assert.equal(fixture.provider.getRequests.length, 1);
  assert.equal(fixture.records.findByIntentId(first.intent.intentId).length, 1);
});

for (const scenario of [
  { name: "side", overrides: { side: "sell" as const } },
  { name: "quantity", overrides: { quantityInput: { mode: "ASSET_QUANTITY" as const, quantity: "40" } } },
  { name: "reduceOnly", overrides: { reduceOnly: true } },
  { name: "executionMode", overrides: { executionMode: "PRICE_PRIORITY" as const } },
]) {
  test(`same request-id with changed ${scenario.name} is rejected before another Provider mutation`, async () => {
    const fixture = okxFixture(new UnifiedRealTradingTestMutationSafetyGuard({
      liveTradingEnabled: true,
      killSwitchActive: false,
    }));
    const input = request({ requestId: `semantic-mismatch-${scenario.name}` });
    await fixture.command.run(input);
    const mutationsBeforeRetry = fixture.provider.placeRequests.length;

    await assert.rejects(
      () => fixture.command.run({ ...input, ...scenario.overrides }),
      /request semantics do not match/u,
    );

    assert.equal(fixture.provider.placeRequests.length, mutationsBeforeRetry);
    assert.equal(fixture.provider.getRequests.length, 0);
    assert.equal(fixture.provider.cancelRequests.length, 0);
  });
}

test("concurrent identical requests share a deterministic execution identity and only one reaches placeOrder", async () => {
  const fixture = okxFixture(new UnifiedRealTradingTestMutationSafetyGuard({
    liveTradingEnabled: true,
    killSwitchActive: false,
  }));
  const input = request({ requestId: "concurrent-same-request" });

  const outcomes = await Promise.allSettled([
    fixture.command.run(input),
    fixture.command.run(input),
  ]);

  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(fixture.provider.placeRequests.length, 1);
  assert.equal(fixture.records.findByIntentId(unifiedRealTradingTestIntentId(input)).length, 1);
});

test("test intent and execution identities are deterministic and user scoped", async () => {
  const first = request({ requestId: "stable" });
  const same = request({ requestId: "stable" });
  const otherUser = request({ requestId: "stable", userId: "user-b" });
  const firstId = unifiedRealTradingTestIntentId(first);
  const command = commandFor(new FakeFormalRuntime(), new MemoryExecutionRecordStore(), preparation());
  const firstIntent = (await command.run({ ...first, executeLive: false })).intent;
  const sameIntent = (await command.run({ ...same, executeLive: false })).intent;

  assert.equal(firstId, unifiedRealTradingTestIntentId(same));
  assert.notEqual(firstId, unifiedRealTradingTestIntentId(otherUser));
  assert.equal(unifiedRealTradingTestExecutionId(firstIntent), unifiedRealTradingTestExecutionId(sameIntent));
});

test("LONG and SHORT directions cannot share a deterministic execution identity", async () => {
  const command = commandFor(new FakeFormalRuntime(), new MemoryExecutionRecordStore(), preparation());
  const base = (await command.run({ ...request({ requestId: "direction-identity" }), executeLive: false })).intent;
  const short = { ...base, side: "sell" as const, positionDirection: "SHORT" as const };
  assert.notEqual(unifiedRealTradingTestExecutionId(base), unifiedRealTradingTestExecutionId(short));
});

function commandFor(
  runtime: FormalExecutionRuntime,
  records: MemoryExecutionRecordStore,
  venuePreparation: UnifiedRealTradingTestVenuePreparation,
  mutationSafetyRejections?: Pick<UnifiedRealTradingTestMutationSafetyGuard, "rejectionCount">,
  venue: "okx" | "binance" = "okx",
) {
  return new UnifiedRealTradingTestCommand(
    new FormalExecutionRuntimeRegistry().register(formalExecutionRuntime(venue, runtime)),
    records,
    [venuePreparation],
    { now: () => now, ...(mutationSafetyRejections === undefined ? {} : { mutationSafetyRejections }) },
  );
}

function okxFixture(mutationSafetyGuard: UnifiedRealTradingTestMutationSafetyGuard) {
  const provider = new FakeOkxRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const runtime = new OkxIntentExecutionRuntime(
    { run: async (_userId, operation) => operation(provider) },
    records,
    new InMemoryOkxExecutionOrderReferenceStore(),
    {
      createExecutionId: unifiedRealTradingTestExecutionId,
      clock: () => now,
      mutationSafetyGuard,
      quantityRulesSource: okxTestQuantityRulesSource(now),
      spotQuantityRulesSource: () => Object.freeze({
        instType: "SPOT" as const,
        instId: "DOGE-USDT",
        baseCcy: "DOGE",
        quoteCcy: "USDT",
        lotSz: "1",
        minSz: "1",
        tickSz: "0.00001",
        state: "live",
        fetchedAt: now,
      }),
    },
  );
  return {
    provider,
    records,
    command: commandFor(
      new OkxFormalArbitrageExecutionRuntime(runtime),
      records,
      preparation(),
      mutationSafetyGuard,
    ),
  };
}

function binanceCommand(service: FakeBinanceRuntimeService, records: MemoryExecutionRecordStore) {
  const runtime = new BinanceIntentExecutionRuntime(
    { run: async (_userId, operation) => operation(service) },
    { maxSlippageBps: 20 },
    records,
    { createExecutionId: unifiedRealTradingTestExecutionId, clock: () => now },
  );
  return commandFor(
    new BinanceFormalArbitrageExecutionRuntime(runtime),
    records,
    preparationFor("binance"),
    undefined,
    "binance",
  );
}

class FakeFormalRuntime implements FormalExecutionRuntime {
  readonly executeCalls: import("./ExecutionIntent").ExecutionIntent[] = [];
  readonly reconcileCalls: Array<{ userId: string; executionId: string }> = [];

  constructor(private readonly executionStatus: ExecutionRecord["status"] = "PENDING_CONFIRMATION") {}

  async execute(intent: import("./ExecutionIntent").ExecutionIntent) {
    this.executeCalls.push(intent);
    return { executionRecord: record({ intentId: intent.intentId, status: this.executionStatus }), confirmedQuantity: "0" };
  }

  async reconcile(userId: string, executionId: string) {
    this.reconcileCalls.push({ userId, executionId });
    return { executionRecord: record({ executionId }), confirmedQuantity: "80" };
  }

  cancel(): ReturnType<FormalExecutionRuntime["cancel"]> {
    return Promise.reject(new Error("unused"));
  }
}

class MemoryExecutionRecordStore implements ExecutionRecordStore {
  private readonly records = new Map<string, ExecutionRecord>();

  create(value: ExecutionRecord) {
    if (this.records.has(value.executionId)) throw new Error("duplicate executionId");
    this.records.set(value.executionId, value);
  }

  update(value: ExecutionRecord) {
    if (!this.records.has(value.executionId)) throw new Error("missing executionId");
    this.records.set(value.executionId, value);
  }

  loadForUser(userId: string, executionId: string) {
    const value = this.records.get(executionId);
    return value?.userId === userId ? value : null;
  }

  findByIntentId(intentId: string) {
    return [...this.records.values()].filter((value) => value.intentId === intentId);
  }
}

class FakeOkxRuntimeService {
  readonly placeRequests: OkxPlaceOrderRequest[] = [];
  readonly getRequests: OkxGetOrderRequest[] = [];
  readonly cancelRequests: OkxCancelOrderRequest[] = [];

  executionAccountIdentity() {
    return { accountId: "okx:account-user-a" };
  }

  async readPositionMode() {
    return "ONE_WAY" as const;
  }

  validateExecutionProviderIdentity() {}

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeRequests.push(request);
    return { instId: request.instId, ordId: String(9_000 + this.placeRequests.length), clOrdId: request.clOrdId };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    this.getRequests.push(request);
    const placed = this.placeRequests.find(({ clOrdId }) => clOrdId === request.clOrdId);
    if (!placed) throw new Error("order not found");
    return {
      instId: placed.instId,
      ordId: request.ordId ?? "9991",
      clOrdId: placed.clOrdId,
      side: placed.side,
      tdMode: placed.tdMode,
      ...(placed.instId.endsWith("-SWAP") ? {
        posSide: placed.posSide ?? "net" as const,
        reduceOnly: placed.reduceOnly ?? false,
      } : {}),
      status: "CONFIRMED",
      statusReason: null,
      rawState: "filled",
      requestedQuantity: placed.quantity,
      filledQuantity: placed.quantity,
      averagePrice: "0.1",
      fee: "-0.001",
      updatedAt: now,
    };
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    this.cancelRequests.push(request);
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9992",
      clOrdId: request.clOrdId ?? "missing-client-order-id",
    };
  }
}

class FakeBinanceRuntimeService {
  private readonly orders: BinanceStoredOrder[] = [];
  placeCount = 0;
  reconcileCount = 0;

  async executionAccountIdentity() {
    const snapshot = await this.account();
    return {
      accountId: snapshot.accountId,
      accountFingerprint: snapshot.accountFingerprint,
      uidSnapshot: "binance-test-uid",
      accountMode: "single_asset_one_way" as const,
      ipWhitelistVerificationMode: "provider_list_exact" as const,
      permissions: snapshot.permissions,
    };
  }

  async account() {
    return snapshotFixture({ accountId: "binance:account-user-a" });
  }

  async loadExecutionReadContext(instrumentId: string): Promise<BinanceGenericExecutionContext> {
    return Object.freeze({
      instrument: Object.freeze({
        instrumentId,
        venue: "binance",
        providerSymbol: "DOGEUSDT",
        baseAsset: Object.freeze({ symbol: "DOGE", type: "DIGITAL_ASSET" }),
        quoteAsset: "USDT",
        settlementAsset: "USDT",
        marketType: "perpetual",
        contractType: "linear_perpetual",
        quantityUnit: "base",
        contractSize: "1",
        status: "trading",
      }),
      tradingRules: Object.freeze({
        quantityStep: "1",
        minQuantity: "1",
        priceTick: "0.0001",
        minNotional: "1",
        precision: Object.freeze({ quantity: 0, price: 4 }),
      }),
      quote: Object.freeze({ bid: "0.1", ask: "0.1001", fetchedAt: now }),
    });
  }

  async placeExecutionOrder(input: BinanceOrderInput) {
    this.placeCount += 1;
    const order = binanceProviderOrder({
      orderLinkId: binanceClientOrderId(input.idempotencyKey),
      requestedQuantity: Number(input.quantity),
      filledQuantity: Number(input.quantity),
      requestedBaseQuantity: input.quantity,
      filledBaseQuantity: input.quantity,
    });
    this.orders.push({
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: "unified-binance-test",
      clientOrderId: order.orderLinkId,
      providerOrderId: order.orderId,
      category: input.category,
      symbol: input.symbol,
      executionMode: "production_ioc",
      status: "completed",
      order,
      error: null,
      cancelRequestedAt: null,
      cancelDispatchState: null,
      createdAt: now,
      updatedAt: now,
    });
    return order;
  }

  executionOrderState(idempotencyKey: string) {
    const order = this.orders.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    return order ? { kind: "found" as const, order } : { kind: "missing" as const };
  }

  async findExecutionOrderByClientOrderId(_category: "spot" | "linear", _symbol: string, clientOrderId: string) {
    this.reconcileCount += 1;
    return this.orders.find((candidate) => candidate.clientOrderId === clientOrderId)?.order ?? null;
  }

  async cancelOrder() {
    return binanceProviderOrder({ status: "Cancelled" });
  }
}

function binanceProviderOrder(overrides: Partial<BinanceProviderOrder> = {}): BinanceProviderOrder {
  return {
    symbol: "DOGEUSDT",
    orderId: "9001",
    orderLinkId: "binance-unified-client-1",
    status: "Filled",
    requestedQuantity: 20,
    filledQuantity: 20,
    requestedBaseQuantity: "20",
    filledBaseQuantity: "20",
    averagePrice: 0.1,
    feeUsd: 0,
    updatedAt: now,
    ...overrides,
  };
}

function binanceClientOrderId(idempotencyKey: string) {
  return `ptm${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 30)}`;
}

function preparation(): UnifiedRealTradingTestVenuePreparation {
  return preparationFor("okx");
}

function preparationFor(venue: "okx" | "binance"): UnifiedRealTradingTestVenuePreparation {
  return {
    venue,
    async prepare(input) {
      return {
        accountId: `${venue}:account-user-a`,
        quantityPlan: quantityPlan(input.instrumentId, input.quantityInput),
      };
    },
  };
}

function quantityPlan(instrumentId: string, quantityInput: UnifiedRealTradingTestRequest["quantityInput"]): ExecutionQuantityPlan {
  const plannedQuantity = quantityInput.mode === "ASSET_QUANTITY" ? quantityInput.quantity : "80";
  return Object.freeze({
    instrumentId,
    providerSymbol: instrumentId.endsWith("-SPOT") ? "DOGE-USDT" : "DOGE-USDT-SWAP",
    baseAsset: "DOGE",
    quantityInput,
    sizingPrice: "0.1",
    plannedAssetQuantity: createAssetQuantity({
      asset: { symbol: "DOGE", type: "DIGITAL_ASSET" },
      quantity: plannedQuantity,
    }),
    ...(instrumentId.endsWith("-PERP") ? { plannedVenueQuantity: "800" } : {}),
    estimatedNotionalUsdt: "8",
    generatedAt: now,
  });
}

function request(overrides: Partial<UnifiedRealTradingTestRequest> = {}): UnifiedRealTradingTestRequest {
  return {
    requestId: "doge-test-1",
    userId: "user-a",
    venue: "okx",
    instrumentId: "DOGE-USDT-PERP",
    side: "buy",
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "8" },
    reduceOnly: false,
    executionMode: "EXECUTION_PRIORITY",
    executeLive: true,
    ...overrides,
  };
}

function record(overrides: Partial<ExecutionRecord> = {}) {
  return createExecutionRecord({
    executionId: "execution-existing",
    intentId: "intent-existing",
    executionAttemptId: "intent-existing",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    status: "PENDING_CONFIRMATION",
    remoteOrderId: "order-existing",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}
