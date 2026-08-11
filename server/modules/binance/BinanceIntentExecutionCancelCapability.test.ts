import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { BinanceIntentExecutionCancelCapability } from "./BinanceIntentExecutionCancelCapability";

const now = 1_800_000_000_000;

test("allows only pending and unknown records with matching user, account, and venue", async () => {
  let providerMutations = 0;
  const capability = new BinanceIntentExecutionCancelCapability({
    async cancel() {
      providerMutations += 1;
      return { state: "CANCELLED", observedAt: now };
    },
  }, {
    userId: "user-a",
    accountId: "binance:account-user-a",
  });

  await capability.cancel(executionRecord());
  await capability.cancel(executionRecord({ status: "UNKNOWN" }));
  assert.equal(providerMutations, 2);

  for (const record of [
    executionRecord({ status: "CONFIRMED" }),
    executionRecord({ status: "FAILED" }),
    executionRecord({ userId: "user-b" }),
    executionRecord({ accountId: "binance:account-user-b" }),
    executionRecord({ venue: "okx", accountId: "okx:account-user-a" }),
  ]) {
    await assert.rejects(() => capability.cancel(record));
  }
  assert.equal(providerMutations, 2);
});

function executionRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionRecord({
    executionId: "execution-1",
    intentId: "intent-1",
    userId: "user-a",
    venue: "binance",
    accountId: "binance:account-user-a",
    instrumentId: "XAUT-USDT-PERP",
    status: "PENDING_CONFIRMATION",
    createdAt: now - 1_000,
    updatedAt: now,
    ...overrides,
  });
}
