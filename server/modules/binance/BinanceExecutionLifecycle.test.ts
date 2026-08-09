import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { FundingArbitrageSubmitLegRequest } from "../cex/funding-arbitrage/FundingArbitrageExecutionCapability";
import { FundingArbitrageExecutionCoordinator } from "../cex/funding-arbitrage/FundingArbitrageExecutionCoordinator";
import type { SpotPerpetualFundingArbitrageExecutionIntent } from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
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

test("coordinates a simulated Binance two-leg lifecycle through residual and reconciliation", async () => {
  const intent = executionIntent();
  const coordinator = new FundingArbitrageExecutionCoordinator();
  const service = new LifecycleBinanceService();
  const capability = new BinanceExecutionCapability(service, { maxSlippageBps: 20 }, () => now + 10);

  const created = coordinator.createExecution(intent);
  assert.equal(created.status, "CREATED");
  const executing = coordinator.transition(created, { type: "START_EXECUTION", occurredAt: now + 1 });
  assert.equal(executing.status, "EXECUTING");

  const longRequest = submitRequest(intent, 0, "attempt-long");
  const longSubmitting = coordinator.transition(executing, {
    type: "LEG_SUBMIT_STARTED",
    legId: longRequest.legId,
    occurredAt: now + 2,
  });
  const longAttempt = await capability.submitLeg(longRequest);
  assert.equal(longAttempt.executionAttemptId, longRequest.executionAttemptId);
  const longObservation = await capability.queryLegState(reference(longRequest));
  assert.equal(longObservation.observation, "FILLED");
  const residual = coordinator.transition(longSubmitting, {
    type: "LEG_CONFIRMED_FILLED",
    legId: longRequest.legId,
    confirmedExecutedQuantity: longObservation.confirmedExecutedQuantity,
    occurredAt: longObservation.observedAt,
  });
  assert.equal(residual.status, "RESIDUAL");
  assert.equal(residual.residualExposure.residualQuantity, "0.12");

  const shortRequest = submitRequest(intent, 1, "attempt-short");
  const shortSubmitting = coordinator.transition(residual, {
    type: "LEG_SUBMIT_STARTED",
    legId: shortRequest.legId,
    occurredAt: now + 4,
  });
  await capability.submitLeg(shortRequest);
  const unknownObservation = await capability.queryLegState(reference(shortRequest));
  assert.equal(unknownObservation.observation, "UNKNOWN_REMOTE_STATE");
  const pending = coordinator.transition(shortSubmitting, {
    type: "LEG_REMOTE_UNKNOWN",
    legId: shortRequest.legId,
    occurredAt: unknownObservation.observedAt,
  });
  assert.equal(pending.status, "PENDING_RECONCILIATION");
  assert.notEqual(pending.status, "FAILED");

  const reconciledObservation = await capability.reconcileLeg(reference(shortRequest));
  assert.equal(reconciledObservation.observation, "FILLED");
  const hedged = coordinator.transition(pending, {
    type: "LEG_RECONCILIATION_RESOLVED",
    legId: shortRequest.legId,
    confirmedExecutedQuantity: reconciledObservation.confirmedExecutedQuantity,
    remoteObservation: reconciledObservation.observation,
    occurredAt: reconciledObservation.observedAt,
  });
  assert.equal(hedged.status, "HEDGED");
  assert.equal(hedged.residualExposure.residualQuantity, "0");
  assert.deepEqual(hedged.residualExposure.executedQuantity, { long: "0.12", short: "0.12" });
  assert.equal(service.placeInputs.length, 2);
  assert.equal(service.reconciliationCalls, 1);
});

test("the lifecycle fixture does not construct real execution dependencies", () => {
  const source = readFileSync(new URL("./BinanceExecutionLifecycle.test.ts", import.meta.url), "utf8");
  const constructors = [...source.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)/gu)].map((match) => match[1]);
  for (const forbidden of [
    "BinanceClient",
    "BinancePersonalTradingService",
    "BinanceOrderManager",
    "BinanceOrderStore",
  ]) assert.equal(constructors.includes(forbidden), false, `unexpected real dependency: ${forbidden}`);
});

