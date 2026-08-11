import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ExecutionCoordinator } from "../cex/ExecutionCoordinator";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import { BinanceIntentExecutionService } from "./BinanceIntentExecutionService";
import type { BinanceOrderInput } from "./BinanceOrderManager";
import type { BinanceProviderOrder } from "./BinanceTypes";
import { snapshotFixture } from "./binanceTestFixtures";

const now = 1_800_000_000_000;

test("converts canonical perpetual intent into Binance execution request", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  const service = new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 });

  const result = await service.execute(executionIntent());

  assert.equal(result.state, "CONFIRMED");
  assert.equal(result.executionAttemptId, "intent-user-1");
  assert.equal(binding.marketCalls, 1);
  assert.equal(binding.providerMutations, 1);
  assert.deepEqual(binding.placeInputs[0], {
    idempotencyKey: binding.placeInputs[0]!.idempotencyKey,
    category: "linear",
    symbol: "XAUTUSDT",
    side: "Buy",
    quantityXaut: 0.002,
    limitPrice: 1004.1,
    executionPriceMode: "MARKET",
    reduceOnly: false,
  });
  assert.match(binding.placeInputs[0]!.idempotencyKey, /^execution-intent:[a-f0-9]{64}$/u);
});

test("maps spot, sell, price priority, and reduceOnly constraints", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  const service = new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 });

  await service.execute(executionIntent({
    instrumentId: "XAUT-USDT-SPOT",
    side: "sell",
    executionMode: "PRICE_PRIORITY",
    orderConstraints: { reduceOnly: true },
  }));

  assert.deepEqual(binding.placeInputs[0], {
    idempotencyKey: binding.placeInputs[0]!.idempotencyKey,
    category: "spot",
    symbol: "XAUTUSDT",
    side: "Sell",
    quantityXaut: 0.002,
    limitPrice: 997,
    executionPriceMode: "IOC_LIMIT",
    reduceOnly: true,
  });
});

test("rejects unsupported instrument and asset mismatch before provider mutation", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  const service = new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 });

  await assert.rejects(
    () => service.execute(executionIntent({ instrumentId: "BTC-USDT-PERP" })),
    /Unsupported Binance execution instrument/u,
  );
  await assert.rejects(
    () => service.execute(executionIntent({
      quantity: { asset: { symbol: "BTC", type: "DIGITAL_ASSET" }, quantity: "0.002" },
    })),
    /quantity asset must be XAUT/u,
  );
  assert.equal(binding.providerMutations, 0);
  assert.equal(binding.placeInputs.length, 0);
});

test("preserves the existing RiskGuard path through the pre-mutation hook", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  const service = new BinanceIntentExecutionService(
    binding,
    { maxSlippageBps: 20 },
    (prepared) => {
      assert.equal(prepared.limitPrice, 1004.1);
      throw new Error("RiskGuard blocked before provider mutation");
    },
  );

  await assert.rejects(
    () => service.execute(executionIntent()),
    /RiskGuard blocked before provider mutation/u,
  );
  assert.equal(binding.marketCalls, 1);
  assert.equal(binding.providerMutations, 0);
  assert.equal(binding.placeInputs.length, 0);
});

test("maps provider states into execution states", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  const service = new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 });
  binding.placeResult = providerOrder({ status: "PartiallyFilled" });
  assert.equal((await service.execute(executionIntent())).state, "PENDING_CONFIRMATION");
  binding.placeResult = providerOrder({ status: "Rejected" });
  assert.equal((await service.execute(executionIntent({ intentId: "intent-user-2" }))).state, "FAILED");
  binding.placeResult = providerOrder({ status: "Unknown" });
  assert.equal((await service.execute(executionIntent({ intentId: "intent-user-3" }))).state, "UNKNOWN");
});

test("provider anomaly becomes UNKNOWN through ExecutionCoordinator without provider retry", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  binding.failure = new Error("provider write may have happened");
  const service = new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 });
  const coordinated = await new ExecutionCoordinator(service, () => now).execute(executionIntent());

  assert.equal(coordinated.status, "CALL_FAILED");
  assert.equal(coordinated.executionState.status, "UNKNOWN");
  assert.equal(binding.providerMutations, 1);
  assert.equal(binding.placeCalls, 1);
});

test("service stays inside Binance execution boundary and does not import client or risk guard", () => {
  const source = readFileSync(new URL("./BinanceIntentExecutionService.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /BinanceClient|new\s+Binance|BinanceRiskGuard|Funding|Strategy|fetch\(|setInterval|scheduler|retry/iu);
  assert.match(source, /placeExecutionOrder/u);
});

class FakeBinancePersonalTradingBinding {
  readonly placeInputs: BinanceOrderInput[] = [];
  marketCalls = 0;
  placeCalls = 0;
  providerMutations = 0;
  placeResult: BinanceProviderOrder = providerOrder({ status: "Filled" });
  failure: Error | null = null;

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

  async placeExecutionOrder(
    input: BinanceOrderInput,
    beforeProviderMutation?: (riskValuationPrice?: number) => void | Promise<void>,
  ) {
    this.placeCalls += 1;
    await beforeProviderMutation?.(input.limitPrice);
    this.providerMutations += 1;
    if (this.failure) throw this.failure;
    this.placeInputs.push(input);
    return this.placeResult;
  }
}

function executionIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionIntent({
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
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
    requestedQuantityXaut: 0.002,
    filledQuantityXaut: 0.002,
    averagePrice: 1_004,
    feeUsd: 0,
    updatedAt: now + 1_000,
    ...overrides,
  };
}
