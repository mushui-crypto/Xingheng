import assert from "node:assert/strict";
import test from "node:test";
import { OkxIntentExecutionServiceRegistry } from "./OkxIntentExecutionServiceRegistry";
import type { OkxCredentials } from "./OkxTypes";

test("loads the authenticated user's OKX credential for execution service creation", async () => {
  const credentials = new MemoryCredentialStore();
  const created: Array<{ credential: OkxCredentials; accountId: string; userId: string }> = [];
  let providerMutations = 0;
  const registry = new OkxIntentExecutionServiceRegistry(credentials, {
    serviceFactory: (credential, summary) => {
      created.push({ credential, accountId: summary.accountId, userId: summary.userId });
      return {
        executionAccountIdentity: () => ({ accountId: summary.accountId }),
        placeOrder: async () => {
          providerMutations += 1;
          throw new Error("provider mutation must not run in credential injection test");
        },
        getOrder: async () => {
          throw new Error("provider query must not run in credential injection test");
        },
        cancelOrder: async () => {
          providerMutations += 1;
          throw new Error("provider cancel must not run in credential injection test");
        },
      };
    },
  });

  const account = await registry.run("user-a", (service) => service.executionAccountIdentity());

  assert.deepEqual(account, { accountId: "okx:account-user-a" });
  assert.deepEqual(credentials.summaryCalls, [{ userId: "user-a", venue: "okx" }]);
  assert.deepEqual(credentials.executionCalls, [{ userId: "user-a", venue: "okx" }]);
  assert.deepEqual(created, [{
    credential: { apiKey: "okx-api-user-a", apiSecret: "okx-secret-user-a", passphrase: "okx-pass-user-a" },
    accountId: "okx:account-user-a",
    userId: "user-a",
  }]);
  assert.equal(providerMutations, 0);
});

test("does not reuse user A credential for user B", async () => {
  const credentials = new MemoryCredentialStore();
  const created: Array<{ apiKey: string; accountId: string; userId: string }> = [];
  const registry = new OkxIntentExecutionServiceRegistry(credentials, {
    serviceFactory: (credential, summary) => {
      created.push({ apiKey: credential.apiKey, accountId: summary.accountId, userId: summary.userId });
      return {
        executionAccountIdentity: () => ({ accountId: summary.accountId }),
        placeOrder: async () => {
          throw new Error("provider mutation must not run in registry test");
        },
        getOrder: async () => {
          throw new Error("provider query must not run in registry test");
        },
        cancelOrder: async () => {
          throw new Error("provider cancel must not run in registry test");
        },
      };
    },
  });

  await registry.run("user-a", (service) => service.executionAccountIdentity());
  await registry.run("user-b", (service) => service.executionAccountIdentity());

  assert.deepEqual(created, [
    { apiKey: "okx-api-user-a", accountId: "okx:account-user-a", userId: "user-a" },
    { apiKey: "okx-api-user-b", accountId: "okx:account-user-b", userId: "user-b" },
  ]);
});

class MemoryCredentialStore {
  readonly summaryCalls: Array<{ userId: string; venue: "okx" }> = [];
  readonly executionCalls: Array<{ userId: string; venue: "okx" }> = [];

  findSummary(userId: string, venue: "okx") {
    this.summaryCalls.push({ userId, venue });
    if (userId !== "user-a" && userId !== "user-b") return null;
    return {
      userId,
      venue,
      accountId: `okx:account-${userId}`,
      accountFingerprint: `${userId}:fingerprint`,
      maskedApiKey: "okx-...-key",
      environment: "test" as const,
      permissions: {},
      lastVerifiedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  async loadForExecution(userId: string, venue: "okx") {
    this.executionCalls.push({ userId, venue });
    return {
      apiKey: `okx-api-${userId}`,
      apiSecret: `okx-secret-${userId}`,
      passphrase: `okx-pass-${userId}`,
    };
  }
}