class LifecycleBinanceService implements BoundBinanceExecutionService {
  readonly placeInputs: Array<Record<string, unknown>> = [];
  private orders: BinanceStoredOrder[] = [];
  reconciliationCalls = 0;

  async market() {
    const snapshot = snapshotFixture();
    return {
      fetchedAt: snapshot.fetchedAt,
      productAvailability: snapshot.productAvailability,
      spot: snapshot.spot,
      perpetual: snapshot.perpetual,
      fees: snapshot.fees,
    };
  }

  async placeOrder(input: unknown, beforeProviderMutation?: () => void | Promise<void>) {
    await beforeProviderMutation?.();
    const prepared = input as Record<string, unknown>;
    this.placeInputs.push(prepared);
    const perpetual = prepared.category === "linear";
    const order = providerOrder(
      perpetual ? "Unknown" : "Filled",
      perpetual ? 0 : Number(prepared.quantityXaut),
      perpetual ? now + 5 : now + 3,
    );
    this.orders.push(storedOrder(String(prepared.idempotencyKey), order));
    return order;
  }

  async cancelOrder() {
    return providerOrder("Cancelled", 0, now + 7);
  }

  ordersState() {
    return { orders: this.orders };
  }

  async reconciliation() {
    this.reconciliationCalls += 1;
    this.orders = this.orders.map((stored) => stored.order?.status === "Unknown"
      ? storedOrder(stored.idempotencyKey, providerOrder("Filled", 0.12, now + 6))
      : stored);
    return { reconciled: [], snapshot: snapshotFixture(), orders: this.orders };
  }
}

function executionIntent(): SpotPerpetualFundingArbitrageExecutionIntent {
  return {
    intentId: "intent-lifecycle",
    sourcePlanId: "plan-lifecycle",
    strategyType: "SPOT_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt: now,
    expiresAt: now + 60_000,
    constraints: { maxResidualBaseQuantity: "0.001", maxLegStartSkewMs: 500 },
    legs: [
      {
        legId: "leg-spot-long",
        role: "long",
        venue: "binance",
        instrumentId: BINANCE_SPOT_INSTRUMENT_ID,
        marketType: "spot",
        targetDeltaBaseQuantity: "0.12",
      },
      {
        legId: "leg-perpetual-short",
        role: "short",
        venue: "binance",
        instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.12",
      },
    ],
  };
}

function submitRequest(
  intent: SpotPerpetualFundingArbitrageExecutionIntent,
  index: 0 | 1,
  executionAttemptId: string,
): FundingArbitrageSubmitLegRequest {
  const leg = intent.legs[index];
  return {
    executionId: intent.intentId,
    executionAttemptId,
    legId: leg.legId,
    role: leg.role,
    venue: leg.venue,
    instrumentId: leg.instrumentId,
    marketType: leg.marketType,
    targetDeltaBaseQuantity: leg.targetDeltaBaseQuantity,
  };
}

function reference(request: FundingArbitrageSubmitLegRequest) {
  return {
    executionId: request.executionId,
    executionAttemptId: request.executionAttemptId,
    legId: request.legId,
  };
}

function providerOrder(
  status: BinanceProviderOrder["status"],
  filledQuantityXaut: number,
  updatedAt: number,
): BinanceProviderOrder {
  return {
    orderId: "fixture-internal",
    orderLinkId: "fixture-internal",
    status,
    requestedQuantityXaut: 0.12,
    filledQuantityXaut,
    averagePrice: filledQuantityXaut > 0 ? 1_000 : null,
    feeUsd: 0,
    updatedAt,
  };
}

function storedOrder(idempotencyKey: string, order: BinanceProviderOrder): BinanceStoredOrder {
  return {
    idempotencyKey,
    requestFingerprint: "fixture-internal",
    clientOrderId: "fixture-internal",
    providerOrderId: order.orderId,
    category: order.status === "Unknown" ? "linear" : "spot",
    executionMode: "production_ioc",
    status: order.status === "Filled" ? "completed" : "processing",
    order,
    error: null,
    createdAt: now,
    updatedAt: order.updatedAt,
  };
}
