import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createExecutionIntent,
  createLegacyOneWayExecutionIntent,
  type ExecutionIntent,
} from "./ExecutionIntent";

const now = 1_800_000_000_000;

test("creates a passive Binance user execution intent", () => {
  const intent: ExecutionIntent = createExecutionIntent(intentInput());

  assert.deepEqual(intent, {
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
  });
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.orderConstraints), true);
});

test("preserves a valid venue without selecting strategy behavior", () => {
  const intent = createExecutionIntent({ ...intentInput(), venue: "bybit", instrumentId: "BTC-USDT-PERP" });
  assert.equal(intent.venue, "bybit");
  assert.equal(intent.instrumentId, "BTC-USDT-PERP");
});

test("preserves an explicit arbitrage instance and leg association", () => {
  const intent = createExecutionIntent({
    ...intentInput(),
    arbitrageId: "arbitrage-1",
    legId: "leg-long",
  });

  assert.equal(intent.arbitrageId, "arbitrage-1");
  assert.equal(intent.legId, "leg-long");
  assert.throws(
    () => createExecutionIntent({ ...intentInput(), arbitrageId: "arbitrage-1" }),
    /arbitrageId and legId must be provided together/u,
  );
  assert.throws(
    () => createExecutionIntent({ ...intentInput(), legId: "leg-long" }),
    /arbitrageId and legId must be provided together/u,
  );
});

test("also accepts bitget as a valid venue without selecting strategy behavior", () => {
  const intent = createExecutionIntent({ ...intentInput(), venue: "bitget", instrumentId: "ETH-USDT-PERP" });
  assert.equal(intent.venue, "bitget");
  assert.equal(intent.instrumentId, "ETH-USDT-PERP");
});

test("expresses the same canonical instrument across multiple venues", () => {
  const venues = ["binance", "okx", "bybit", "bitget"] as const;

  for (const venue of venues) {
    const intent = createExecutionIntent({
      ...intentInput(),
      venue,
      accountId: `${venue}:account-1`,
      instrumentId: "BTC-USDT-PERP",
      quantity: {
        asset: { symbol: "BTC", type: "DIGITAL_ASSET" },
        quantity: "0.01",
      },
    });
    assert.equal(intent.venue, venue);
    assert.equal(intent.instrumentId, "BTC-USDT-PERP");
    assert.equal(intent.quantity.asset.symbol, "BTC");
  }
});

test("rejects missing or invalid required execution facts", () => {
  const requiredFailures: Array<[Record<string, unknown>, RegExp]> = [
    [{ intentId: "" }, /intentId is invalid/u],
    [{ userId: undefined }, /userId is invalid/u],
    [{ venue: "tradexyz" }, /venue must be binance, okx, bybit, or bitget/u],
    [{ accountId: "" }, /accountId is invalid/u],
    [{ instrumentId: "" }, /instrumentId must be a canonical instrument id/u],
    [{ instrumentId: "xaut-usdt-perp" }, /instrumentId must be a canonical instrument id/u],
    [{ instrumentId: "XAUTUSDT" }, /instrumentId must be a canonical instrument id/u],
    [{ side: "long" }, /side must be buy or sell/u],
    [{ quantity: { asset: { symbol: "XAUT", type: "RWA_ASSET" }, quantity: "0" } }, /quantity must be greater than zero/u],
    [{ quantity: 0.002 }, /AssetQuantity must be an object/u],
    [{ orderConstraints: {} }, /reduceOnly must be a boolean/u],
    [{ executionMode: "AUTO" }, /executionMode must be PRICE_PRIORITY or EXECUTION_PRIORITY/u],
    [{ createdAt: 1.5 }, /createdAt must be a non-negative integer/u],
    [{ expiresAt: now }, /expiresAt must be after createdAt/u],
    [{ expectedProfit: 1 }, /unsupported field: expectedProfit/u],
    [{ positionDirection: "SIDEWAYS" }, /unsupported field|positionDirection/u],
  ];

  for (const [override, expected] of requiredFailures) {
    assert.throws(() => createExecutionIntent({ ...intentInput(), ...override }), expected);
  }
});

test("requires canonical direction for perpetuals and rejects it for Spot", () => {
  assert.throws(
    () => createExecutionIntent({ ...intentInput(), positionDirection: undefined }),
    /requires positionDirection/u,
  );
  assert.equal(
    createLegacyOneWayExecutionIntent({ ...intentInput(), positionDirection: undefined }).positionDirection,
    "LONG",
  );
  assert.throws(
    () => createExecutionIntent({ ...intentInput(), instrumentId: "XAUT-USDT-SPOT", positionDirection: "LONG" }),
    /Spot ExecutionIntent must not contain positionDirection/u,
  );
  for (const [side, positionDirection] of [["buy", "LONG"], ["sell", "SHORT"]] as const) {
    const intent = createExecutionIntent({ ...intentInput(), side, positionDirection });
    assert.equal(intent.positionDirection, positionDirection);
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
  assert.deepEqual(
    [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]),
    ["./AssetQuantity"],
  );
});

function intentInput(): Record<string, unknown> {
  return {
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    instrumentId: "XAUT-USDT-PERP",
    positionDirection: "LONG",
    side: "buy",
    quantity: {
      asset: { symbol: "XAUT", type: "RWA_ASSET" },
      quantity: "0.002000",
    },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
  };
}
