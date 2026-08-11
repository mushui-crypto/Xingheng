import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionIntent, type ExecutionIntent } from "./ExecutionIntent";

const now = 1_800_000_000_000;

test("creates a passive Binance user execution intent", () => {
  const intent: ExecutionIntent = createExecutionIntent(intentInput());

  assert.deepEqual(intent, {
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
  });
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.orderConstraints), true);
});

test("preserves a valid venue without selecting strategy behavior", () => {
  const intent = createExecutionIntent({ ...intentInput(), venue: "bybit", symbol: "BTCUSDT" });
  assert.equal(intent.venue, "bybit");
  assert.equal(intent.symbol, "BTCUSDT");
});

test("also accepts bitget as a valid venue without selecting strategy behavior", () => {
  const intent = createExecutionIntent({ ...intentInput(), venue: "bitget", symbol: "ETHUSDT" });
  assert.equal(intent.venue, "bitget");
  assert.equal(intent.symbol, "ETHUSDT");
});

test("rejects missing or invalid required execution facts", () => {
  const requiredFailures: Array<[Record<string, unknown>, RegExp]> = [
    [{ intentId: "" }, /intentId is invalid/u],
    [{ userId: undefined }, /userId is invalid/u],
    [{ venue: "tradexyz" }, /venue must be binance, okx, bybit, or bitget/u],
    [{ accountId: "" }, /accountId is invalid/u],
    [{ symbol: "" }, /symbol must be an uppercase venue symbol/u],
    [{ symbol: "xaut-usdt" }, /symbol must be an uppercase venue symbol/u],
    [{ side: "long" }, /side must be buy or sell/u],
    [{ quantity: "0" }, /quantity must be greater than zero/u],
    [{ quantity: 0.002 }, /positive decimal string/u],
    [{ orderConstraints: {} }, /reduceOnly must be a boolean/u],
    [{ executionMode: "AUTO" }, /executionMode must be PRICE_PRIORITY or EXECUTION_PRIORITY/u],
    [{ createdAt: 1.5 }, /createdAt must be a non-negative integer/u],
    [{ expiresAt: now }, /expiresAt must be after createdAt/u],
    [{ expectedProfit: 1 }, /unsupported field: expectedProfit/u],
  ];

  for (const [override, expected] of requiredFailures) {
    assert.throws(() => createExecutionIntent({ ...intentInput(), ...override }), expected);
  }
});

test("creation has no provider or trading side effects", () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network access is forbidden");
  };
  try {
    createExecutionIntent(intentInput());
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const source = readFileSync(new URL("./ExecutionIntent.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /BinanceClient|OrderManager|RiskGuard|Credential|placeOrder|cancelOrder|fetch\(/u);
  assert.doesNotMatch(source, /expectedProfit|fundingRateSignal|strategyScore|opportunityRanking|autoExecute/iu);
  assert.deepEqual([...source.matchAll(/from\s+"([^"]+)"/gu)], []);
});

function intentInput(): Record<string, unknown> {
  return {
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    symbol: "XAUTUSDT",
    side: "buy",
    quantity: "0.002000",
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
  };
}
