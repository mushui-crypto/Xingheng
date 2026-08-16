import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { ExecutionCapabilityRegistry, executionCapability } from "../cex/ExecutionCapabilityRegistry";
import { OkxIntentExecutionRuntime } from "./OkxIntentExecutionRuntime";
import { OkxIntentExecutionCapability } from "./OkxIntentExecutionCapability";
import { okxClientOrderIdFor } from "./OkxIntentExecutionService";
import { okxTestQuantityRulesSource } from "./OkxTestFixtures";
import type { OkxExecutionOrderReference } from "./OkxExecutionOrderReferenceStore";
import type {
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
  OkxPerpetualPosition,
} from "./OkxTypes";

const now = 1_800_000_000_000;
const fakeMutationGuard = () => new ExecutionMutationSafetyGuard({ liveTradingEnabled: true, killSwitchActive: false });

test("OKX perpetual single-leg long and short validation keeps the execution chain intact and closes to zero", async (t) => {
  for (const scenario of [
    { scenarioId: "perp-long", openSide: "buy" as const, closeSide: "sell" as const, expectedDirection: "long" as const },
    { scenarioId: "perp-short", openSide: "sell" as const, closeSide: "buy" as const, expectedDirection: "short" as const },
  ]) {
    await t.test(scenario.scenarioId, async () => {
      const service = new StatefulOkxPerpExecutionService("okx:account-user-a");
      const registry = new ExecutionCapabilityRegistry()
        .register(executionCapability("okx", new OkxIntentExecutionCapability({
          execute: async () => ({ state: "SUBMITTED" as const }),
        })));
      assert.equal(registry.resolve("okx") instanceof OkxIntentExecutionCapability, true);
      const recordStore = new InMemoryExecutionRecordStore();
      let executionSequence = 0;
      const runtime = new OkxIntentExecutionRuntime(
        new OkxRuntimeRegistry(service),
        recordStore,
        new InMemoryOrderReferenceStore(),
        {
          clock: () => now,
          createExecutionId: () => `execution-${scenario.scenarioId}-${++executionSequence}`,
          mutationSafetyGuard: fakeMutationGuard(),
          quantityRulesSource: okxTestQuantityRulesSource(now),
        },
      );
      const quantity = "12.5";

      const openIntent = createExecutionIntent({
        intentId: `intent-open-${scenario.scenarioId}`,
        userId: "user-a",
        venue: "okx",
        accountId: "okx:account-user-a",
        instrumentId: "DOGE-USDT-PERP",
        side: scenario.openSide,
        quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity },
        orderConstraints: { reduceOnly: false },
        executionMode: "EXECUTION_PRIORITY",
        createdAt: now,
        expiresAt: now + 60_000,
      });

      const openResult = await runtime.execute(openIntent);
      assert.equal(openResult.execution.status, "SUCCEEDED");
      assert.equal(openResult.execution.step.stepId, "execution-capability");
      assert.equal(openResult.executionRecord.status, "PENDING_CONFIRMATION");
      assert.equal(openResult.orderReference?.instId, "DOGE-USDT-SWAP");
      assert.equal(openResult.orderReference?.ordId, "9001");
      assert.equal(openResult.orderReference?.clOrdId, okxClientOrderIdFor(openIntent));

      const openQuery = await runtime.query("user-a", openResult.executionRecord.executionId);
      assert.equal(openQuery.executionRecord.status, "CONFIRMED");
      assert.equal(openQuery.observation.filledBaseQuantity, quantity);
      assert.equal(openQuery.fee, "-0.001");
      assert.equal(service.position("DOGE-USDT-SWAP").side, scenario.expectedDirection);
      assert.equal(service.position("DOGE-USDT-SWAP").quantity, "125");

      const closeIntent = createExecutionIntent({
        intentId: `intent-close-${scenario.scenarioId}`,
        userId: "user-a",
        venue: "okx",
        accountId: "okx:account-user-a",
        instrumentId: "DOGE-USDT-PERP",
        side: scenario.closeSide,
        quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity },
        orderConstraints: { reduceOnly: true },
        executionMode: "EXECUTION_PRIORITY",
        createdAt: now,
        expiresAt: now + 60_000,
      });

      const closeResult = await runtime.close(closeIntent);
      assert.equal(closeResult.execution.status, "SUCCEEDED");
      assert.equal(closeResult.executionRecord.status, "PENDING_CONFIRMATION");
      assert.equal(service.placeRequests.at(-1)?.reduceOnly, true);
      assert.equal(service.placeRequests.at(-1)?.side, scenario.closeSide);
      assert.equal(closeResult.orderReference?.clOrdId, okxClientOrderIdFor(closeIntent));

      const closeQuery = await runtime.query("user-a", closeResult.executionRecord.executionId);
      assert.equal(closeQuery.executionRecord.status, "CONFIRMED");
      assert.equal(closeQuery.observation.filledBaseQuantity, quantity);
      assert.equal(closeQuery.fee, "-0.001");
      assert.equal(service.position("DOGE-USDT-SWAP").side, "flat");
      assert.equal(service.position("DOGE-USDT-SWAP").quantity, "0");
      assert.equal(recordStore.created.length, 2);
      assert.equal(recordStore.updated.at(-1)?.status, "CONFIRMED");

      const source = readFileSync(new URL("./OkxIntentExecutionRuntime.ts", import.meta.url), "utf8");
      assert.match(source, /ExecutionCapabilityRegistry/u);
      assert.match(source, /RegistryBackedExecutionCapability/u);
    });
  }
});

