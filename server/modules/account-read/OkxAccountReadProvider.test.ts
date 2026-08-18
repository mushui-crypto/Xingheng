import assert from "node:assert/strict";
import test from "node:test";
import { UserExchangeCredentialStoreError } from "../credentials/UserExchangeCredentialStore";
import type { OkxAccountReadSnapshot } from "../okx/OkxAccountReadClient";
import { AccountReadRegistry } from "./AccountReadRegistry";
import { OkxAccountReadProvider, OkxAccountReadProviderFactory } from "./OkxAccountReadProvider";

test("maps OKX account modes without forcing unified balances into spot or derivatives", async (t) => {
  for (const [level, accountType, accountMode] of [
    ["1", "spot", "spot"],
    ["2", "unified", "single_currency_margin"],
    ["3", "unified", "multi_currency_margin"],
    ["4", "unified", "portfolio_margin"],
    ["9", "unknown", "unknown"],
  ] as const) {
    await t.test(`acctLv=${level}`, async () => {
      const provider = new OkxAccountReadProvider({
        readAccountSnapshot: async () => okxSnapshot({ accountLevel: level }),
      });
      const snapshot = await provider.readAccount();
      assert.deepEqual(snapshot.accountTypes, [accountType]);
      assert.equal(snapshot.accountMode, accountMode);
      assert.ok(snapshot.balances.every((balance) => balance.accountType === accountType));
    });
  }
});

test("maps only explicitly reported OKX permissions and keeps product capabilities unknown", async () => {
  const provider = new OkxAccountReadProvider({
    readAccountSnapshot: async () => okxSnapshot({ permissions: "read_only,trade", boundIps: "203.0.113.10" }),
  });
  const snapshot = await provider.readAccount();

  assert.deepEqual(snapshot.permissions, {
    read: "ENABLED",
    spotTrade: "UNKNOWN",
    derivativesTrade: "UNKNOWN",
    withdraw: "DISABLED",
    ipRestricted: "ENABLED",
  });
  assert.deepEqual(snapshot.capabilities, {
    spotAccount: "UNKNOWN",
    derivativesAccount: "UNKNOWN",
    positionModeSupported: "UNKNOWN",
  });
  assert.equal(snapshot.accountId.startsWith("okx:"), true);
  assert.equal(snapshot.accountId.includes("44705892343619584"), false);
  assert.ok(snapshot.balances.every((balance) => typeof balance.available === "number"));
});

test("uses UNKNOWN when OKX permission metadata is unavailable", async () => {
  const provider = new OkxAccountReadProvider({
    readAccountSnapshot: async () => okxSnapshot({ permissions: null, boundIps: null }),
  });
  const snapshot = await provider.readAccount();
  assert.equal(snapshot.permissions.read, "UNKNOWN");
  assert.equal(snapshot.permissions.withdraw, "UNKNOWN");
  assert.equal(snapshot.permissions.ipRestricted, "UNKNOWN");
});

test("loads isolated OKX credentials into independent clients and disposes on success", async () => {
  const clients: Array<{ apiKey: string; disposed: boolean }> = [];
  const registry = new AccountReadRegistry({
    loadForAccountRead: async (userId: string, venue: string) => ({
      apiKey: `key-${userId}`,
      apiSecret: `secret-${userId}`,
      passphrase: `passphrase-${venue}-${userId}`,
    }),
  } as never, [new OkxAccountReadProviderFactory((secret) => {
    const state = { apiKey: secret.apiKey, disposed: false };
    clients.push(state);
    return {
      readAccountSnapshot: async () => okxSnapshot({ uid: secret.apiKey }),
      dispose: () => { state.disposed = true; },
    };
  })]);

  const [first, second] = await Promise.all([
    registry.read("user-a", "okx"),
    registry.read("user-b", "okx"),
  ]);

  assert.deepEqual(clients.map(({ apiKey }) => apiKey), ["key-user-a", "key-user-b"]);
  assert.ok(clients.every(({ disposed }) => disposed));
  assert.notEqual(first.accountId, second.accountId);
  assert.equal(first.estimatedTotalValueUsdt, null);
  assert.equal(second.valuationCoverage, "UNAVAILABLE");
});

test("default OKX factory rejects a credential without passphrase", () => {
  const factory = new OkxAccountReadProviderFactory();
  assert.throws(
    () => factory.create({ apiKey: "key", apiSecret: "secret" }),
    /requires a credential passphrase/u,
  );
});

test("disposes the OKX client when account read fails", async () => {
  let disposed = false;
  const registry = new AccountReadRegistry({
    loadForAccountRead: async () => ({ apiKey: "key", apiSecret: "secret", passphrase: "passphrase" }),
  } as never, [new OkxAccountReadProviderFactory(() => ({
    readAccountSnapshot: async () => { throw new Error("OKX failed"); },
    dispose: () => { disposed = true; },
  }))]);

  await assert.rejects(registry.read("user-a", "okx"), /OKX failed/u);
  assert.equal(disposed, true);
});

test("missing OKX credential fails before client creation", async () => {
  let creates = 0;
  const registry = new AccountReadRegistry({
    loadForAccountRead: async () => {
      throw new UserExchangeCredentialStoreError("credential_not_configured", "not configured");
    },
  } as never, [new OkxAccountReadProviderFactory(() => {
    creates += 1;
    return { readAccountSnapshot: async () => okxSnapshot() };
  })]);

  await assert.rejects(registry.read("user-a", "okx"), (error: unknown) => (
    error instanceof UserExchangeCredentialStoreError && error.category === "credential_not_configured"
  ));
  assert.equal(creates, 0);
});

function okxSnapshot(overrides: Partial<OkxAccountReadSnapshot> = {}): OkxAccountReadSnapshot {
  return {
    uid: "44705892343619584",
    accountLevel: "3",
    permissions: "read_only",
    boundIps: "",
    balances: [
      { asset: "USDT", total: 120, available: 100, locked: 20 },
      { asset: "BTC", total: 0.002, available: 0.002, locked: 0 },
    ],
    fetchedAt: 1_800_000_000_000,
    ...overrides,
  };
}
