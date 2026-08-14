import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { SpotPerpetualFundingArbitrageExecutionIntent } from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import { FundingArbitrageExecutionCoordinator } from "../cex/funding-arbitrage/FundingArbitrageExecutionCoordinator";
import type { FundingArbitrageExecutionState } from "../cex/funding-arbitrage/FundingArbitrageExecutionState";
import type { BinanceCapitalTestExecutionContext } from "./BinanceCapitalTestPreflight";
import {
  BinanceCapitalTestRuntime,
  type BinanceCapitalTestLegRequest,
} from "./BinanceCapitalTestRuntime";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
} from "./BinanceInstrumentCatalog";
import type { BinanceStoredOrder } from "./BinanceOrderStore";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import type { BinanceProviderOrder } from "./BinanceTypes";
import { snapshotFixture } from "./binanceTestFixtures";

const now = 1_800_000_000_000;
const context: BinanceCapitalTestExecutionContext = {
  userId: "capital-test-user",
  accountId: "binance:capital-test",
  venue: "binance",
};
type BinanceOrderInput = Parameters<BinancePersonalTradingService["placeExecutionOrder"]>[0];

test("explicit first-leg submit uses ExecutionIntent runtime and does not execute the second leg", async () => {
  const fixture = runtimeFixture("Filled");
  const result = await fixture.runtime.submitLeg(
    context.userId,
    context,
    intentFixture(),
    startedState(),
    request(),
  );

  assert.equal(result.preflight.status, "PASS");
  assert.equal(result.executionIntent?.instrumentId, "XAUT-USDT-SPOT");
  assert.equal(result.executionIntent?.arbitrageId, "arbitrage-capital-runtime");
  assert.equal(result.executionIntent?.quantity.quantity, "0.01");
  assert.equal(result.executionRecord?.intentId, "execution-intent-spot");
  assert.equal(result.observation?.state, "CONFIRMED");
  assert.equal(result.executionState.legs[0].status, "TERMINAL");
  assert.equal(result.executionState.legs[1].status, "NOT_STARTED");
  assert.equal(result.executionState.status, "RESIDUAL");
  assert.equal(fixture.service.providerMutations, 1);
  assert.equal(fixture.service.placeInputs.length, 1);
  assert.equal(fixture.service.placeInputs[0]?.category, "spot");
  assert.equal(fixture.service.placeInputs[0]?.side, "Buy");
});

test("current funding-cycle spot exposure allows the confirmed perpetual hedge leg", async () => {
  const fixture = runtimeFixture("Filled");
  const fundingIntent = intentFixture();
  const first = await fixture.runtime.submitLeg(
    context.userId,
    context,
    fundingIntent,
    startedState(),
    request(),
  );
  fixture.service.snapshotOverride = {
    existingSpotQuantityXaut: 0.01,
    existingPerpetualQuantityXaut: 0,
    perpetualPositionSide: "flat",
  };

  const second = await fixture.runtime.submitLeg(
    context.userId,
    context,
    fundingIntent,
    first.executionState,
    {
      ...request(),
      legId: "leg-perpetual-short",
      executionIntentId: "execution-intent-perpetual",
    },
  );

  assert.equal(second.preflight.status, "PASS");
  assert.equal(second.executionIntent?.instrumentId, "XAUT-USDT-PERP");
  assert.equal(second.executionRecord?.status, "CONFIRMED");
  assert.equal(second.executionState.status, "HEDGED");
  assert.equal(second.executionState.residualExposure.residualQuantity, "0");
  assert.equal(fixture.service.providerMutations, 2);
  assert.deepEqual(fixture.service.placeInputs.map((input) => input.category), ["spot", "linear"]);
});

test("local query synchronizes partial fill quantity through the funding state bridge", async () => {
  const fixture = runtimeFixture("New");
  const submitted = await fixture.runtime.submitLeg(
    context.userId,
    context,
    intentFixture(),
    startedState(),
    request(),
  );
  fixture.service.setLocalOrder("PartiallyFilled", 0.004);

  const queried = await fixture.runtime.queryLeg(
    context.userId,
    submitted.executionState,
    "leg-spot-long",
    submitted.link!,
  );

  assert.equal(queried.observation?.state, "PENDING_CONFIRMATION");
  assert.equal(queried.observation?.filledBaseQuantity, "0.004");
  assert.equal(queried.executionState.legs[0].status, "ACTIVE");
  assert.equal(queried.executionState.legs[0].remainingQuantity, "0.006");
  assert.equal(fixture.service.providerMutations, 1);
});

