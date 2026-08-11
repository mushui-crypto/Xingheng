import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { BinanceIntentExecutionQueryCapability } from "./BinanceIntentExecutionQueryCapability";

const now = 1_800_000_000_000;

test("validates user, account, and venue before querying local order facts", async () => {
  let queries = 0;
  const capability = new BinanceIntentExecutionQueryCapability({
    async query() {
      queries += 1;
      return { state: "UNKNOWN", filledBaseQuantity: "0", observedAt: now };
    },
  }, {
    userId: "user-a",
    accountId: "binance:account-user-a",
  });

  await assert.rejects(() => capability.query(executionRecord({ userId: "user-b" })), /userId does not match/u);
  await assert.rejects(
    () => capability.query(executionRecord({ accountId: "binance:account-user-b" })),
    /accountId does not match/u,
  );
  await assert.rejects(
    () => capability.query(executionRecord({ venue: "okx", accountId: "okx:account-user-a" })),
    /Unsupported execution venue/u,
  );
  assert.equal(queries, 0);
});

function executionRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionRecord({
    executionId: "execution-1",
    intentId: "intent-user-1",
    userId: "user-a",
    venue: "binance",
    accountId: "binance:account-user-a",
    instrumentId: "XAUT-USDT-PERP",
    status: "UNKNOWN",
    createdAt: now - 1_000,
    updatedAt: now,
    ...overrides,
  });
}
