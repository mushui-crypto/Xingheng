import assert from "node:assert/strict";
import test from "node:test";
import {
  executionMutationSafetyConfigFromEnvironment,
  ExecutionMutationSafetyError,
  ExecutionMutationSafetyGuard,
} from "../cex/ExecutionMutationSafetyGuard";

const context = {
  venue: "bitget",
  operation: "placeOrder" as const,
  userId: "user-1",
  accountId: "bitget:1234567890abcdef",
  instrumentId: "DOGE-USDT-PERP",
  providerInstrumentId: "DOGEUSDT",
};

test("Bitget execution safety defaults to LIVE disabled and Kill Switch active", async () => {
  const guard = new ExecutionMutationSafetyGuard(executionMutationSafetyConfigFromEnvironment({}));
  assert.deepEqual(guard.status("bitget"), { liveTradingEnabled: false, killSwitchActive: true });
  await assert.rejects(guard.assertAllowed(context), (error: unknown) => (
    error instanceof ExecutionMutationSafetyError && error.category === "live_trading_disabled"
  ));
});

test("Bitget uses only venue-scoped safety gates and validates Provider identity", async () => {
  const guard = new ExecutionMutationSafetyGuard(executionMutationSafetyConfigFromEnvironment({
    LIVE_TRADING_ENABLED: "true",
    BINANCE_KILL_SWITCH: "false",
    BITGET_LIVE_TRADING_ENABLED: "true",
    BITGET_KILL_SWITCH: "false",
  }));
  let validations = 0;
  await guard.assertAllowed(context, (actual) => {
    validations += 1;
    assert.equal(actual.accountId, "bitget:1234567890abcdef");
  });
  assert.equal(validations, 1);

  const independent = new ExecutionMutationSafetyGuard(executionMutationSafetyConfigFromEnvironment({
    LIVE_TRADING_ENABLED: "true",
    BINANCE_KILL_SWITCH: "false",
  }));
  await assert.rejects(independent.assertAllowed(context), (error: unknown) => (
    error instanceof ExecutionMutationSafetyError && error.category === "live_trading_disabled"
  ));
});
