import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { BinanceIntentExecutionReconciliationCapability } from "./BinanceIntentExecutionReconciliationCapability";

const now = 1_800_000_000_000;

test("validates user, account, and venue before remote reconciliation", async () => {
  let reconciliations = 0;
  const capability = new BinanceIntentExecutionReconciliationCapability({
    async reconcile() {
      reconciliations += 1;
      return { state: "UNKNOWN", filledBaseQuantity: "0", observedAt: now };
    },
  }, {
    userId: "user-a",
    accountId: "binance:account-user-a",
  });

  await assert.rejects(() => capability.reconcile(executionRecord({ userId: "user-b" })), /userId does not match/u);
  await assert.rejects(
    () => capability.reconcile(executionRecord({ accountId: "binance:account-user-b" })),
    /accountId does not match/u,
  );
  await assert.rejects(
    () => capability.reconcile(executionRecord({ venue: "okx", accountId: "okx:account-user-a" })),
    /Unsupported execution venue/u,
  );
  assert.equal(reconciliations, 0);
});

function executionRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionRecord({
    executionId: "execution-1",
    intentId: "intent-1",
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
