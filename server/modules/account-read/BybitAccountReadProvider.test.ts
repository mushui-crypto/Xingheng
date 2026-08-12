import assert from "node:assert/strict";
import test from "node:test";
import { UserExchangeCredentialStoreError } from "../credentials/UserExchangeCredentialStore";
import type { BybitAccountReadSnapshot } from "../bybit/BybitAccountReadClient";
import { AccountReadRegistry } from "./AccountReadRegistry";
import { BybitAccountReadProvider, BybitAccountReadProviderFactory } from "./BybitAccountReadProvider";

test("maps Bybit classic, unified, and unknown account modes", async (t) => {
  for (const [status, accountTypes, accountMode] of [
    [1, ["spot", "derivatives"], "classic:regular_margin"],
    [3, ["unified"], "unified_1:regular_margin"],
    [4, ["unified"], "unified_1_pro:regular_margin"],
    [5, ["unified"], "unified_2:regular_margin"],
    [6, ["unified"], "unified_2_pro:regular_margin"],
    [9, ["unknown"], "unknown:regular_margin"],
  ] as const) {
    await t.test(`unifiedMarginStatus=${status}`, async () => {
      const provider = new BybitAccountReadProvider({
        readAccountSnapshot: async () => bybitSnapshot({ unifiedMarginStatus: status }),
      });
      const snapshot = await provider.readAccount();
      assert.deepEqual(snapshot.accountTypes, accountTypes);
      assert.equal(snapshot.accountMode, accountMode);
    });
  }
});

test("maps only explicit Bybit permission metadata", async () => {
  const provider = new BybitAccountReadProvider({
    readAccountSnapshot: async () => bybitSnapshot(),
  });
  const snapshot = await provider.readAccount();

  assert.deepEqual(snapshot.permissions, {
    read: "ENABLED",
    spotTrade: "ENABLED",
    derivativesTrade: "ENABLED",
    withdraw: "DISABLED",
    ipRestricted: "ENABLED",
  });
  assert.deepEqual(snapshot.capabilities, {
    spotAccount: "UNKNOWN",
    derivativesAccount: "UNKNOWN",
    positionModeSupported: "UNKNOWN",
  });
  assert.equal(snapshot.accountId.startsWith("bybit:"), true);
  assert.equal(snapshot.accountId.includes("91234567"), false);
});

test("maps Bybit withdraw permission only from the explicit Wallet Withdraw value", async (t) => {
  const cases: Array<[string, Record<string, string[] | null>, "ENABLED" | "DISABLED" | "UNKNOWN"]> = [
    ["Wallet includes Withdraw", { Wallet: ["AccountTransfer", "Withdraw"] }, "ENABLED"],
    ["Wallet excludes Withdraw", { Wallet: ["AccountTransfer"] }, "DISABLED"],
    ["Wallet is missing", { Spot: ["SpotTrade"] }, "UNKNOWN"],
    ["Wallet is null", { Wallet: null }, "UNKNOWN"],
  ];
  for (const [name, permissions, expected] of cases) {
    await t.test(name, async () => {
      const provider = new BybitAccountReadProvider({
        readAccountSnapshot: async () => bybitSnapshot({ permissions }),
      });
      assert.equal((await provider.readAccount()).permissions.withdraw, expected);
    });
  }
});

test("uses UNKNOWN when Bybit permission metadata is unavailable", async () => {
  const provider = new BybitAccountReadProvider({
    readAccountSnapshot: async () => bybitSnapshot({ readOnly: null, permissions: null, boundIps: null }),
  });
  const snapshot = await provider.readAccount();
  assert.deepEqual(snapshot.permissions, {
    read: "UNKNOWN",
    spotTrade: "UNKNOWN",
    derivativesTrade: "UNKNOWN",
    withdraw: "UNKNOWN",
    ipRestricted: "UNKNOWN",
  });
});

test("Bybit provider boundary exposes no trading or transfer methods", () => {
  const provider = new BybitAccountReadProvider({ readAccountSnapshot: async () => bybitSnapshot() });
  assert.equal("placeOrder" in provider, false);
  assert.equal("cancelOrder" in provider, false);
  assert.equal("transfer" in provider, false);
  assert.equal("withdraw" in provider, false);
  assert.equal("setLeverage" in provider, false);
});

test("loads isolated Bybit credentials into independent clients and disposes on success", async () => {
  const clients: Array<{ apiKey: string; disposed: boolean }> = [];
  const registry = new AccountReadRegistry({
    loadForAccountRead: async (userId: string, venue: string) => ({
      apiKey: `key-${userId}`,
      apiSecret: `secret-${venue}-${userId}`,
    }),
  } as never, [new BybitAccountReadProviderFactory((secret) => {
    const state = { apiKey: secret.apiKey, disposed: false };
    clients.push(state);
    return {
      readAccountSnapshot: async () => bybitSnapshot({ uid: secret.apiKey }),
      dispose: () => { state.disposed = true; },
    };
  })]);

  const [first, second] = await Promise.all([
    registry.read("user-a", "bybit"),
    registry.read("user-b", "bybit"),
  ]);

  assert.deepEqual(clients.map(({ apiKey }) => apiKey), ["key-user-a", "key-user-b"]);
  assert.ok(clients.every(({ disposed }) => disposed));
  assert.notEqual(first.accountId, second.accountId);
  assert.equal(first.estimatedTotalValueUsdt, null);
  assert.equal(second.valuationCoverage, "UNAVAILABLE");
});

test("disposes the Bybit client when account read fails", async () => {
  let disposed = false;
  const registry = new AccountReadRegistry({
    loadForAccountRead: async () => ({ apiKey: "key", apiSecret: "secret" }),
  } as never, [new BybitAccountReadProviderFactory(() => ({
    readAccountSnapshot: async () => { throw new Error("Bybit failed"); },
    dispose: () => { disposed = true; },
  }))]);

  await assert.rejects(registry.read("user-a", "bybit"), /Bybit failed/u);
  assert.equal(disposed, true);
});

test("missing Bybit credential fails before client creation", async () => {
  let creates = 0;
  const registry = new AccountReadRegistry({
    loadForAccountRead: async () => {
      throw new UserExchangeCredentialStoreError("credential_not_configured", "not configured");
    },
  } as never, [new BybitAccountReadProviderFactory(() => {
    creates += 1;
    return { readAccountSnapshot: async () => bybitSnapshot() };
  })]);

  await assert.rejects(registry.read("user-a", "bybit"), (error: unknown) => (
    error instanceof UserExchangeCredentialStoreError && error.category === "credential_not_configured"
  ));
  assert.equal(creates, 0);
});

function bybitSnapshot(overrides: Partial<BybitAccountReadSnapshot> = {}): BybitAccountReadSnapshot {
  return {
    uid: "91234567",
    unifiedMarginStatus: 5,
    marginMode: "REGULAR_MARGIN",
    readOnly: 1,
    permissions: {
      ContractTrade: ["Order", "Position"],
      Spot: ["SpotTrade"],
      Wallet: ["AccountTransfer"],
      Options: [],
      Derivatives: ["DerivativesTrade"],
    },
    boundIps: ["203.0.113.10"],
    balances: [
      { asset: "USDT", accountType: "unified", total: 120, available: null, locked: 20 },
      { asset: "BTC", accountType: "unified", total: 0.002, available: null, locked: 0.0005 },
    ],
    fetchedAt: 1_800_000_000_000,
    ...overrides,
  };
}
