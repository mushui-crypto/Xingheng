import assert from "node:assert/strict";
import test from "node:test";
import type { BitgetAccountReadSnapshot } from "../bitget/BitgetAccountReadClient";
import { UserExchangeCredentialStoreError } from "../credentials/UserExchangeCredentialStore";
import { AccountReadRegistry } from "./AccountReadRegistry";
import { BitgetAccountReadProvider, BitgetAccountReadProviderFactory } from "./BitgetAccountReadProvider";

test("maps Bitget unified and transitional account modes without guessing", async (t) => {
  for (const [mode, expectedType, expectedMode] of [
    ["unified", "unified", "unified:advanced:multi_assets"],
    ["hybrid", "unified", "hybrid:advanced:multi_assets"],
    ["upgrading", "unknown", "upgrading:advanced:multi_assets"],
    ["switching", "unknown", "switching:advanced:multi_assets"],
    ["unexpected", "unknown", "unexpected:advanced:multi_assets"],
  ] as const) {
    await t.test(mode, async () => {
      const provider = new BitgetAccountReadProvider({
        readAccountSnapshot: async () => bitgetSnapshot({ accountMode: mode }),
      });
      const snapshot = await provider.readAccount();
      assert.deepEqual(snapshot.accountTypes, [expectedType]);
      assert.equal(snapshot.accountMode, expectedMode);
      assert.ok(snapshot.balances.every((balance) => balance.accountType === expectedType));
    });
  }
});

test("maps Bitget UTA trade permission and execution eligibility without guessing", async () => {
  const provider = new BitgetAccountReadProvider({ readAccountSnapshot: async () => bitgetSnapshot() });
  const snapshot = await provider.readAccount();

  assert.deepEqual(snapshot.permissions, {
    read: "ENABLED",
    spotTrade: "ENABLED",
    derivativesTrade: "ENABLED",
    withdraw: "DISABLED",
    ipRestricted: "ENABLED",
  });
  assert.deepEqual(snapshot.capabilities, {
    spotAccount: "ENABLED",
    derivativesAccount: "ENABLED",
    positionModeSupported: "ENABLED",
  });
  assert.equal(snapshot.accountId.startsWith("bitget:"), true);
  assert.equal(snapshot.accountId.includes("8123456789"), false);
});

test("reads requested Bitget perpetual long and short positions without hardcoding a symbol", async () => {
  const calls: Array<[string, string | undefined]> = [];
  const provider = new BitgetAccountReadProvider({
    readAccountSnapshot: async () => bitgetSnapshot({ holdMode: "hedge_mode" }),
    readPerpetualPosition: async (symbol, side) => {
      calls.push([symbol, side]);
      return { symbol, side: side!, baseQuantity: side === "long" ? "2" : "3", updatedAt: 1_800_000_000_000 };
    },
  });

  const snapshot = await provider.readAccount({ positionSymbol: "BTCUSDT" });
  assert.deepEqual(snapshot.perpetualPositions, {
    symbol: "BTCUSDT",
    holdMode: "hedge_mode",
    long: { side: "long", baseQuantity: "2", updatedAt: 1_800_000_000_000 },
    short: { side: "short", baseQuantity: "3", updatedAt: 1_800_000_000_000 },
  });
  assert.deepEqual(calls, [["BTCUSDT", "long"], ["BTCUSDT", "short"]]);
});

test("maps Bitget withdraw permission from the explicit permissions array", async (t) => {
  const cases: Array<[string, string[] | null, "ENABLED" | "DISABLED" | "UNKNOWN"]> = [
    ["included", ["uta_mgt", "withdraw"], "ENABLED"],
    ["not included", ["uta_mgt", "uta_trade"], "DISABLED"],
    ["missing", null, "UNKNOWN"],
  ];
  for (const [name, permissions, expected] of cases) {
    await t.test(name, async () => {
      const provider = new BitgetAccountReadProvider({
        readAccountSnapshot: async () => bitgetSnapshot({ permissions }),
      });
      assert.equal((await provider.readAccount()).permissions.withdraw, expected);
    });
  }
});

test("maps Bitget IP restriction from the explicit ips field", async (t) => {
  const cases: Array<[string, string | null, "ENABLED" | "DISABLED" | "UNKNOWN"]> = [
    ["nonempty", "192.0.2.10,192.0.2.11", "ENABLED"],
    ["empty", "", "DISABLED"],
    ["missing", null, "UNKNOWN"],
  ];
  for (const [name, boundIps, expected] of cases) {
    await t.test(name, async () => {
      const provider = new BitgetAccountReadProvider({
        readAccountSnapshot: async () => bitgetSnapshot({ boundIps }),
      });
      assert.equal((await provider.readAccount()).permissions.ipRestricted, expected);
    });
  }
});