test("GET-only reconciliation resolves UNKNOWN and updates the linked funding leg", async () => {
  const fixture = runtimeFixture("Unknown");
  fixture.service.remoteOrder = providerOrder("Filled", 0.01, now + 200);
  const submitted = await fixture.runtime.submitLeg(
    context.userId,
    context,
    intentFixture(),
    startedState(),
    request(),
  );

  assert.equal(submitted.executionState.status, "PENDING_RECONCILIATION");
  const reconciled = await fixture.runtime.reconcileLeg(
    context.userId,
    submitted.executionState,
    "leg-spot-long",
    submitted.link!,
  );

  assert.equal(reconciled.observation?.state, "CONFIRMED");
  assert.equal(reconciled.executionState.legs[0].remoteObservation, "FILLED");
  assert.equal(reconciled.executionState.status, "RESIDUAL");
  assert.equal(fixture.service.providerQueries, 1);
  assert.equal(fixture.service.providerMutations, 1);
});

test("filled identity mismatch stays UNKNOWN and cannot open the second leg", async () => {
  const fixture = runtimeFixture("Unknown");
  fixture.service.remoteOrder = providerOrder("Filled", 0.01, now + 200, { symbol: "BTCUSDT" });
  const submitted = await fixture.runtime.submitLeg(
    context.userId,
    context,
    intentFixture(),
    startedState(),
    request(),
  );

  const reconciled = await fixture.runtime.reconcileLeg(
    context.userId,
    submitted.executionState,
    "leg-spot-long",
    submitted.link!,
  );

  assert.equal(reconciled.observation?.state, "UNKNOWN");
  assert.equal(reconciled.observation?.filledBaseQuantity, "0");
  assert.equal(reconciled.executionState.status, "PENDING_RECONCILIATION");
  assert.equal(reconciled.executionState.legs[0].status, "PENDING_RECONCILIATION");
  assert.equal(reconciled.executionState.legs[1].status, "NOT_STARTED");
  assert.equal(fixture.service.placeInputs.length, 1);
  assert.equal(fixture.service.providerMutations, 1);
});

test("explicit cancel updates the ExecutionRecord and funding leg without automatic follow-up", async () => {
  const fixture = runtimeFixture("New");
  const submitted = await fixture.runtime.submitLeg(
    context.userId,
    context,
    intentFixture(),
    startedState(),
    request(),
  );

  const cancelled = await fixture.runtime.cancelLeg(
    context.userId,
    submitted.executionState,
    "leg-spot-long",
    submitted.link!,
  );

  assert.equal(cancelled.executionRecord.status, "FAILED");
  assert.equal(cancelled.executionState.legs[0].status, "FAILED");
  assert.equal(cancelled.executionState.legs[1].status, "NOT_STARTED");
  assert.equal(fixture.service.providerMutations, 2);
  assert.equal(fixture.service.placeInputs.length, 1);
});

test("unresolved UNKNOWN remains pending reconciliation", async () => {
  const fixture = runtimeFixture("Unknown");
  fixture.service.remoteOrder = new Error("GET unavailable");
  const submitted = await fixture.runtime.submitLeg(
    context.userId,
    context,
    intentFixture(),
    startedState(),
    request(),
  );
  const reconciled = await fixture.runtime.reconcileLeg(
    context.userId,
    submitted.executionState,
    "leg-spot-long",
    submitted.link!,
  );

  assert.equal(reconciled.executionRecord.status, "UNKNOWN");
  assert.equal(reconciled.executionState.status, "PENDING_RECONCILIATION");
  assert.equal(reconciled.executionState.legs[0].remoteObservation, "UNKNOWN_REMOTE_STATE");
  assert.equal(fixture.service.providerMutations, 1);
});

