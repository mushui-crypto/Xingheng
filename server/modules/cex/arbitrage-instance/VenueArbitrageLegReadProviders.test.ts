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
      positionMode: "ONE_WAY",
      side: "SHORT",
      quantity: "1",
      signedNetQuantity: "-1",
      longQuantity: "0",
      shortQuantity: "1",
      fetchedAt: 1_800_000_000_000,
    },
  });
});

test("spot provider uses the provider-reported total balance as the authoritative quantity", async () => {
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
      positionMode: "ONE_WAY",
      side: "LONG",
      quantity: "0.5",
      signedNetQuantity: "0.5",
      longQuantity: "0.5",
      shortQuantity: "0",
      fetchedAt: 1_800_000_000_000,
    },
    availableQuantity: "0.4",
  });
  assert.equal(positionReads, 0);
});

test("spot provider reports FLAT when the provider balance is zero instead of echoing managed quantity", async () => {
  const provider = new VenueArbitrageLegReadProvider(
    "binance",
    { readAccountSnapshot: async () => ({}), readPerpetualPosition: async () => { throw new Error("not expected"); } },
    accountReader("binance:account-a", []),
    { resolve: async () => ({ providerSymbol: "XAUTUSDT", contractSize: "1" }) },
  );

  const result = await provider.readLeg(leg({
    venue: "binance", role: "LONG", instrumentId: "XAUT-USDT-SPOT", plannedQuantity: "1", confirmedOpenedQuantity: "1",
  }));

  assert.equal(result.snapshot.quantity, "0");
  assert.equal(result.snapshot.side, "FLAT");
  assert.equal(result.availableQuantity, "0");
});

test("one provider context coalesces the account-wide snapshot across same-account legs", async () => {
  let accountReads = 0;
  let positionReads = 0;
  const reader = accountReader("binance:account-a", [
    { asset: "XAUT", accountType: "unified", total: 1, available: 1, locked: 0 },
  ]);
  const provider = new VenueArbitrageLegReadProvider(
    "binance",
    {
      readAccountSnapshot: async () => ({}),
      readPerpetualPosition: async () => {
        positionReads += 1;
        return { symbol: "XAUTUSDT", side: "short", baseQuantity: "1", updatedAt: 1_800_000_000_000 };
      },
    },
    {
      readAccount: async () => { accountReads += 1; return reader.readAccount(); },
      dispose: reader.dispose,
    },
    { resolve: async () => ({ providerSymbol: "XAUTUSDT", contractSize: "1" }) },
  );

  await Promise.all([
    provider.readLeg(leg({ legId: "spot", instrumentId: "XAUT-USDT-SPOT" })),
    provider.readLeg(leg({ legId: "perp", role: "SHORT", instrumentId: "XAUT-USDT-PERP" })),
  ]);

  assert.equal(accountReads, 1);
  assert.equal(positionReads, 1);
});

test("one provider context coalesces same-instrument mode facts while preserving leg position reads", async () => {
  let accountReads = 0;
  let modeReads = 0;
  let positionReads = 0;
  const reader = accountReader("binance:account-a", []);
  const provider = new VenueArbitrageLegReadProvider(
    "binance",
    { readAccountSnapshot: async () => ({}), readPerpetualPosition: async () => { throw new Error("not used"); } },
    {
      readAccount: async () => { accountReads += 1; return reader.readAccount(); },
      dispose: reader.dispose,
    },
    { resolve: async () => ({ providerSymbol: "XAUTUSDT", contractSize: "1" }) },
    {
      venue: "binance",
      readPosition: async (request) => {
        positionReads += 1;
        return {
          venue: "binance",
          accountId: request.accountId,
          instrumentId: request.instrumentId,
          positionMode: "HEDGE",
          side: "FLAT",
          quantity: "0",
          signedNetQuantity: null,
          longQuantity: "1",
          shortQuantity: "1",
          fetchedAt: 1_800_000_000_000,
        };
      },
    },
    {
      read: async () => { modeReads += 1; return { positionMode: "HEDGE" as const }; },
    },
  );

  await Promise.all([
    provider.readLeg(leg({ legId: "long", role: "LONG" })),
    provider.readLeg(leg({ legId: "short", role: "SHORT" })),
  ]);

  assert.equal(accountReads, 1);
  assert.equal(modeReads, 1);
  assert.equal(positionReads, 2);
});

test("Binance perpetual verification uses narrow identity, mode, and symbol position without an account-wide snapshot", async () => {
  let accountReads = 0;
  const provider = new VenueArbitrageLegReadProvider(
    "binance",
    {
      readAccountSnapshot: async () => { throw new Error("broad account read must not run"); },
      readAccountIdentity: async () => ({ accountId: "binance:account-a" }),
      readPerpetualPosition: async () => { throw new Error("positionReader owns this read"); },
    },
    {
      readAccount: async () => { accountReads += 1; throw new Error("broad account read must not run"); },
      dispose: () => undefined,
    },
    { resolve: async () => ({ providerSymbol: "XAUTUSDT", contractSize: "1" }) },
    {
      venue: "binance",
      readPosition: async (request) => ({
        venue: "binance", accountId: request.accountId, instrumentId: request.instrumentId,
        positionMode: "ONE_WAY", side: "SHORT", quantity: "1", signedNetQuantity: "-1",
        longQuantity: "0", shortQuantity: "1", fetchedAt: 1_800_000_000_000,
      }),
    },
    { read: async () => ({ positionMode: "ONE_WAY" as const }) },
  );

  const observed = await provider.readLeg(leg({ role: "SHORT" }));
  assert.equal(observed.snapshot.signedNetQuantity, "-1");
  assert.equal(accountReads, 0);
});

test("provider rejects mismatched account identity and spot short inference", async () => {
  const provider = new VenueArbitrageLegReadProvider(
    "bitget",
    { readAccountSnapshot: async () => ({}), readPerpetualPosition: async () => { throw new Error("not expected"); } },
    accountReader("bitget:other", []),
    { resolve: async () => ({ providerSymbol: "XAUTUSDT", contractSize: "1" }) },
  );
  await assert.rejects(provider.readLeg(leg({ venue: "bitget", accountId: "bitget:account-a" })), /account does not match/u);
  await assert.rejects(provider.readLeg(leg({
    venue: "bitget", accountId: "bitget:credential-only:0123456789abcdef0123",
  })), /account does not match/u);

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
