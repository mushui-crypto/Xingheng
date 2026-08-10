import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  FundingArbitrageExecutionCapability,
  FundingArbitrageSubmitLegRequest,
} from "../cex/funding-arbitrage/FundingArbitrageExecutionCapability";
import {
  BinanceExecutionCapability,
  type BoundBinanceExecutionService,
} from "./BinanceExecutionCapability";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
} from "./BinanceInstrumentCatalog";
import type { BinanceStoredOrder } from "./BinanceOrderStore";
import type { BinanceProviderOrder } from "./BinanceTypes";
import { snapshotFixture } from "./binanceTestFixtures";

const now = 1_800_000_000_000;

test("implements the capability contract through the bound Binance service", async () => {
  const service = new FakeBoundBinanceExecutionService();
  const capability: FundingArbitrageExecutionCapability = new BinanceExecutionCapability(
    service,
    { maxSlippageBps: 20 },
    () => now,
  );
  const request = submitRequest();

  const first = await capability.submitLeg(request);
  const second = await capability.submitLeg(request);
  assert.equal(first.executionAttemptId, request.executionAttemptId);
  assert.equal(second.executionAttemptId, request.executionAttemptId);
  assert.equal(service.placeInputs.length, 2);
  assert.deepEqual(service.placeInputs[0], service.placeInputs[1]);
  assert.deepEqual(service.placeInputs[0], {
    idempotencyKey: service.placeInputs[0]!.idempotencyKey,
    category: "spot",
    symbol: "XAUTUSDT",
    side: "Buy",
      quantityXaut: 0.12,
      limitPrice: 1002,
      executionPriceMode: "IOC_LIMIT",
      reduceOnly: false,
  });
  assert.match(String(service.placeInputs[0]!.idempotencyKey), /^funding-arbitrage:[a-f0-9]{64}$/u);
});

test("maps perpetual short preparation without exposing Binance parameters upward", async () => {
  const service = new FakeBoundBinanceExecutionService();
  const capability = new BinanceExecutionCapability(service, { maxSlippageBps: 20 }, () => now);
  const request = submitRequest({
    executionAttemptId: "attempt-short",
    legId: "leg-short",
    role: "short",
    instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
    marketType: "perpetual",
  });

  const result = await capability.submitLeg(request);
  assert.deepEqual(result, { executionAttemptId: request.executionAttemptId });
  assert.deepEqual(service.placeInputs[0], {
    idempotencyKey: service.placeInputs[0]!.idempotencyKey,
    category: "linear",
    symbol: "XAUTUSDT",
    side: "Sell",
      quantityXaut: 0.12,
      limitPrice: 998.9000000000001,
      executionPriceMode: "IOC_LIMIT",
      reduceOnly: false,
  });
});

test("maps Binance Unknown to the unified remote observation", async () => {
  const service = new FakeBoundBinanceExecutionService();
  const capability = new BinanceExecutionCapability(service, { maxSlippageBps: 20 }, () => now);
  const request = submitRequest();
  await capability.submitLeg(request);
  service.orders = [storedOrder(
    String(service.placeInputs[0]!.idempotencyKey),
    providerOrder({ status: "Unknown", filledQuantityXaut: 0.03 }),
  )];

  const observation = await capability.queryLegState(reference(request));
  assert.deepEqual(observation, {
    executionAttemptId: request.executionAttemptId,
    observation: "UNKNOWN_REMOTE_STATE",
    confirmedExecutedQuantity: "0.03",
    observedAt: now + 10,
  });
  assert.deepEqual(Object.keys(observation).sort(), [
    "confirmedExecutedQuantity",
    "executionAttemptId",
    "observation",
    "observedAt",
  ]);
});

test("cancel and reconciliation use the same deterministic attempt mapping", async () => {
  const service = new FakeBoundBinanceExecutionService();
  const capability = new BinanceExecutionCapability(service, { maxSlippageBps: 20 }, () => now);
  const request = submitRequest();
  await capability.submitLeg(request);
  const idempotencyKey = String(service.placeInputs[0]!.idempotencyKey);
  service.cancelResult = providerOrder({ status: "Cancelled", filledQuantityXaut: 0.02 });
  const canceled = await capability.cancelLeg(reference(request));
  assert.equal(canceled.result, "CANCEL_REQUESTED");
  assert.deepEqual(service.cancelInputs, [{ idempotencyKey }]);

  service.reconciledOrders = [storedOrder(
    idempotencyKey,
    providerOrder({ status: "Filled", filledQuantityXaut: 0.12 }),
  )];
  const reconciled = await capability.reconcileLeg(reference(request));
  assert.equal(reconciled.observation, "FILLED");
  assert.equal(reconciled.confirmedExecutedQuantity, "0.12");
  assert.equal(service.reconciliationCalls, 1);
});