test("preflight and mutation-time capital guards preserve zero-mutation rejection", async () => {
  const preflightFailure = runtimeFixture("Filled");
  preflightFailure.service.snapshotOverride = { existingSpotQuantityXaut: 0.01 };
  const failed = await preflightFailure.runtime.submitLeg(
    context.userId,
    context,
    intentFixture(),
    startedState(),
    request(),
  );
  assert.equal(failed.preflight.status, "FAIL");
  assert.equal(failed.executionRecord, null);
  assert.equal(preflightFailure.service.providerMutations, 0);

  const mutationFailure = runtimeFixture("Filled");
  mutationFailure.service.marketPrice = 4_000;
  const guarded = await mutationFailure.runtime.submitLeg(
    context.userId,
    context,
    intentFixture(),
    startedState(),
    request(),
  );
  assert.equal(guarded.executionRecord?.status, "UNKNOWN");
  assert.equal(mutationFailure.service.providerMutations, 0);
});

test("capital-test runtime passes arbitrageId through without fallback and rejects an invalid value", async () => {
  const fixture = runtimeFixture("Filled");

  await assert.rejects(() => fixture.runtime.submitLeg(
    context.userId,
    context,
    intentFixture(),
    startedState(),
    { ...request(), arbitrageId: "" },
  ), /arbitrageId is invalid/u);
  assert.equal(fixture.service.providerMutations, 0);
});

test("capital-test runtime depends on canonical runtime boundaries and contains no old execution calls", () => {
  assert.equal(existsSync(new URL("./BinanceCapitalTestResidualExit.ts", import.meta.url)), false);
  const source = readFileSync(new URL("./BinanceCapitalTestRuntime.ts", import.meta.url), "utf8");
  assert.match(source, /FundingArbitrageIntentAdapter/u);
  assert.match(source, /BinanceIntentExecutionRuntime/u);
  assert.match(source, /FundingLegExecutionStateBridge/u);
  assert.doesNotMatch(source, /BinanceExecutionCapability|queryLegState|this\.capability/u);
  assert.doesNotMatch(source, /BinanceCapitalTestResidualExit|\.exit\(|for\s*\([^)]*intent\.legs/u);
  assert.doesNotMatch(source, /BinanceClient|BinanceOrderManager|BinanceRiskGuard|Credential/iu);
});

function runtimeFixture(initialStatus: BinanceProviderOrder["status"]) {
  let currentTime = now + 10;
  let executionSequence = 0;
  const clock = () => ++currentTime;
  const service = new RuntimeBinanceService(initialStatus, clock);
  const records = new RuntimeExecutionRecordStore();
  const registry = {
    async run<T>(userId: string, operation: (bound: RuntimeBinanceService) => Promise<T> | T) {
      if (userId !== context.userId) throw new Error("Missing user service.");
      return operation(service);
    },
  };
  return {
    service,
    records,
    runtime: new BinanceCapitalTestRuntime(
      registry,
      records,
      {
        maxSlippageBps: 20,
        clock,
        createExecutionId: () => `execution-record-${++executionSequence}`,
      },
    ),
  };
}

class RuntimeExecutionRecordStore {
  private readonly records = new Map<string, ExecutionRecord>();

  create(record: ExecutionRecord) {
    this.records.set(record.executionId, record);
  }

  update(record: ExecutionRecord) {
    this.records.set(record.executionId, record);
  }

  loadForUser(userId: string, executionId: string) {
    const record = this.records.get(executionId);
    return record?.userId === userId ? record : null;
  }
}

class RuntimeBinanceService {
  readonly placeInputs: BinanceOrderInput[] = [];
  providerMutations = 0;
  providerQueries = 0;
  snapshotOverride: Record<string, unknown> = {};
  marketPrice = 1_000;
  remoteOrder: BinanceProviderOrder | null | Error = null;
  private orders: BinanceStoredOrder[] = [];

  constructor(
    private readonly initialStatus: BinanceProviderOrder["status"],
    private readonly clock: () => number,
  ) {}

  async account() {
    return snapshotFixture({ accountId: context.accountId, ...this.snapshotOverride });
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
    const snapshot = snapshotFixture();
    return {
      fetchedAt: snapshot.fetchedAt,
      productAvailability: snapshot.productAvailability,
      spot: { ...snapshot.spot, bid: this.marketPrice - 1, ask: this.marketPrice },
      perpetual: { ...snapshot.perpetual, bid: this.marketPrice, ask: this.marketPrice + 1, mark: this.marketPrice },
      fees: snapshot.fees,
    };
  }

  async loadExecutionReadContext(instrumentId: string) {
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
      quote: {
        bid: String(spot ? this.marketPrice - 1 : this.marketPrice),
        ask: String(spot ? this.marketPrice : this.marketPrice + 1),
        fetchedAt: now,
      },
    };
  }

  async placeExecutionOrder(
    input: BinanceOrderInput,
    beforeProviderMutation?: (riskValuationPrice: number) => void | Promise<void>,
  ) {
    await beforeProviderMutation?.(input.limitPrice === undefined ? this.marketPrice : Number(input.limitPrice));
    this.providerMutations += 1;
    this.placeInputs.push(input);
    const filled = this.initialStatus === "Filled" ? Number(input.quantity) : 0;
    const order = providerOrder(this.initialStatus, filled, this.clock());
    this.orders = [storedOrder(input, order)];
    return order;
  }

  ordersState() {
    return { orders: this.orders };
  }

  async findExecutionOrderByClientOrderId() {
    this.providerQueries += 1;
    if (this.remoteOrder instanceof Error) throw this.remoteOrder;
    return this.remoteOrder;
  }

  async cancelOrder(input: { idempotencyKey: string }) {
    this.providerMutations += 1;
    const current = this.orders.find((order) => order.idempotencyKey === input.idempotencyKey);
    const order = providerOrder("Cancelled", current?.order?.filledQuantity ?? 0, this.clock());
    if (current) this.orders = [{ ...current, order, updatedAt: order.updatedAt }];
    return order;
  }

  setLocalOrder(status: BinanceProviderOrder["status"], filledQuantity: number) {
    const current = this.orders[0]!;
    const order = providerOrder(status, filledQuantity, this.clock());
    this.orders = [{ ...current, order, updatedAt: order.updatedAt }];
  }
}

