import assert from "node:assert/strict";
import test from "node:test";
import { BinancePersonalTradingServiceRegistry } from "./BinancePersonalTradingServiceRegistry";

test("status uses encrypted metadata without decrypting credentials", () => {
  let decryptCalls = 0;
  const registry = new BinancePersonalTradingServiceRegistry({
    findSummary: () => summary("user-1"),
    loadForExecution: async () => {
      decryptCalls += 1;
      return { apiKey: "key", apiSecret: "secret" };
    },
  } as never);

  const status = registry.status("user-1");
  assert.equal(status.credential.maskedApiKey, "api-...-001");
  assert.equal(status.connection.accountId, "binance:account-user-1");
  assert.equal(decryptCalls, 0);
});

test("loads the authenticated user's credential and isolates order databases", async () => {
  const created: Array<{ apiKey: string; orderDbPath: string }> = [];
  const registry = new BinancePersonalTradingServiceRegistry({
    findSummary: (userId: string) => summary(userId),
    loadForExecution: async (userId: string) => ({ apiKey: `key-${userId}`, apiSecret: `secret-${userId}` }),
  } as never, {
    orderDbPathForUser: (userId) => `/tmp/${userId}.sqlite`,
    serviceFactory: (credential, orderDbPath) => {
      created.push({ apiKey: credential.apiKey, orderDbPath });
      return fakeService();
    },
  });

  await registry.run("user-1", (service) => service.account());
  await registry.run("user-2", (service) => service.account());
  assert.deepEqual(created, [
    { apiKey: "key-user-1", orderDbPath: "/tmp/user-1.sqlite" },
    { apiKey: "key-user-2", orderDbPath: "/tmp/user-2.sqlite" },
  ]);
});

test("serializes provider operations for the same user", async () => {
  let active = 0;
  let maximumActive = 0;
  const registry = new BinancePersonalTradingServiceRegistry({
    findSummary: () => summary("user-1"),
    loadForExecution: async () => ({ apiKey: "key", apiSecret: "secret" }),
  } as never, {
    serviceFactory: () => fakeService({
      account: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return flatSnapshot();
      },
    }),
  });

  await Promise.all([
    registry.run("user-1", (service) => service.account()),
    registry.run("user-1", (service) => service.account()),
  ]);
  assert.equal(maximumActive, 1);
});

test("blocks credential deletion while provider exposure remains", async () => {
  let deleted = false;
  const registry = new BinancePersonalTradingServiceRegistry({
    findSummary: () => summary("user-1"),
    loadForExecution: async () => ({ apiKey: "key", apiSecret: "secret" }),
    delete: () => { deleted = true; },
  } as never, {
    serviceFactory: () => fakeService({
      account: async () => ({ ...flatSnapshot(), existingPerpetualQuantityXaut: 0.002 }),
    }),
  });
  await assert.rejects(registry.deleteCredential("user-1"), /cannot be removed/u);
  assert.equal(deleted, false);
});

function summary(userId: string) {
  return {
    userId,
    venue: "binance" as const,
    accountId: `binance:account-${userId}`,
    accountFingerprint: `fingerprint-${userId}`,
    maskedApiKey: "api-...-001",
    environment: "test" as const,
    permissions: { read: true, trade: true, withdraw: false },
    lastVerifiedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function flatSnapshot() {
  return {
    openSpotOrderCount: 0,
    openPerpetualOrderCount: 0,
    existingSpotQuantityXaut: 0,
    existingPerpetualQuantityXaut: 0,
  };
}

function fakeService(overrides: Record<string, unknown> = {}) {
  return {
    checkConnection: async () => ({ connection: { status: "connected", checkedAt: 1, accountId: "binance:account", message: null } }),
    account: async () => flatSnapshot(),
    market: async () => ({}),
    loadExecutionReadContext: async () => ({}),
    placeExecutionOrder: async () => ({}),
    findExecutionOrderByClientOrderId: async () => null,
    cancelOrder: async () => ({}),
    ordersState: () => ({ orders: [] }),
    close: () => undefined,
    ...overrides,
  } as never;
}
