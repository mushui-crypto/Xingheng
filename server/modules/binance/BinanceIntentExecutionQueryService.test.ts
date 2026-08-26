import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import type { BinanceStoredOrder } from "./BinanceOrderStore";
import type { BinanceStoredOrderIsolation } from "./BinanceOrderStore";
import { binanceExecutionIdempotencyKeyFor } from "./BinanceIntentExecutionService";
import { BinanceIntentExecutionQueryService } from "./BinanceIntentExecutionQueryService";
import type { BinanceProviderOrder } from "./BinanceTypes";

const now = 1_800_000_000_000;

test("maps all locally stored Binance order states without provider mutation", async () => {
  const cases = [
    ["Filled", "CONFIRMED", 0.002],
    ["PartiallyFilled", "PENDING_CONFIRMATION", 0.0015],
    ["New", "PENDING_CONFIRMATION", 0],
    ["Rejected", "FAILED", 0],
    ["Cancelled", "FAILED", 0.0005],
    ["Expired", "FAILED", 0],
    ["Unknown", "UNKNOWN", 0.00000001],
  ] as const;

  for (const [providerStatus, expectedState, filledQuantity] of cases) {
    const binding = new FakeQueryBinding([storedOrder(providerStatus, filledQuantity)]);
    const observation = await new BinanceIntentExecutionQueryService(binding, () => now).query(executionRecord());

    assert.equal(observation.state, expectedState);
    assert.equal(observation.filledBaseQuantity, decimal(filledQuantity));
    assert.equal(observation.observedAt, now);
    assert.equal(binding.providerMutations, 0);
  }
});

test("returns UNKNOWN when no local order fact exists", async () => {
  const binding = new FakeQueryBinding([]);

  const observation = await new BinanceIntentExecutionQueryService(binding, () => now).query(executionRecord());

  assert.deepEqual(observation, { state: "UNKNOWN", filledBaseQuantity: "0", observedAt: now });
  assert.equal(binding.providerMutations, 0);
});

test("isolated exact target requires manual reconciliation instead of mapping to missing", async () => {
  const idempotencyKey = binanceExecutionIdempotencyKeyFor(executionRecord());
  const binding = new FakeQueryBinding([], [{
    idempotencyKey,
    status: "processing",
    reason: "Stored Binance provider orderId is invalid.",
    manualReconciliationRequired: true,
  }]);

  await assert.rejects(
    () => new BinanceIntentExecutionQueryService(binding, () => now).query(executionRecord()),
    /requires manual reconciliation/u,
  );
  assert.equal(binding.providerMutations, 0);
});

test("exact-key query recovers a target beyond 100 unrelated orders", async () => {
  const target = storedOrder("Filled", 0.002);
  const unrelated = Array.from({ length: 101 }, (_, index) => ({
    ...storedOrder("New", 0),
    idempotencyKey: `unrelated-${index}`,
    clientOrderId: `unrelated-${index}`,
    order: { ...storedOrder("New", 0).order!, orderLinkId: `unrelated-${index}` },
  }));
  const observation = await new BinanceIntentExecutionQueryService(
    new FakeQueryBinding([...unrelated, target]),
    () => now,
  ).query(executionRecord());

  assert.equal(observation.state, "CONFIRMED");
  assert.equal(observation.filledBaseQuantity, "0.002");
});

test("uses the exact persisted Decimal fill instead of the legacy number bridge", async () => {
  const order = storedOrder("PartiallyFilled", 0.12345678901234568);
  order.expectedBaseQuantity = "0.2";
  order.order!.requestedBaseQuantity = "0.2";
  order.order!.filledBaseQuantity = "0.123456789012345678901";
  const observation = await new BinanceIntentExecutionQueryService(
    new FakeQueryBinding([order]),
    () => now,
  ).query(executionRecord());
  assert.equal(observation.filledBaseQuantity, "0.123456789012345678901");
});

test("mismatched persisted provider identity cannot confirm or apply partial quantity", async (t) => {
  for (const [index, override] of [
    { symbol: "BTCUSDT" },
    { orderLinkId: "wrong-client" },
    { orderId: "3999" },
  ].entries()) {
    await t.test(String(index), async () => {
      const stored = storedOrder("PartiallyFilled", 0.0015);
      Object.assign(stored.order!, override);
      const observation = await new BinanceIntentExecutionQueryService(
        new FakeQueryBinding([stored]),
        () => now,
      ).query(executionRecord());
      assert.deepEqual(observation, { state: "UNKNOWN", filledBaseQuantity: "0", observedAt: now });
    });
  }
});

test("query service exposes no provider, reconciliation, cancel, or retry dependency", () => {
  const source = readFileSync(new URL("./BinanceIntentExecutionQueryService.ts", import.meta.url), "utf8");
  assert.match(source, /executionOrderState/u);
  assert.doesNotMatch(source, /ordersState|\.find\(/u);
  assert.doesNotMatch(source, /BinanceClient|findOrderBy|awaitOrder|reconciliation\s*\(|cancelOrder\s*\(|retry\s*\(|fetch\(/iu);
});

class FakeQueryBinding {
  providerMutations = 0;

  constructor(
    private readonly orders: BinanceStoredOrder[],
    private readonly isolatedOrders: BinanceStoredOrderIsolation[] = [],
  ) {}

  executionOrderState(idempotencyKey: string) {
    const isolation = this.isolatedOrders.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (isolation) return { kind: "isolated" as const, isolation };
    const order = this.orders.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    return order ? { kind: "found" as const, order } : { kind: "missing" as const };
  }
}

function storedOrder(
  status: BinanceProviderOrder["status"],
  filledQuantity: number,
): BinanceStoredOrder {
  return {
    idempotencyKey: binanceExecutionIdempotencyKeyFor(executionRecord()),
    requestFingerprint: "request-fingerprint",
    clientOrderId: "binance-client-order-1",
    providerOrderId: "9223372036854775807",
    category: "linear",
    symbol: "XAUTUSDT",
    executionMode: "production_ioc",
    expectedSide: "Sell",
    expectedBaseQuantity: "0.002",
    expectedReduceOnly: false,
    status: status === "Filled" ? "completed"
      : status === "Rejected" || status === "Cancelled" || status === "Expired" ? "failed"
      : "processing",
    order: {
      symbol: "XAUTUSDT",
      orderId: "9223372036854775807",
      orderLinkId: "binance-client-order-1",
      status,
      requestedQuantity: 0.002,
      filledQuantity,
      side: "Sell",
      reduceOnly: false,
      requestedBaseQuantity: "0.002",
      filledBaseQuantity: decimal(filledQuantity),
      averagePrice: null,
      feeUsd: 0,
      updatedAt: now,
    },
    error: null,
    cancelRequestedAt: null,
    cancelDispatchState: null,
    createdAt: now - 1_000,
    updatedAt: now,
  };
}

function executionRecord() {
  return createExecutionRecord({
    executionId: "execution-1",
    intentId: "intent-user-1",
    executionAttemptId: "intent-user-1",
    remoteOrderId: "9223372036854775807",
    userId: "user-a",
    venue: "binance",
    accountId: "binance:account-user-a",
    instrumentId: "XAUT-USDT-PERP",
    status: "PENDING_CONFIRMATION",
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
  });
}

function decimal(value: number) {
  if (value === 0.00000001) return "0.00000001";
  return String(value);
}
