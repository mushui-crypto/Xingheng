import assert from "node:assert/strict";
import test from "node:test";
import { executionMutationSafetyConfigFromEnvironment, ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";

test("Bybit safety switches are independent and fail closed by default", async () => {
  const defaults = executionMutationSafetyConfigFromEnvironment({});
  const defaultGuard = new ExecutionMutationSafetyGuard(defaults);
  assert.deepEqual(defaultGuard.status("bybit"), { liveTradingEnabled: false, killSwitchActive: true });

  const enabled = executionMutationSafetyConfigFromEnvironment({
    LIVE_TRADING_ENABLED: "false",
    BINANCE_KILL_SWITCH: "true",
    OKX_LIVE_TRADING_ENABLED: "false",
    OKX_KILL_SWITCH: "true",
    BYBIT_LIVE_TRADING_ENABLED: "true",
    BYBIT_KILL_SWITCH: "false",
  });
  const guard = new ExecutionMutationSafetyGuard(enabled);
  assert.deepEqual(guard.status("bybit"), { liveTradingEnabled: true, killSwitchActive: false });
  assert.deepEqual(guard.status("okx"), { liveTradingEnabled: false, killSwitchActive: true });
  await guard.assertAllowed({
    venue: "bybit", operation: "placeOrder", userId: "user-a", accountId: "bybit:account-a",
    instrumentId: "DOGE-USDT-PERP", providerInstrumentId: "DOGEUSDT",
  });
});
