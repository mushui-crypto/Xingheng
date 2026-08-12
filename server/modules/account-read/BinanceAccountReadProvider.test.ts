import assert from "node:assert/strict";
import test from "node:test";
import { BinanceAccountReadProvider, BinanceAccountReadProviderFactory } from "./BinanceAccountReadProvider";

test("maps the Binance read-only snapshot without inventing permissions or valuations", async () => {
  const provider = new BinanceAccountReadProvider({
    readAccountSnapshot: async () => binanceSnapshot(),
  });

  const snapshot = await provider.readAccount();

  assert.equal(snapshot.venue, "binance");
  assert.equal(snapshot.accountId, "binance:fixture");
  assert.equal(snapshot.uidHash, "uid-hash");
  assert.deepEqual(snapshot.accountTypes, ["spot", "derivatives"]);
  assert.deepEqual(snapshot.balances, [
    { asset: "BTC", accountType: "spot", total: 0.002, available: 0.001, locked: 0.001 },
    { asset: "USDT", accountType: "derivatives", total: 120, available: 100, locked: null },
  ]);
  assert.deepEqual(snapshot.permissions, {
    read: "ENABLED",
    spotTrade: "ENABLED",
    derivativesTrade: "DISABLED",
    withdraw: "DISABLED",
    ipRestricted: "ENABLED",
  });
  assert.deepEqual(snapshot.capabilities, {
    spotAccount: "UNKNOWN",
    derivativesAccount: "UNKNOWN",
    positionModeSupported: "ENABLED",
  });
});

test("provider boundary exposes only venue, account read, and disposal", () => {
  const provider = new BinanceAccountReadProvider({ readAccountSnapshot: async () => binanceSnapshot() });
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.getPrototypeOf(provider)).sort(),
    ["constructor", "dispose", "readAccount"],
  );
  for (const forbidden of ["placeOrder", "cancelOrder", "transfer", "withdraw", "setLeverage"]) {
    assert.equal(forbidden in provider, false, forbidden);
  }
});

test("factory creates a new authenticated client for every provider", () => {
  const secrets: string[] = [];
  const factory = new BinanceAccountReadProviderFactory((secret) => {
    secrets.push(secret.apiKey);
    return { readAccountSnapshot: async () => binanceSnapshot() };
  });

  const first = factory.create({ apiKey: "user-a", apiSecret: "secret-a" });
  const second = factory.create({ apiKey: "user-b", apiSecret: "secret-b" });

  assert.notEqual(first, second);
  assert.deepEqual(secrets, ["user-a", "user-b"]);
});

function binanceSnapshot() {
  return {
    accountId: "binance:fixture",
    accountFingerprint: "fixture",
    uidSnapshot: "uid-hash",
    accountMode: "single_asset_one_way" as const,
    fetchedAt: 1_800_000_000_000,
    permissions: {
      read: true,
      spotTrade: true,
      contractTrade: false,
      withdraw: false,
      ipRestricted: true,
      spotAccount: true,
      futuresAccount: true,
      positionModeSupported: true,
    },
    balances: [
      { asset: "BTC", accountType: "spot" as const, total: 0.002, available: 0.001, locked: 0.001 },
      { asset: "USDT", accountType: "derivatives" as const, total: 120, available: 100, locked: null },
    ],
  };
}