class OkxRuntimeRegistry {
  constructor(private readonly service: StatefulOkxPerpExecutionService) {}

  async run<T>(userId: string, operation: (service: StatefulOkxPerpExecutionService) => Promise<T> | T): Promise<T> {
    assert.equal(userId, "user-a");
    return operation(this.service);
  }
}

class StatefulOkxPerpExecutionService {
  readonly placeRequests: OkxPlaceOrderRequest[] = [];
  readonly getRequests: OkxGetOrderRequest[] = [];
  readonly cancelRequests: OkxCancelOrderRequest[] = [];
  private readonly orders = new Map<string, OkxProviderOrder>();
  private readonly positions = new Map<string, OkxPerpetualPosition>();
  private ordSeq = 9000;

  constructor(private readonly accountId: string) {}

  executionAccountIdentity() {
    return { accountId: this.accountId };
  }

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeRequests.push(request);
    const ordId = String(++this.ordSeq);
    const order = this.orderFor(request, ordId);
    this.orders.set(ordId, order);
    this.orders.set(request.clOrdId, order);
    this.applyFill(request);
    return {
      instId: request.instId,
      ordId,
      clOrdId: request.clOrdId,
    };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    this.getRequests.push(request);
    const order = request.ordId ? this.orders.get(request.ordId) : this.orders.get(request.clOrdId ?? "");
    if (!order) throw new Error("missing fake OKX order");
    return order;
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    this.cancelRequests.push(request);
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9001",
      clOrdId: request.clOrdId ?? "sxokxmissing000000000000000000",
    };
  }

  position(instId: string): OkxPerpetualPosition {
    return this.positions.get(instId) ?? zeroPosition(instId);
  }

  private orderFor(request: OkxPlaceOrderRequest, ordId: string): OkxProviderOrder {
    return {
      instId: request.instId,
      ordId,
      clOrdId: request.clOrdId,
      status: "CONFIRMED",
      statusReason: null,
      rawState: "filled",
      requestedQuantity: request.quantity,
      filledQuantity: request.quantity,
      averagePrice: "0.123",
      fee: "-0.001",
      updatedAt: now + 100,
    };
  }

  private applyFill(request: OkxPlaceOrderRequest) {
    const current = this.position(request.instId);
    if (!request.reduceOnly) {
      this.positions.set(request.instId, {
        instId: request.instId,
        side: request.side === "buy" ? "long" : "short",
        quantity: request.quantity,
        averagePrice: "0.123",
        markPrice: "0.123",
        liquidationPrice: null,
        updatedAt: now + 100,
      });
      return;
    }

    if (request.side === "sell" && current.side === "long") {
      this.positions.set(request.instId, zeroPosition(request.instId));
      return;
    }
    if (request.side === "buy" && current.side === "short") {
      this.positions.set(request.instId, zeroPosition(request.instId));
      return;
    }
    throw new Error("reduceOnly close would not reduce the current position.");
  }
}

class InMemoryExecutionRecordStore implements ExecutionRecordStore {
  readonly created: ExecutionRecord[] = [];
  readonly updated: ExecutionRecord[] = [];
  private readonly records = new Map<string, ExecutionRecord>();

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

class InMemoryOrderReferenceStore {
  private readonly refs = new Map<string, OkxExecutionOrderReference>();

  async loadForUser(userId: string, executionId: string) {
    return this.refs.get(key(userId, executionId)) ?? null;
  }

  async create(reference: OkxExecutionOrderReference) {
    this.refs.set(key(reference.userId, reference.executionId), reference);
  }
}

function zeroPosition(instId: string): OkxPerpetualPosition {
  return {
    instId,
    side: "flat",
    quantity: "0",
    averagePrice: null,
    markPrice: "0.123",
    liquidationPrice: null,
    updatedAt: now + 100,
  };
}

function key(userId: string, executionId: string) {
  return `${userId}\u0000${executionId}`;
}
