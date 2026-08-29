import assert from "node:assert/strict";
import test from "node:test";
import { SpotCloseBalanceReadError } from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import { BybitClient, BybitProviderError } from "./BybitClient";
import { BybitSpotCloseBalanceSource } from "./BybitSpotCloseBalanceSource";

const now = 2_000_000_000_000;
const accountId = "bybit:account-a";
const request = Object.freeze({
  accountId, instrumentId: "DOGE-USDT-SPOT", providerSymbol: "DOGEUSDT", baseAsset: "DOGE",
});

test("Bybit final dust refresh performs only one balance Provider read", async () => {
  let identityReads = 0;
  let balanceReads = 0;
  const source = new BybitSpotCloseBalanceSource(credentials(), () => now, () => ({
    getAccountIdentity: async () => {
      identityReads += 1;
      return { accountId, accountFingerprint: "fingerprint", uidHash: "hash" };
    },
    getSpotBalance: async (asset) => {
      balanceReads += 1;
      assert.equal(asset, "DOGE");
      return { totalQuantity: "11", availableQuantity: "10.5" };
    },
  } as Pick<BybitClient, "getAccountIdentity" | "getSpotBalance">));

  assert.deepEqual(await source.readFreshBalance("user-a", request), {
    totalQuantity: "11", availableQuantity: "10.5", checkedAt: now,
  });
  assert.equal(identityReads, 0);
  assert.equal(balanceReads, 1);
});

test("Bybit final dust refresh maps transient, invalid, and auth errors without retry ambiguity", async () => {
  for (const scenario of [
    { provider: "provider_transport_error", expected: "SPOT_BALANCE_UNAVAILABLE", transient: true },
    { provider: "provider_response_invalid", expected: "PROVIDER_RESPONSE_INVALID", transient: false },
    { provider: "credential_validation_failed", expected: "AUTH_OR_PERMISSION_FAILED", transient: false },
  ] as const) {
    const source = new BybitSpotCloseBalanceSource(credentials(), () => now, () => ({
      getAccountIdentity: async () => ({ accountId, accountFingerprint: "fingerprint", uidHash: "hash" }),
      getSpotBalance: async () => { throw new BybitProviderError(scenario.provider, "raw", 10003); },
    } as Pick<BybitClient, "getAccountIdentity" | "getSpotBalance">));
    await assert.rejects(
      () => source.readFreshBalance("user-a", request),
      (error: unknown) => error instanceof SpotCloseBalanceReadError
        && error.category === scenario.expected
        && error.transient === scenario.transient
        && error.providerCode === "10003",
    );
  }
});

function credentials() {
  return {
    findSummary: (userId: string, venue: string) => userId === "user-a" && venue === "bybit" ? {
      userId, venue: "bybit" as const, accountId, accountFingerprint: "fingerprint", maskedApiKey: "***",
      environment: "production" as const, permissions: { providerVerified: true }, lastVerifiedAt: now,
      createdAt: now, updatedAt: now,
    } : null,
    loadForExecution: async () => ({ apiKey: "key", apiSecret: "secret" }),
  };
}
