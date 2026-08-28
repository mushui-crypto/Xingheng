import assert from "node:assert/strict";
import test from "node:test";
import { OkxSpotCloseBalanceSource } from "./OkxSpotCloseBalanceSource";

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
  });
  assert.equal(identityReads, 1);
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
