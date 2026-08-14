import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import type { BinanceStoredOrder } from "./BinanceOrderStore";
import { BinanceIntentExecutionReconciliationService } from "./BinanceIntentExecutionReconciliationService";
import { binanceExecutionIdempotencyKeyFor } from "./BinanceIntentExecutionService";
import type { BinanceProviderOrder } from "./BinanceTypes";

const now = 1_800_000_000_000;

test("maps GET-only remote Binance order facts for reconciliation", async () => {
  const cases = [
    ["Filled", "CONFIRMED", 0.002],
    ["PartiallyFilled", "PENDING_CONFIRMATION", 0.0015],
    ["New", "PENDING_CONFIRMATION", 0],
    ["Cancelled", "FAILED", 0.0005],
    ["Rejected", "FAILED", 0],
    ["Expired", "FAILED", 0],
    ["Unknown", "UNKNOWN", 0.00000001],
  ] as const;

  for (const [providerStatus, expectedState, filledQuantity] of cases) {
    const binding = new FakeReconciliationBinding(providerOrder(providerStatus, filledQuantity));
    const observation = await new BinanceIntentExecutionReconciliationService(binding, () => now)
      .reconcile(executionRecord());

    assert.equal(observation.state, expectedState);
    assert.equal(observation.filledBaseQuantity, decimal(filledQuantity));
    assert.equal(observation.observedAt, now);
    assert.deepEqual(binding.providerQueries, [{
      category: "linear",
      symbol: "XAUTUSDT",
      clientOrderId: "binance-client-order-1",
    }]);
    assert.equal(binding.providerMutations, 0);
  }
});

test("maps missing remote order and provider GET errors to UNKNOWN", async () => {
  for (const remote of [null, new Error("provider GET unavailable")] as const) {
    const binding = new FakeReconciliationBinding(remote);
    const observation = await new BinanceIntentExecutionReconciliationService(binding, () => now)
      .reconcile(executionRecord());

    assert.deepEqual(observation, { state: "UNKNOWN", filledBaseQuantity: "0", observedAt: now });
    assert.equal(binding.providerMutations, 0);
  }
});

test("identity mismatch maps filled and partial provider facts to UNKNOWN with zero quantity", async (t) => {
  const cases = [
    providerOrder("Filled", 0.002, { symbol: "BTCUSDT" }),
    providerOrder("Filled", 0.002, { orderLinkId: "wrong-client" }),
    providerOrder("Filled", 0.002, { orderId: "wrong-provider" }),
    providerOrder("PartiallyFilled", 0.0015, { symbol: "BTCUSDT" }),
  ];
  for (const [index, remote] of cases.entries()) {
    await t.test(String(index), async () => {
      const binding = new FakeReconciliationBinding(remote);
      const observation = await new BinanceIntentExecutionReconciliationService(binding, () => now)
        .reconcile(executionRecord());
      assert.deepEqual(observation, { state: "UNKNOWN", filledBaseQuantity: "0", observedAt: now });
      assert.equal(binding.providerMutations, 0);
    });
  }
});

test("returns UNKNOWN without provider query when local execution identity is unavailable", async () => {
  const binding = new FakeReconciliationBinding(providerOrder("Filled", 0.002), []);

  const observation = await new BinanceIntentExecutionReconciliationService(binding, () => now)
    .reconcile(executionRecord());

  assert.equal(observation.state, "UNKNOWN");
  assert.equal(binding.providerQueries.length, 0);
  assert.equal(binding.providerMutations, 0);
});

test("reconciliation service exposes a GET lookup only and no mutation workflow", () => {
  const source = readFileSync(
    new URL("./BinanceIntentExecutionReconciliationService.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /findExecutionOrderByClientOrderId/u);
  assert.doesNotMatch(source, /\.reconciliation\s*\(|cancelOrder\s*\(|placeExecutionOrder\s*\(|awaitOrder\s*\(|retry\s*\(|fetch\(/iu);
});

class FakeReconciliationBinding {
  readonly providerQueries: Array<{ category: "spot" | "linear"; symbol: string; clientOrderId: string }> = [];
  providerMutations = 0;

  constructor(
    private readonly remote: BinanceProviderOrder | null | Error,
    private readonly orders: BinanceStoredOrder[] = [storedOrder()],
  ) {}

  ordersState() {
    return { orders: this.orders };
  }

  async findExecutionOrderByClientOrderId(category: "spot" | "linear", symbol: string, clientOrderId: string) {
    this.providerQueries.push({ category, symbol, clientOrderId });
    if (this.remote instanceof Error) throw this.remote;
    return this.remote;
  }
}

function storedOrder(): BinanceStoredOrder {
  return {
    idempotencyKey: binanceExecutionIdempotencyKeyFor(executionRecord()),
    requestFingerprint: "request-fingerprint",
    clientOrderId: "binance-client-order-1",
    providerOrderId: "binance-order-1",
    category: "linear",
    symbol: "XAUTUSDT",
    executionMode: "production_ioc",
    status: "processing",
    order: providerOrder("New", 0),
    error: null,
    cancelRequestedAt: null,
    cancelDispatchState: null,
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
  };
}

function providerOrder(
  status: BinanceProviderOrder["status"],
  filledQuantity: number,
  overrides: Partial<BinanceProviderOrder> = {},
): BinanceProviderOrder {
  return {
    symbol: "XAUTUSDT",
    orderId: "binance-order-1",
    orderLinkId: "binance-client-order-1",
    status,
    requestedQuantity: 0.002,
    filledQuantity,
    averagePrice: null,
    feeUsd: 0,
    updatedAt: now - 500,
    ...overrides,
  };
}

function executionRecord() {
  return createExecutionRecord({
    executionId: "execution-1",
    intentId: "intent-1",
    executionAttemptId: "intent-1",
    remoteOrderId: "binance-order-1",
    userId: "user-a",
    venue: "binance",
    accountId: "binance:account-user-a",
    instrumentId: "XAUT-USDT-PERP",
    status: "PENDING_CONFIRMATION",
    createdAt: now - 2_000,
    updatedAt: now - 1_000,
  });
}

function decimal(value: number) {
  return value === 0.00000001 ? "0.00000001" : String(value);
}
