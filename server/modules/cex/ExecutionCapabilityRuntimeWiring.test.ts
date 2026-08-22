import assert from "node:assert/strict";
import test from "node:test";
import { BinanceIntentExecutionCapability } from "../binance/BinanceIntentExecutionCapability";
import { OkxIntentExecutionCapability } from "../okx/OkxIntentExecutionCapability";
import { ExecutionCapabilityRegistry, executionCapability } from "./ExecutionCapabilityRegistry";
import { ExecutionCoordinator } from "./ExecutionCoordinator";
import { createExecutionIntent, type ExecutionIntent } from "./ExecutionIntent";
import { RegistryBackedExecutionCapability } from "./RegistryBackedExecutionCapability";

const now = 1_800_000_000_000;

test("registers Binance and OKX capabilities without provider mutation during lookup", () => {
  const binance = new FakeIntentService("binance");
  const okx = new FakeIntentService("okx");
  const registry = new ExecutionCapabilityRegistry()
    .register(executionCapability("binance", new BinanceIntentExecutionCapability(binance)))
    .register(executionCapability("okx", new OkxIntentExecutionCapability(okx)));

  assert.equal(registry.resolve("binance") instanceof BinanceIntentExecutionCapability, true);
  assert.equal(registry.resolve("okx") instanceof OkxIntentExecutionCapability, true);
  assert.equal(binance.providerMutations, 0);
  assert.equal(okx.providerMutations, 0);
});

test("ExecutionCoordinator can execute OKX through CapabilityRegistry lookup", async () => {
  const binance = new FakeIntentService("binance");
  const okx = new FakeIntentService("okx");
  const registry = new ExecutionCapabilityRegistry()
    .register(executionCapability("binance", new BinanceIntentExecutionCapability(binance)))
    .register(executionCapability("okx", new OkxIntentExecutionCapability(okx)));
  const coordinator = new ExecutionCoordinator(new RegistryBackedExecutionCapability(registry), () => now);

  const result = await coordinator.execute(intent({
    venue: "okx",
    accountId: "okx:account-1",
    instrumentId: "DOGE-USDT-PERP",
    quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "12.5" },
  }));

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.executionState.status, "PENDING_CONFIRMATION");
  assert.deepEqual(okx.calls.map((call) => call.venue), ["okx"]);
  assert.equal(binance.calls.length, 0);
});

class FakeIntentService {
  readonly calls: ExecutionIntent[] = [];
  providerMutations = 0;

  constructor(private readonly venue: ExecutionIntent["venue"]) {}

  async execute(executionIntent: ExecutionIntent) {
    if (executionIntent.venue !== this.venue) {
      throw new Error(`Unexpected venue: ${executionIntent.venue}.`);
    }
    this.calls.push(executionIntent);
    return Object.freeze({
      executionAttemptId: `${this.venue}-attempt-1`,
      state: "SUBMITTED" as const,
    });
  }
}

function intent(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionIntent({
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    instrumentId: "XAUT-USDT-PERP",
    positionDirection: "LONG",
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
