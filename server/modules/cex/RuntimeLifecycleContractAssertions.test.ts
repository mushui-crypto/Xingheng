import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionIntent } from "./ExecutionIntent";
import { createExecutionRecord } from "./ExecutionRecord";
import {
  assertExecutionIdentityContract,
  assertPreflightFailureContract,
  assertPreparationFailureContract,
} from "./RuntimeLifecycleContractAssertions";

const now = 1_800_000_000_000;

for (const venue of ["binance", "okx"] as const) {
  test(`${venue} shares the preflight and preparation contract`, async () => {
    const intent = executionIntent(venue);
    const initial = createExecutionRecord({
      executionId: `${venue}-record`,
      intentId: intent.intentId,
      userId: intent.userId,
      venue,
      accountId: intent.accountId,
      instrumentId: intent.instrumentId,
      status: "CREATED",
      createdAt: now,
      updatedAt: now,
    });
    const failed = { ...initial, status: "FAILED" as const };
    const originalError = new Error(`${venue} preparation failed`);

    await assertPreflightFailureContract({ record: null, mutationCount: 0 });
    await assertPreparationFailureContract({
      initialRecord: initial,
      finalRecord: failed,
      loadRecord: () => failed,
      mutationCount: 0,
      error: originalError,
      originalError,
    });
    assertExecutionIdentityContract(failed, intent);
  });
}

function executionIntent(venue: "binance" | "okx") {
  return createExecutionIntent({
    intentId: `${venue}-intent`,
    userId: "user-a",
    venue,
    accountId: `${venue}:account-user-a`,
    instrumentId: "XAUT-USDT-PERP",
    positionDirection: "LONG",
    side: "buy",
    quantity: { asset: { symbol: "XAUT", type: "RWA_ASSET" }, quantity: "0.002" },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
  });
}
