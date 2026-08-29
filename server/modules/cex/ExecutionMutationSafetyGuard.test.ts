import assert from "node:assert/strict";
import test from "node:test";
import {
  createVerifiedExecutionProviderIdentity,
  ExecutionMutationSafetyError,
  ExecutionMutationSafetyGuard,
  type ExecutionMutationContext,
} from "./ExecutionMutationSafetyGuard";

const halted = () => new ExecutionMutationSafetyGuard({
  liveTradingEnabled: false,
  killSwitchActive: true,
});

const context = (input: Partial<ExecutionMutationContext> = {}): ExecutionMutationContext => ({
  venue: "okx",
  operation: "placeOrder",
  userId: "user-a",
  accountId: "account-a",
  instrumentId: "BTC-USDT-PERP",
  providerInstrumentId: "BTC-USDT-SWAP",
  ...input,
});

test("halted guard rejects INCREASE, missing, and unknown placeOrder effects", async () => {
  for (const mutationEffect of ["INCREASE", undefined, "UNKNOWN"] as const) {
    const value = mutationEffect === undefined
      ? context()
      : context({ mutationEffect } as Partial<ExecutionMutationContext>);
    await assert.rejects(
      halted().assertAllowed(value),
      (error) => error instanceof ExecutionMutationSafetyError
        && error.category === "live_trading_disabled",
    );
  }
});

test("halted guard lets DECREASE reach identity validation without allowing invalid identity", async () => {
  let identityReads = 0;
  const guard = new ExecutionMutationSafetyGuard({
    liveTradingEnabled: false,
    killSwitchActive: true,
    validateProviderIdentity: () => {
      identityReads += 1;
      throw new Error("identity mismatch");
    },
  });
  await assert.rejects(
    guard.assertAllowed(context({ mutationEffect: "DECREASE" })),
    (error) => error instanceof ExecutionMutationSafetyError
      && error.category === "provider_identity_invalid",
  );
  assert.equal(identityReads, 1);
});

test("halted guard lets known-order cancel reach identity validation", async () => {
  let identityReads = 0;
  const guard = new ExecutionMutationSafetyGuard({
    liveTradingEnabled: false,
    killSwitchActive: true,
    validateProviderIdentity: () => { identityReads += 1; },
  });
  await guard.assertAllowed(context({ operation: "cancelOrder" }));
  assert.equal(identityReads, 1);
});

test("a fresh attempt-scoped verified identity preserves the final guard without a duplicate Provider read", async () => {
  let identityReads = 0;
  const verifiedAt = 1_800_000_000_000;
  const identity = createVerifiedExecutionProviderIdentity({
    userId: "user-a",
    venue: "okx",
    accountId: "account-a",
    executionIntentId: "intent-a",
    verifiedAt,
  });
  const guard = new ExecutionMutationSafetyGuard({
    liveTradingEnabled: true,
    killSwitchActive: false,
  });

  await guard.assertAllowed(context({
    mutationEffect: "DECREASE",
    executionIntentId: "intent-a",
    mutationPreparedAt: verifiedAt + 100,
    verifiedProviderIdentity: identity,
  }), () => { identityReads += 1; });

  assert.equal(identityReads, 0);
});

test("untrusted, stale, or scope-mismatched identity context fails closed", async (t) => {
  const verifiedAt = 1_800_000_000_000;
  const identity = createVerifiedExecutionProviderIdentity({
    userId: "user-a",
    venue: "okx",
    accountId: "account-a",
    executionIntentId: "intent-a",
    verifiedAt,
  });
  const guard = new ExecutionMutationSafetyGuard({
    liveTradingEnabled: true,
    killSwitchActive: false,
  });
  const scenarios = [
    { name: "untrusted clone", identity: { ...identity }, preparedAt: verifiedAt + 100, intentId: "intent-a" },
    { name: "stale", identity, preparedAt: verifiedAt + 15_001, intentId: "intent-a" },
    { name: "wrong attempt", identity, preparedAt: verifiedAt + 100, intentId: "intent-b" },
  ] as const;
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        guard.assertAllowed(context({
          mutationEffect: "DECREASE",
          executionIntentId: scenario.intentId,
          mutationPreparedAt: scenario.preparedAt,
          verifiedProviderIdentity: scenario.identity,
        })),
        (error) => error instanceof ExecutionMutationSafetyError
          && error.category === "identity_context_invalid",
      );
    });
  }
});

test("DECREASE and cancel still reject incomplete local identity before mutation", async () => {
  for (const value of [
    context({ mutationEffect: "DECREASE", accountId: "" }),
    context({ operation: "cancelOrder", providerInstrumentId: "" }),
  ]) {
    await assert.rejects(
      halted().assertAllowed(value),
      (error) => error instanceof ExecutionMutationSafetyError && error.category === "identity_invalid",
    );
  }
});
