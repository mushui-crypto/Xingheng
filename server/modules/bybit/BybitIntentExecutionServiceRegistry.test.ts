import assert from "node:assert/strict";
import test from "node:test";
import { BybitIntentExecutionServiceRegistry } from "./BybitIntentExecutionServiceRegistry";

test("Bybit execution registry binds authenticated user, Provider identity, and execution-enabled credential", async () => {
  const calls: string[] = [];
  const registry = new BybitIntentExecutionServiceRegistry(
    {
      findSummary: (userId: string, venue: string) => venue === "bybit" && userId === "user-a"
        ? { accountId: "bybit:account-a", permissions: { executionEnabled: true } } as never
        : null,
      loadForExecution: async () => ({ apiKey: "key", apiSecret: "secret" }),
    },
    {
      clientFactory: () => ({
        getLinearPositionIdx: async () => 0 as const,
        placeOrder: async (request) => ({ category: request.category, symbol: request.symbol, orderId: "1", orderLinkId: request.orderLinkId }),
        getOrder: async () => { throw new Error("not used"); },
        cancelOrder: async (request) => ({ category: request.category, symbol: request.symbol, orderId: request.orderId ?? "1", orderLinkId: request.orderLinkId }),
        getAccountIdentity: async () => { calls.push("identity"); return { accountId: "bybit:account-a", accountFingerprint: "fingerprint", uidHash: "hash" }; },
      }),
    },
  );
  await registry.run("user-a", async (service) => {
    assert.deepEqual(await service.executionAccountIdentity(), { accountId: "bybit:account-a" });
    await service.validateExecutionProviderIdentity({
      venue: "bybit", operation: "placeOrder", userId: "user-a", accountId: "bybit:account-a",
      instrumentId: "DOGE-USDT-PERP", providerInstrumentId: "DOGEUSDT",
    });
  });
  assert.deepEqual(calls, ["identity"]);
  await assert.rejects(
    registry.run("user-b", async () => undefined),
    /not configured/u,
  );
});