test("maps Bitget read permission conservatively from permType", async (t) => {
  const cases: Array<[string, string | null, "ENABLED" | "UNKNOWN"]> = [
    ["read-only", "read-only", "ENABLED"],
    ["read-and-write", "read-and-write", "ENABLED"],
    ["unrecognized", "unexpected", "UNKNOWN"],
    ["missing", null, "UNKNOWN"],
  ];
  for (const [name, permType, expected] of cases) {
    await t.test(name, async () => {
      const provider = new BitgetAccountReadProvider({
        readAccountSnapshot: async () => bitgetSnapshot({ permType }),
      });
      assert.equal((await provider.readAccount()).permissions.read, expected);
    });
  }
});

test("Bitget provider boundary exposes no trading or transfer methods", () => {
  const provider = new BitgetAccountReadProvider({ readAccountSnapshot: async () => bitgetSnapshot() });
  for (const forbidden of ["placeOrder", "cancelOrder", "transfer", "withdraw", "setLeverage"]) {
    assert.equal(forbidden in provider, false, forbidden);
  }
});

test("loads isolated Bitget credentials into independent clients and disposes on success", async () => {
  const clients: Array<{ apiKey: string; disposed: boolean }> = [];
  const registry = new AccountReadRegistry({
    loadForAccountRead: async (userId: string, venue: string) => ({
      apiKey: `key-${userId}`,
      apiSecret: `secret-${userId}`,
      passphrase: `passphrase-${venue}-${userId}`,
    }),
  } as never, [new BitgetAccountReadProviderFactory((secret) => {
    const state = { apiKey: secret.apiKey, disposed: false };
    clients.push(state);
    return {
      readAccountSnapshot: async () => bitgetSnapshot({ uid: secret.apiKey }),
      dispose: () => { state.disposed = true; },
    };
  })]);

  const [first, second] = await Promise.all([
    registry.read("user-a", "bitget"),
    registry.read("user-b", "bitget"),
  ]);

  assert.deepEqual(clients.map(({ apiKey }) => apiKey), ["key-user-a", "key-user-b"]);
  assert.ok(clients.every(({ disposed }) => disposed));
  assert.notEqual(first.accountId, second.accountId);
  assert.equal(first.estimatedTotalValueUsdt, null);
  assert.equal(second.valuationCoverage, "UNAVAILABLE");
});

test("default Bitget factory rejects a credential without passphrase", () => {
  const factory = new BitgetAccountReadProviderFactory();
  assert.throws(
    () => factory.create({ apiKey: "key", apiSecret: "secret" }),
    /requires a credential passphrase/u,
  );
});

test("disposes the Bitget client when account read fails", async () => {
  let disposed = false;
  const registry = new AccountReadRegistry({
    loadForAccountRead: async () => ({ apiKey: "key", apiSecret: "secret", passphrase: "passphrase" }),
  } as never, [new BitgetAccountReadProviderFactory(() => ({
    readAccountSnapshot: async () => { throw new Error("Bitget failed"); },
    dispose: () => { disposed = true; },
  }))]);

  await assert.rejects(registry.read("user-a", "bitget"), /Bitget failed/u);
  assert.equal(disposed, true);
});

test("missing Bitget credential fails before client creation", async () => {
  let creates = 0;
  const registry = new AccountReadRegistry({
    loadForAccountRead: async () => {
      throw new UserExchangeCredentialStoreError("credential_not_configured", "not configured");
    },
  } as never, [new BitgetAccountReadProviderFactory(() => {
    creates += 1;
    return { readAccountSnapshot: async () => bitgetSnapshot() };
  })]);

  await assert.rejects(registry.read("user-a", "bitget"), (error: unknown) => (
    error instanceof UserExchangeCredentialStoreError && error.category === "credential_not_configured"
  ));
  assert.equal(creates, 0);
});

function bitgetSnapshot(overrides: Partial<BitgetAccountReadSnapshot> = {}): BitgetAccountReadSnapshot {
  return {
    uid: "8123456789",
    accountMode: "hybrid",
    assetMode: "multi_assets",
    accountLevel: "advanced",
    holdMode: "one_way_mode",
    permType: "read-and-write",
    permissions: ["uta_mgt", "uta_trade"],
    boundIps: "192.0.2.10",
    balances: [
      { asset: "USDT", total: 120, available: 100, locked: 20 },
      { asset: "BTC", total: 0.002, available: null, locked: 0.0005 },
    ],
    fetchedAt: 1_800_000_000_000,
    ...overrides,
  };
}