function startedState(): FundingArbitrageExecutionState {
  const coordinator = new FundingArbitrageExecutionCoordinator();
  const created = coordinator.createExecution(intentFixture());
  return coordinator.transition(created, { type: "START_EXECUTION", occurredAt: now + 1 });
}

function request(): BinanceCapitalTestLegRequest {
  return {
    confirmed: true,
    arbitrageId: "arbitrage-capital-runtime",
    legId: "leg-spot-long",
    executionIntentId: "execution-intent-spot",
    quantityAsset: { symbol: "XAUT", type: "RWA_ASSET" },
    orderConstraints: { reduceOnly: false },
    executionMode: "PRICE_PRIORITY",
    expiresAt: now + 50_000,
  };
}

function intentFixture(): SpotPerpetualFundingArbitrageExecutionIntent {
  return {
    intentId: "intent-capital-runtime",
    sourcePlanId: "plan-capital-runtime",
    strategyType: "SPOT_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt: now,
    expiresAt: now + 60_000,
    constraints: { maxResidualBaseQuantity: "0.001" },
    legs: [
      {
        legId: "leg-spot-long",
        role: "long",
        venue: "binance",
        instrumentId: BINANCE_SPOT_INSTRUMENT_ID,
        marketType: "spot",
        targetDeltaBaseQuantity: "0.01",
      },
      {
        legId: "leg-perpetual-short",
        role: "short",
        venue: "binance",
        instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.01",
      },
    ],
  };
}

function providerOrder(
  status: BinanceProviderOrder["status"],
  filledQuantity: number,
  updatedAt: number,
  overrides: Partial<BinanceProviderOrder> = {},
): BinanceProviderOrder {
  return {
    symbol: "XAUTUSDT",
    orderId: "fixture-runtime-order",
    orderLinkId: "fixture-runtime-client-order",
    status,
    requestedQuantity: 0.01,
    filledQuantity,
    averagePrice: filledQuantity > 0 ? 1_000 : null,
    feeUsd: 0,
    updatedAt,
    ...overrides,
  };
}

function storedOrder(input: BinanceOrderInput, order: BinanceProviderOrder): BinanceStoredOrder {
  return {
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: "fixture-runtime",
    clientOrderId: order.orderLinkId,
    providerOrderId: order.orderId,
    category: input.category,
    symbol: input.symbol,
    executionMode: "production_ioc",
    status: order.status === "Filled" ? "completed" : "processing",
    order,
    error: null,
    cancelRequestedAt: null,
    cancelDispatchState: null,
    createdAt: now,
    updatedAt: order.updatedAt,
  };
}
