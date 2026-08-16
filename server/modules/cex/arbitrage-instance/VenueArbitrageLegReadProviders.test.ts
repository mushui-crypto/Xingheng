import assert from "node:assert/strict";
import test from "node:test";
import type { VenueAccountReadSnapshot } from "../../account-read/AccountReadTypes";
import { VenueArbitrageLegReadProvider } from "./VenueArbitrageLegReadProviders";
import type { ArbitrageInstanceLeg } from "./ArbitrageInstance";

test("perpetual provider preserves direction and converts OKX contracts to base quantity", async () => {
  const provider = new VenueArbitrageLegReadProvider(
    "okx",
    {
      readAccountSnapshot: async () => ({}),
      readPerpetualPosition: async () => ({
        instId: "XAUT-USDT-SWAP",
        side: "short",
        contractQuantity: "10",
        updatedAt: 1_800_000_000_000,
      }),
    },
    accountReader("okx:account-a", []),
    { resolve: async () => ({ providerSymbol: "XAUT-USDT-SWAP", contractSize: "0.1" }) },
  );

  assert.deepEqual(await provider.readLeg(leg({
    venue: "okx", role: "SHORT", accountId: "okx:account-a",
  })), {
    snapshot: {
      venue: "okx",
      accountId: "okx:account-a",
      instrumentId: "XAUT-USDT-PERP",
      side: "SHORT",
      quantity: "1",
      fetchedAt: 1_800_000_000_000,
    },
  });
});

test("spot provider keeps instance quantity authoritative and uses account balance only for availability", async () => {
  let positionReads = 0;
  const provider = new VenueArbitrageLegReadProvider(
    "bybit",
    {
      readAccountSnapshot: async () => ({}),
      readPerpetualPosition: async () => {
        positionReads += 1;
        throw new Error("not expected");
      },
    },
    accountReader("bybit:account-a", [
      { asset: "XAUT", accountType: "unified", total: 0.5, available: 0.4, locked: 0.1 },
    ]),
    { resolve: async () => ({ providerSymbol: "XAUTUSDT", contractSize: "1" }) },
  );

  assert.deepEqual(await provider.readLeg(leg({
    venue: "bybit", role: "LONG", instrumentId: "XAUT-USDT-SPOT", accountId: "bybit:account-a",
  })), {
    snapshot: {
      venue: "bybit",
      accountId: "bybit:account-a",
      instrumentId: "XAUT-USDT-SPOT",
      side: "LONG",
      quantity: "1",
      fetchedAt: 1_800_000_000_000,
    },
    availableQuantity: "0.4",
  });
  assert.equal(positionReads, 0);
});

test("provider rejects mismatched account identity and spot short inference", async () => {
  const provider = new VenueArbitrageLegReadProvider(
    "bitget",
    { readAccountSnapshot: async () => ({}), readPerpetualPosition: async () => { throw new Error("not expected"); } },
    accountReader("bitget:other", []),
    { resolve: async () => ({ providerSymbol: "XAUTUSDT", contractSize: "1" }) },
  );
  await assert.rejects(provider.readLeg(leg({ venue: "bitget", accountId: "bitget:account-a" })), /account does not match/u);

  const spotShort = new VenueArbitrageLegReadProvider(
    "binance",
    { readAccountSnapshot: async () => ({}), readPerpetualPosition: async () => { throw new Error("not expected"); } },
    accountReader("binance:account-a", []),
    { resolve: async () => ({ providerSymbol: "XAUTUSDT", contractSize: "1" }) },
  );
  await assert.rejects(spotShort.readLeg(leg({
    venue: "binance", role: "SHORT", instrumentId: "XAUT-USDT-SPOT",
  })), /Spot short/u);
});

function accountReader(accountId: string, balances: VenueAccountReadSnapshot["balances"]) {
  return {
    readAccount: async (): Promise<VenueAccountReadSnapshot> => ({
      venue: accountId.split(":")[0] as VenueAccountReadSnapshot["venue"],
      accountId,
      accountFingerprint: "fingerprint",
      uidHash: "hash",
      accountTypes: ["unified"],
      accountMode: "unified",
      connection: { status: "connected", checkedAt: 1_800_000_000_000 },
      credentialValidation: { status: "validated", checkedAt: 1_800_000_000_000 },
      balances,
      permissions: { read: "ENABLED", spotTrade: "UNKNOWN", derivativesTrade: "UNKNOWN", withdraw: "UNKNOWN", ipRestricted: "UNKNOWN" },
      capabilities: { spotAccount: "UNKNOWN", derivativesAccount: "UNKNOWN", positionModeSupported: "UNKNOWN" },
      latestSyncAt: 1_800_000_000_000,
    }),
    dispose: () => undefined,
  };
}

function leg(overrides: Partial<ArbitrageInstanceLeg> = {}): ArbitrageInstanceLeg {
  return {
    legId: "leg-1",
    role: "LONG",
    venue: "binance",
    accountId: "binance:account-a",
    instrumentId: "XAUT-USDT-PERP",
    plannedQuantity: "1",
    confirmedOpenedQuantity: "1",
    confirmedClosedQuantity: "0",
    ...overrides,
  };
}
