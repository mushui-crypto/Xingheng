import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BinanceExecutionCapability } from "../binance/BinanceExecutionCapability";
import type {
  OkxCancelOrderRequest,
  OkxClientLike,
  OkxOrderQuery,
  OkxOrderRecord,
  OkxPositionRecord,
  OkxSubmitOrderRequest,
} from "../okx/OkxClient";
import { OkxExecutionCapability } from "../okx/OkxExecutionCapability";
import type { ExecutionCapability } from "./ExecutionCapability";
import { ExecutionCapabilityRegistry, executionCapability } from "./ExecutionCapabilityRegistry";
import { ExecutionCoordinator } from "./ExecutionCoordinator";
import { createExecutionIntent, type ExecutionIntent } from "./ExecutionIntent";

const now = 1_800_000_000_000;

test("resolves a registered Binance execution capability", () => {
  const service = new FakeBinanceService();
  const capability = new BinanceExecutionCapability(service);
  const registry = new ExecutionCapabilityRegistry()
    .register(executionCapability("binance", capability));

  assert.equal(registry.resolve("binance"), capability);
  assert.equal(service.calls.length, 0);
});

test("resolves a registered OKX execution capability", () => {
  const client = new FakeOkxClient();
  const capability = new OkxExecutionCapability(client);
  const registry = new ExecutionCapabilityRegistry()
    .register(executionCapability("okx", capability));

  assert.equal(registry.resolve("okx"), capability);
  assert.equal(client.submitted.length, 0);
});

test("rejects unknown or duplicate venue registrations", () => {
  const registry = new ExecutionCapabilityRegistry()
    .register(executionCapability("binance", new MockExecutionCapability("binance")));

  assert.throws(() => registry.resolve("okx"), /not registered for venue: okx/u);
  assert.throws(() => registry.register(
    executionCapability("binance", new MockExecutionCapability("binance")),
  ), /already registered/u);
});

test("can be injected into ExecutionCoordinator without venue branches", async () => {
  const binance = new MockExecutionCapability("binance");
  const okx = new MockExecutionCapability("okx");
  const registry = new ExecutionCapabilityRegistry()
    .register(executionCapability("binance", binance))
    .register(executionCapability("okx", okx));
  const coordinator = new ExecutionCoordinator(new ResolvedExecutionCapability(registry), () => now);

  const binanceResult = await coordinator.execute(intent({ venue: "binance" }));
  const okxResult = await coordinator.execute(intent({ venue: "okx", accountId: "okx:account-1" }));

  assert.equal(binanceResult.status, "SUCCEEDED");
  assert.equal(okxResult.status, "SUCCEEDED");
  assert.deepEqual(binance.calls.map((call) => call.venue), ["binance"]);
  assert.deepEqual(okx.calls.map((call) => call.venue), ["okx"]);
});

test("registry lookup has no provider, routing, strategy, or scheduler dependency", () => {
  const provider = new MockExecutionCapability("binance");
  const registry = new ExecutionCapabilityRegistry()
    .register(executionCapability("binance", provider));

  registry.resolve("binance");
  assert.equal(provider.calls.length, 0);

  const source = readFileSync(new URL("./ExecutionCapabilityRegistry.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /async execute|execute\(intent/u);
  assert.doesNotMatch(source, /Binance|Okx|Bybit|Bitget|Client|OrderManager|RiskGuard|Strategy|Funding|Arbitrage/iu);
  assert.doesNotMatch(source, /price|profit|allocation|route|scheduler|worker|queue|fetch\(|placeOrder|cancelOrder/iu);
});

class ResolvedExecutionCapability<TResult>
implements ExecutionCapability<TResult> {
  constructor(private readonly registry: ExecutionCapabilityRegistry<TResult>) {}

  async execute(executionIntent: ExecutionIntent): Promise<TResult> {
    return this.registry.resolve(executionIntent.venue).execute(executionIntent);
  }
}

class MockExecutionCapability {
  readonly calls: ExecutionIntent[] = [];

  constructor(private readonly venue: ExecutionIntent["venue"]) {}

  async execute(executionIntent: ExecutionIntent) {
    if (executionIntent.venue !== this.venue) {
      throw new Error(`Unexpected venue: ${executionIntent.venue}.`);
    }
    this.calls.push(executionIntent);
    return Object.freeze({ executionAttemptId: `${this.venue}-attempt-1` });
  }
}

class FakeBinanceService {
  readonly calls: ExecutionIntent[] = [];

  async execute(executionIntent: ExecutionIntent) {
    this.calls.push(executionIntent);
    return Object.freeze({ executionAttemptId: "binance-attempt-1" });
  }
}

class FakeOkxClient implements OkxClientLike {
  readonly submitted: OkxSubmitOrderRequest[] = [];

  async submitOrder(request: OkxSubmitOrderRequest): Promise<OkxOrderRecord> {
    this.submitted.push(request);
    return {
      ordId: "okx-ord-1",
      clOrdId: "intent-user-1",
      instId: "XAUT-USDT-SWAP",
      state: "live",
      filledSz: "0",
      avgPx: "0",
    };
  }

  async getOrder(_query: OkxOrderQuery): Promise<OkxOrderRecord> {
    return {
      ordId: "okx-ord-1",
      clOrdId: "intent-user-1",
      instId: "XAUT-USDT-SWAP",
      state: "filled",
      filledSz: "0.002",
      avgPx: "4325",
    };
  }

  async cancelOrder(_request: OkxCancelOrderRequest): Promise<OkxOrderRecord> {
    return {
      ordId: "okx-ord-1",
      clOrdId: "intent-user-1",
      instId: "XAUT-USDT-SWAP",
      state: "canceled",
      filledSz: "0",
      avgPx: "0",
    };
  }

  async getPosition(_instId: string): Promise<OkxPositionRecord | null> {
    return null;
  }
}

function intent(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionIntent({
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    symbol: "XAUTUSDT",
    side: "buy",
    quantity: "0.002",
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  });
}