test("rejects unsupported venues and instruments before the bound service is called", async () => {
  const service = new FakeBoundBinanceExecutionService();
  const capability = new BinanceExecutionCapability(service, { maxSlippageBps: 20 }, () => now);
  await assert.rejects(
    () => capability.submitLeg(submitRequest({ venue: "okx" })),
    /Unsupported execution venue/u,
  );
  await assert.rejects(
    () => capability.submitLeg(submitRequest({ instrumentId: "binance:spot:BTC:USDT" })),
    /Unsupported Binance execution instrument/u,
  );
  assert.equal(service.marketCalls, 0);
  assert.equal(service.placeInputs.length, 0);
});

test("submit safety guard runs after read preparation and immediately before mutation", async () => {
  const service = new FakeBoundBinanceExecutionService();
  let guardCalls = 0;
  const capability = new BinanceExecutionCapability(
    service,
    { maxSlippageBps: 20 },
    () => now,
    () => {
      guardCalls += 1;
      throw new Error("intent expired before mutation");
    },
  );

  await assert.rejects(() => capability.submitLeg(submitRequest()), /expired before mutation/u);
  assert.equal(service.marketCalls, 1);
  assert.equal(guardCalls, 1);
  assert.equal(service.placeInputs.length, 0);
});

test("imports no Client, OrderManager, RiskGuard, credential, or concrete coordinator", () => {
  const source = readFileSync(new URL("./BinanceExecutionCapability.ts", import.meta.url), "utf8");
  const importPaths = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);
  for (const path of importPaths) {
    assert.doesNotMatch(path, /BinanceClient|BinanceOrderManager|BinanceRiskGuard|Credential|Coordinator/u);
  }
  assert.match(source, /this\.service\.placeExecutionOrder\(prepared, \(riskValuationPrice/u);
  assert.match(source, /limitPrice: riskValuationPrice/u);
  assert.doesNotMatch(source, /new\s+BinanceClient|loadForExecution|apiKey|apiSecret/u);

  const coordinator = readFileSync(
    new URL("../cex/funding-arbitrage/FundingArbitrageExecutionCoordinator.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(coordinator, /BinanceExecutionCapability|BinanceTypes/u);
});

class FakeBoundBinanceExecutionService implements BoundBinanceExecutionService {
  readonly placeInputs: Array<Record<string, unknown>> = [];
  readonly cancelInputs: Array<Record<string, unknown>> = [];
  orders: BinanceStoredOrder[] = [];
  reconciledOrders: BinanceStoredOrder[] = [];
  cancelResult = providerOrder({ status: "Cancelled" });
  marketCalls = 0;
  reconciliationCalls = 0;

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

  async placeExecutionOrder(input: unknown, beforeProviderMutation?: () => void | Promise<void>) {
    await beforeProviderMutation?.();
    this.placeInputs.push(input as Record<string, unknown>);
    return providerOrder({ status: "Filled", filledQuantityXaut: 0.12 });
  }

  async cancelOrder(input: unknown) {
    this.cancelInputs.push(input as Record<string, unknown>);
    return this.cancelResult;
  }

  ordersState() {
    return { orders: this.orders };
  }

  async reconciliation() {
    this.reconciliationCalls += 1;
    return { reconciled: [], snapshot: snapshotFixture(), orders: this.reconciledOrders };
  }
}

function submitRequest(
  overrides: Partial<FundingArbitrageSubmitLegRequest> = {},
): FundingArbitrageSubmitLegRequest {
  return {
    executionId: "execution-1",
    executionAttemptId: "attempt-long",
    legId: "leg-long",
    role: "long",
    venue: "binance",
    instrumentId: BINANCE_SPOT_INSTRUMENT_ID,
    marketType: "spot",
    targetDeltaBaseQuantity: "0.12000000",
    ...overrides,
  };
}

function reference(request: FundingArbitrageSubmitLegRequest) {
  return {
    executionId: request.executionId,
    executionAttemptId: request.executionAttemptId,
    legId: request.legId,
  };
}

function providerOrder(overrides: Partial<BinanceProviderOrder> = {}): BinanceProviderOrder {
  return {
    orderId: "provider-internal",
    orderLinkId: "client-internal",
    status: "New",
    requestedQuantityXaut: 0.12,
    filledQuantityXaut: 0,
    averagePrice: null,
    feeUsd: 0,
    updatedAt: now + 10,
    ...overrides,
  };
}

function storedOrder(idempotencyKey: string, order: BinanceProviderOrder | null): BinanceStoredOrder {
  return {
    idempotencyKey,
    requestFingerprint: "fingerprint-internal",
    clientOrderId: "client-internal",
    providerOrderId: order?.orderId ?? null,
    category: "spot",
    executionMode: "production_ioc",
    status: order?.status === "Filled" ? "completed" : order && ["Cancelled", "Rejected", "Expired"].includes(order.status)
      ? "failed"
      : "processing",
    order,
    error: null,
    createdAt: now,
    updatedAt: now + 10,
  };
}
