import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExecutionCapability } from "../cex/ExecutionCapability";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import { BinanceIntentExecutionCapability } from "./BinanceIntentExecutionCapability";
import type { BinanceIntentExecutionResult } from "./BinanceIntentExecutionService";

const now = 1_800_000_000_000;

test("implements ExecutionCapability by delegating Binance intents", async () => {
  const service = new FakeBinanceIntentExecutionService();
  const capability: ExecutionCapability<BinanceIntentExecutionResult> = new BinanceIntentExecutionCapability(service);
  const intent = executionIntent();

  const result = await capability.execute(intent);

  assert.equal(result.executionAttemptId, intent.intentId);
  assert.equal(service.calls.length, 1);
  assert.deepEqual(service.calls[0], intent);
});

test("rejects non-Binance venues before service or provider mutation", async () => {
  const service = new FakeBinanceIntentExecutionService();
  const capability = new BinanceIntentExecutionCapability(service);

  await assert.rejects(
    () => capability.execute(executionIntent({ venue: "okx", accountId: "okx:account-1" })),
    /Unsupported execution venue: okx/u,
  );
  assert.equal(service.calls.length, 0);
});

test("capability imports no concrete provider, order manager, risk guard, or strategy", () => {
  const source = readFileSync(new URL("./BinanceIntentExecutionCapability.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /BinanceClient|BinanceOrderManager|BinanceRiskGuard|Funding|Strategy|placeOrder|cancelOrder|fetch\(/u);
});

class FakeBinanceIntentExecutionService {
  readonly calls: ExecutionIntent[] = [];

  async execute(intent: ExecutionIntent): Promise<BinanceIntentExecutionResult> {
    this.calls.push(intent);
    return Object.freeze({ executionAttemptId: intent.intentId, state: "SUBMITTED" });
  }
}

function executionIntent(overrides: Partial<Record<string, unknown>> = {}) {
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
