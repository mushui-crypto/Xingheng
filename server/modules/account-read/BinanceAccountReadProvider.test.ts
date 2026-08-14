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
  assert.ok(snapshot.balances.every((balance) => typeof balance.available === "number"));
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
  assert.deepEqual(snapshot.allSymbolReadStatus, {
    futuresPositions: { status: "success", fullScan: true },
    spotOpenOrders: { status: "success", fullScan: true },
    futuresOpenOrders: { status: "success", fullScan: true },
  });
  assert.equal(snapshot.futuresPositions[0]?.positionAmt, "-0.000000000000000001");
  assert.equal(snapshot.spotOpenOrders[0]?.symbol, "BTCUSDT");
  assert.equal(snapshot.futuresOpenOrders[0]?.reduceOnly, true);
  assert.equal(snapshot.instrumentSettings[0]?.status, "READABLE");
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
    allSymbolReadStatus: {
      futuresPositions: { status: "success" as const, fullScan: true as const },
      spotOpenOrders: { status: "success" as const, fullScan: true as const },
      futuresOpenOrders: { status: "success" as const, fullScan: true as const },
    },
    futuresPositions: [{
      symbol: "BTCUSDT",
      positionSide: "BOTH" as const,
      positionAmt: "-0.000000000000000001",
      entryPrice: "100000.000000000000000001",
      leverage: "2",
      marginType: "cross" as const,
    }],
    spotOpenOrders: [{
      symbol: "BTCUSDT", side: "BUY" as const, orderId: "1", clientOrderId: "spot-read",
      status: "NEW", originalQuantity: "0.000000000000000001", executedQuantity: "0",
    }],
    futuresOpenOrders: [{
      symbol: "DOGEUSDT", side: "SELL" as const, orderId: "2", clientOrderId: "futures-read",
      status: "PARTIALLY_FILLED", originalQuantity: "1.000000000000000001",
      executedQuantity: "0.000000000000000001", reduceOnly: true,
    }],
    instrumentSettings: [{
      symbol: "BTCUSDT" as const, status: "READABLE" as const, leverage: "2", marginMode: "cross" as const,
    }],
  };
}
