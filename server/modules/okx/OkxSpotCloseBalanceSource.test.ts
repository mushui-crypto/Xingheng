import assert from "node:assert/strict";
import test from "node:test";
import { OkxSpotCloseBalanceSource } from "./OkxSpotCloseBalanceSource";
import { OkxProviderError } from "./OkxClient";
import { SpotCloseBalanceReadError } from "../arbitrage-execution/BinanceSpotCloseBalanceSource";

const now = 2_000_000_000_000;
const accountId = "okx:account-a";

test("OKX Spot close reads identity plus one narrow total/available balance snapshot", async () => {
  let identityReads = 0;
  let balanceReads = 0;
  const source = new OkxSpotCloseBalanceSource(credentials(), () => now, () => ({
    getAccountIdentity: async () => {
      identityReads += 1;
      return { accountId, accountFingerprint: "fingerprint", accountLevel: "3", uidHash: "uid-hash" };
    },
    getSpotBalance: async (asset) => {
      balanceReads += 1;
      assert.equal(asset, "DOGE");
      return { totalQuantity: "12.300001", availableQuantity: "12.2" };
    },
  }));

  const result = await source.readAvailableBalance("user-a", {
    accountId,
    instrumentId: "DOGE-USDT-SPOT",
    providerSymbol: "DOGE-USDT",
    baseAsset: "DOGE",
  });

  assert.deepEqual(result, {
    totalQuantity: "12.300001",
    availableQuantity: "12.2",
    checkedAt: now,
    verifiedAccountId: accountId,
  });
  assert.equal(identityReads, 1);
  assert.equal(balanceReads, 1);
});

test("OKX final dust refresh reads only total/available balance after verified identity context", async () => {
  let identityReads = 0;
  let balanceReads = 0;
  const source = new OkxSpotCloseBalanceSource(credentials(), () => now, () => ({
    getAccountIdentity: async () => {
      identityReads += 1;
      return { accountId, accountFingerprint: "fingerprint", accountLevel: "3", uidHash: "uid-hash" };
    },
    getSpotBalance: async () => {
      balanceReads += 1;
      return { totalQuantity: "0.000001369", availableQuantity: "0.000001369" };
    },
  }));
  assert.deepEqual(await source.readFreshBalance("user-a", {
    accountId, instrumentId: "DOGE-USDT-SPOT", providerSymbol: "DOGE-USDT", baseAsset: "DOGE",
  }), {
    totalQuantity: "0.000001369", availableQuantity: "0.000001369", checkedAt: now,
  });
  assert.equal(identityReads, 0);
  assert.equal(balanceReads, 1);
});

test("OKX Spot close fails closed on account or instrument identity mismatch", async () => {
  const source = new OkxSpotCloseBalanceSource(credentials(), () => now, () => ({
    getAccountIdentity: async () => ({
      accountId: "okx:other-account", accountFingerprint: "other", accountLevel: "3", uidHash: "other-hash",
    }),
    getSpotBalance: async () => ({ totalQuantity: "12", availableQuantity: "12" }),
  }));

  await assert.rejects(
    () => source.readAvailableBalance("user-a", {
      accountId, instrumentId: "DOGE-USDT-SPOT", providerSymbol: "DOGE-USDT", baseAsset: "DOGE",
    }),
    /Provider identity/u,
  );
  await assert.rejects(
    () => new OkxSpotCloseBalanceSource(credentials(), () => now, () => ({
      getAccountIdentity: async () => ({ accountId, accountFingerprint: "fingerprint", accountLevel: "3", uidHash: "hash" }),
      getSpotBalance: async () => ({ totalQuantity: "12", availableQuantity: "12" }),
    })).readAvailableBalance("user-a", {
      accountId, instrumentId: "DOGE-USDT-SPOT", providerSymbol: "DOGE-USDC", baseAsset: "DOGE",
    }),
    /instrument identity/u,
  );
});

test("OKX final balance refresh classifies transient, invalid, and authorization failures without raw details", async () => {
  for (const scenario of [
    { provider: "provider_timeout", expected: "SPOT_BALANCE_UNAVAILABLE", transient: true },
    { provider: "provider_response_invalid", expected: "PROVIDER_RESPONSE_INVALID", transient: false },
    { provider: "credential_validation_failed", expected: "AUTH_OR_PERMISSION_FAILED", transient: false },
  ] as const) {
    const source = new OkxSpotCloseBalanceSource(credentials(), () => now, () => ({
      getAccountIdentity: async () => ({ accountId, accountFingerprint: "fingerprint", accountLevel: "3", uidHash: "hash" }),
      getSpotBalance: async () => {
        throw new OkxProviderError(scenario.provider, "raw provider detail must not escape", "50011");
      },
    }));
    await assert.rejects(
      () => source.readFreshBalance("user-a", {
        accountId, instrumentId: "DOGE-USDT-SPOT", providerSymbol: "DOGE-USDT", baseAsset: "DOGE",
      }),
      (error: unknown) => error instanceof SpotCloseBalanceReadError
        && error.category === scenario.expected
        && error.transient === scenario.transient
        && error.providerCode === "50011"
        && !error.message.includes("raw provider detail"),
    );
  }
});

function credentials() {
  return {
    findSummary: (userId: string, venue: string) => userId === "user-a" && venue === "okx" ? {
      userId,
      venue: "okx" as const,
      accountId,
      accountFingerprint: "fingerprint",
      maskedApiKey: "***",
      environment: "production" as const,
      permissions: { providerVerified: true },
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    } : null,
    loadForExecution: async () => ({ apiKey: "key", apiSecret: "secret", passphrase: "passphrase" }),
  };
}
