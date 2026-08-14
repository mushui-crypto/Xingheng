import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { BinanceIntentExecutionCancelService } from "./BinanceIntentExecutionCancelService";
import { binanceExecutionIdempotencyKeyFor } from "./BinanceIntentExecutionService";
import type { BinanceProviderOrder } from "./BinanceTypes";

const now = 1_800_000_000_000;

test("maps explicit Binance cancel results without adding retry behavior", async () => {
  const cases = [
    ["Cancelled", "CANCELLED"],
    ["Expired", "CANCELLED"],
    ["New", "CANCEL_REQUESTED"],
    ["PartiallyFilled", "CANCEL_REQUESTED"],
    ["Unknown", "UNKNOWN"],
    ["Filled", "UNKNOWN"],
    ["Rejected", "UNKNOWN"],
  ] as const;

  for (const [providerStatus, expectedState] of cases) {
    const binding = new FakeCancelBinding(providerOrder(providerStatus));
    const observation = await new BinanceIntentExecutionCancelService(binding, () => now)
      .cancel(executionRecord());

    assert.deepEqual(observation, { state: expectedState, observedAt: now });
    assert.deepEqual(binding.cancelInputs, [{
      idempotencyKey: binanceExecutionIdempotencyKeyFor(executionRecord()),
    }]);
    assert.equal(binding.providerMutations, 1);
  }
});

test("ambiguous cancel failure returns UNKNOWN without retry", async () => {
  const binding = new FakeCancelBinding(new Error("cancel response unavailable"));

  const observation = await new BinanceIntentExecutionCancelService(binding, () => now)
    .cancel(executionRecord({ status: "UNKNOWN" }));

  assert.deepEqual(observation, { state: "UNKNOWN", observedAt: now });
  assert.equal(binding.cancelInputs.length, 1);
  assert.equal(binding.providerMutations, 1);
});

test("cancel service has no scheduler, reconciliation, timeout cancel, or retry entry", () => {
  const source = readFileSync(new URL("./BinanceIntentExecutionCancelService.ts", import.meta.url), "utf8");
  assert.match(source, /cancelOrder/u);
  assert.doesNotMatch(source, /reconciliation\s*\(|setInterval|setTimeout|scheduler|worker|queue|retry\s*\(/iu);
});

class FakeCancelBinding {
  readonly cancelInputs: unknown[] = [];
  providerMutations = 0;

  constructor(private readonly result: BinanceProviderOrder | Error) {}

  async cancelOrder(input: unknown) {
    this.cancelInputs.push(input);
    this.providerMutations += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function providerOrder(status: BinanceProviderOrder["status"]): BinanceProviderOrder {
  return {
    symbol: "XAUTUSDT",
    orderId: "binance-order-1",
    orderLinkId: "binance-client-order-1",
    status,
    requestedQuantity: 0.002,
    filledQuantity: status === "PartiallyFilled" ? 0.001 : 0,
    averagePrice: null,
    feeUsd: 0,
    updatedAt: now,
  };
}

function executionRecord(overrides: Partial<Record<string, unknown>> = {}) {
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
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
    ...overrides,
  });
}
