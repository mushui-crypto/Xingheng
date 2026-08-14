import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import type { BinanceStoredOrder } from "./BinanceOrderStore";
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

test("uses the exact persisted Decimal fill instead of the legacy number bridge", async () => {
  const order = storedOrder("PartiallyFilled", 0.12345678901234568);
  order.order!.filledBaseQuantity = "0.123456789012345678901";
  const observation = await new BinanceIntentExecutionQueryService(
    new FakeQueryBinding([order]),
    () => now,
  ).query(executionRecord());
  assert.equal(observation.filledBaseQuantity, "0.123456789012345678901");
});

test("query service exposes no provider, reconciliation, cancel, or retry dependency", () => {
  const source = readFileSync(new URL("./BinanceIntentExecutionQueryService.ts", import.meta.url), "utf8");
  assert.match(source, /ordersState/u);
  assert.doesNotMatch(source, /BinanceClient|findOrderBy|awaitOrder|reconciliation\s*\(|cancelOrder\s*\(|retry\s*\(|fetch\(/iu);
});

class FakeQueryBinding {
  providerMutations = 0;

  constructor(private readonly orders: BinanceStoredOrder[]) {}

  ordersState() {
    return { orders: this.orders };
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
    providerOrderId: "binance-order-1",
    category: "linear",
    symbol: "XAUTUSDT",
    executionMode: "production_ioc",
    status: status === "Filled" ? "completed"
      : status === "Rejected" || status === "Cancelled" || status === "Expired" ? "failed"
      : "processing",
    order: {
      orderId: "binance-order-1",
      orderLinkId: "binance-client-order-1",
      status,
      requestedQuantity: 0.002,
      filledQuantity,
      averagePrice: null,
      feeUsd: 0,
      updatedAt: now,
    },
    error: null,
    cancelRequestedAt: null,
    createdAt: now - 1_000,
    updatedAt: now,
  };
}

function executionRecord() {
  return createExecutionRecord({
    executionId: "execution-1",
    intentId: "intent-user-1",
    executionAttemptId: "intent-user-1",
    remoteOrderId: "binance-order-1",
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
