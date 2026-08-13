import assert from "node:assert/strict";
import test from "node:test";
import { UserExchangeCredentialStoreError } from "../credentials/UserExchangeCredentialStore";
import { AccountReadRegistry, AccountReadRegistryError } from "./AccountReadRegistry";
import type { AccountReadProviderFactory } from "./AccountReadProvider";

test("loads each user's credential into a distinct short-lived provider", async () => {
  const loads: Array<{ userId: string; venue: string }> = [];
  const providers: Array<{ apiKey: string; disposed: boolean }> = [];
  const registry = new AccountReadRegistry({
    loadForAccountRead: async (userId: string, venue: string) => {
      loads.push({ userId, venue });
      return { apiKey: `key-${userId}`, apiSecret: `secret-${userId}` };
    },
  } as never, factory((provider) => providers.push(provider)));

  const [first, second] = await Promise.all([
    registry.read("user-a", "binance"),
    registry.read("user-b", "binance"),
  ]);

  assert.deepEqual(loads, [
    { userId: "user-a", venue: "binance" },
    { userId: "user-b", venue: "binance" },
  ]);
  assert.deepEqual(providers.map(({ apiKey }) => apiKey), ["key-user-a", "key-user-b"]);
  assert.ok(providers.every(({ disposed }) => disposed));
  assert.equal(first.estimatedTotalValueUsdt, null);
  assert.equal(second.valuationCoverage, "UNAVAILABLE");
  assert.ok(first.balances.every((balance) => balance.valuationStatus === "UNAVAILABLE"));
  assert.equal(JSON.stringify(first).includes("key-user-a"), false);
  assert.equal(JSON.stringify(second).includes("secret-user-b"), false);
});

test("propagates a missing credential without creating a provider", async () => {
  let creates = 0;
  const registry = new AccountReadRegistry({
    loadForAccountRead: async () => {
      throw new UserExchangeCredentialStoreError("credential_not_configured", "not configured");
    },
  } as never, factory(() => { creates += 1; }));

  await assert.rejects(registry.read("user-a", "binance"), (error: unknown) => (
    error instanceof UserExchangeCredentialStoreError && error.category === "credential_not_configured"
  ));
  assert.equal(creates, 0);
});

test("disposes the provider when account read fails", async () => {
  let disposed = false;
  const registry = new AccountReadRegistry({
    loadForAccountRead: async () => ({ apiKey: "key", apiSecret: "secret" }),
  } as never, [{
    venue: "binance",
    create: () => ({
      venue: "binance",
      readAccount: async () => { throw new Error("provider failed"); },
      dispose: () => { disposed = true; },
    }),
  }]);

  await assert.rejects(registry.read("user-a", "binance"), /provider failed/u);
  assert.equal(disposed, true);
});

test("disposes the private provider before valuation and degrades valuation failures", async () => {
  let disposed = false;
  const registry = new AccountReadRegistry({
    loadForAccountRead: async () => ({ apiKey: "key", apiSecret: "secret" }),
  } as never, [{
    venue: "binance",
    create: () => ({
      venue: "binance",
      readAccount: async () => snapshot(),
      dispose: () => { disposed = true; },
    }),
  }], {
    value: async () => {
      assert.equal(disposed, true);
      throw new Error("valuation failed");
    },
  });

  const result = await registry.read("user-a", "binance");
  assert.equal(result.estimatedTotalValueUsdt, null);
  assert.equal(result.valuationCoverage, "UNAVAILABLE");
});

test("unimplemented venues do not load credentials or connect providers", async () => {
  let loads = 0;
  const registry = new AccountReadRegistry({
    loadForAccountRead: async () => {
      loads += 1;
      return { apiKey: "key", apiSecret: "secret" };
    },
  } as never, factory(() => undefined));

  await assert.rejects(registry.read("user-a", "bitget"), (error: unknown) => (
    error instanceof AccountReadRegistryError && error.category === "account_read_provider_not_implemented"
  ));
  assert.equal(loads, 0);
});

function factory(onCreate: (provider: { apiKey: string; disposed: boolean }) => void): AccountReadProviderFactory[] {
  return [{
    venue: "binance",
    create: (secret) => {
      const state = { apiKey: secret.apiKey, disposed: false };
      onCreate(state);
      return {
        venue: "binance",
        readAccount: async () => snapshot(),
        dispose: () => {
          state.disposed = true;
        },
      };
    },
  }];
}

function snapshot() {
  return {
    venue: "binance" as const,
    accountId: "binance:fixture",
    accountFingerprint: "fixture",
    uidHash: null,
    accountTypes: ["spot" as const],
    accountMode: "single_asset_one_way",
    connection: { status: "connected" as const, checkedAt: 1 },
    credentialValidation: { status: "validated" as const, checkedAt: 1 },
    balances: [{ asset: "USDT", accountType: "spot" as const, total: 1, available: 1, locked: 0 }],
    permissions: {
      read: "ENABLED" as const,
      spotTrade: "UNKNOWN" as const,
      derivativesTrade: "UNKNOWN" as const,
      withdraw: "UNKNOWN" as const,
      ipRestricted: "UNKNOWN" as const,
    },
    capabilities: {
      spotAccount: "UNKNOWN" as const,
      derivativesAccount: "UNKNOWN" as const,
      positionModeSupported: "UNKNOWN" as const,
    },
    latestSyncAt: 1,
  };
}
