import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { SpotCloseBalanceReadError } from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import { BitgetClient, BitgetProviderError } from "./BitgetClient";
import { createBitgetExecutionOrderReference } from "./BitgetExecutionOrderReferenceStore";
import { BitgetPositionReader } from "./BitgetPositionReader";
import { BitgetSpotCloseBalanceSource } from "./BitgetSpotCloseBalanceSource";
import { BitgetSpotOpeningAttributionSource } from "./BitgetSpotOpeningAttributionSource";
import type { BitgetProviderOrder } from "./BitgetTypes";

const now = 2_000_000_000_000;
const uid = "99887766";
const accountId = `bitget:${createHash("sha256").update(`bitget:${uid}`).digest("hex").slice(0, 16)}` as `bitget:${string}`;

test("Bitget Spot available balance is an exact Decimal GET and never a Number", async () => {
  const requests: URL[] = [];
  const client = new BitgetClient(credential, {
    now: () => now,
    fetchImpl: async (input) => {
      requests.push(new URL(String(input)));
      return response({ data: { assets: [
        { coin: "DOGE", available: "94.90500000" },
        { coin: "USDT", available: "8.1" },
      ] } });
    },
  });
  assert.equal(await client.getSpotAvailableBalance("DOGE"), "94.905");
  assert.equal(requests[0]?.pathname, "/api/v3/account/assets");
});

test("Bitget position verification preserves canonical base quantity and enforces identity plus one-way mode", async () => {
  const reader = new BitgetPositionReader({
    readAccountSnapshot: async () => accountSnapshot(),
    readPerpetualPosition: async (symbol, expectedSide) => {
      assert.equal(symbol, "DOGEUSDT");
      assert.equal(expectedSide, "short");
      return { symbol, side: "short", baseQuantity: "95.000", updatedAt: now };
    },
  }, { resolve: async () => ({ symbol: "DOGEUSDT", contractSize: "1" }) });

  const position = await reader.readPosition({ accountId, instrumentId: "DOGE-USDT-PERP", expectedSide: "SHORT" });
  assert.equal(position.side, "SHORT");
  assert.equal(position.quantity, "95");

  await assert.rejects(
    () => reader.readPosition({ accountId: "bitget:wrong", instrumentId: "DOGE-USDT-PERP" }),
    /account identity/u,
  );
  const hedge = new BitgetPositionReader({
    readAccountSnapshot: async () => accountSnapshot({ holdMode: "hedge_mode" }),
    readPerpetualPosition: async () => ({ symbol: "DOGEUSDT", side: "flat", baseQuantity: "0", updatedAt: now }),
  }, { resolve: () => ({ symbol: "DOGEUSDT", contractSize: "1" }) });
  await assert.rejects(
    () => hedge.readPosition({ accountId, instrumentId: "DOGE-USDT-PERP" }),
    /one-way/u,
  );
});

test("Bitget Spot opening attribution subtracts only authoritative base fee and excludes unrelated dust", async () => {
  const gross = "95";
  const source = attributionSource(providerOrder({ fee: "0.095", feeCurrency: "DOGE" }));
  assert.equal(await source.readAttributableBaseQuantity("user-a", attributionRequest(gross)), "94.905");

  const quoteFee = attributionSource(providerOrder({ fee: "0.008", feeCurrency: "USDT" }));
  assert.equal(await quoteFee.readAttributableBaseQuantity("user-a", attributionRequest(gross)), gross);
});

test("Bitget Spot close balance source is user/account/provider scoped", async () => {
  let identityReads = 0;
  let balanceReads = 0;
  const source = new BitgetSpotCloseBalanceSource(credentialStore(), () => now, () => ({
    getAccountIdentity: async () => {
      identityReads += 1;
      return { accountId, accountFingerprint: "fingerprint", uidHash: "hash" };
    },
    getSpotBalance: async (asset) => {
      balanceReads += 1;
      assert.equal(asset, "DOGE");
      return { totalQuantity: "95", availableQuantity: "94.905" };
    },
  }));
  const result = await source.readAvailableBalance("user-a", {
    accountId, instrumentId: "DOGE-USDT-SPOT", providerSymbol: "DOGEUSDT", baseAsset: "DOGE",
  });
  assert.deepEqual(result, {
    totalQuantity: "95", availableQuantity: "94.905", checkedAt: now, verifiedAccountId: accountId,
  });
  assert.deepEqual(await source.readFreshBalance("user-a", {
    accountId, instrumentId: "DOGE-USDT-SPOT", providerSymbol: "DOGEUSDT", baseAsset: "DOGE",
  }), { totalQuantity: "95", availableQuantity: "94.905", checkedAt: now });
  assert.equal(identityReads, 1);
  assert.equal(balanceReads, 2);
  await assert.rejects(
    () => source.readAvailableBalance("user-b", {
      accountId, instrumentId: "DOGE-USDT-SPOT", providerSymbol: "DOGEUSDT", baseAsset: "DOGE",
    }),
    /authenticated/u,
  );
});

test("Bitget final dust refresh maps transient, invalid, and auth errors", async () => {
  for (const scenario of [
    { provider: "provider_transport_error", expected: "SPOT_BALANCE_UNAVAILABLE", transient: true },
    { provider: "provider_response_invalid", expected: "PROVIDER_RESPONSE_INVALID", transient: false },
    { provider: "credential_validation_failed", expected: "AUTH_OR_PERMISSION_FAILED", transient: false },
  ] as const) {
    const source = new BitgetSpotCloseBalanceSource(credentialStore(), () => now, () => ({
      getAccountIdentity: async () => ({ accountId, accountFingerprint: "fingerprint", uidHash: "hash" }),
      getSpotBalance: async () => { throw new BitgetProviderError(scenario.provider, "raw", "40001"); },
    }));
    await assert.rejects(
      () => source.readFreshBalance("user-a", {
        accountId, instrumentId: "DOGE-USDT-SPOT", providerSymbol: "DOGEUSDT", baseAsset: "DOGE",
      }),
      (error: unknown) => error instanceof SpotCloseBalanceReadError
        && error.category === scenario.expected
        && error.transient === scenario.transient
        && error.providerCode === "40001",
    );
  }
});

function attributionSource(order: BitgetProviderOrder) {
  const record = createExecutionRecord({
    executionId: "execution-spot", intentId: "intent-spot", userId: "user-a", venue: "bitget",
    accountId, instrumentId: "DOGE-USDT-SPOT", status: "CONFIRMED", remoteOrderId: "9001",
    createdAt: now, updatedAt: now + 1,
  });
  const reference = createBitgetExecutionOrderReference({
    executionId: record.executionId, intentId: record.intentId, userId: record.userId, accountId,
    instrumentId: record.instrumentId, category: "SPOT", symbol: "DOGEUSDT", orderId: "9001",
    clientOid: "sxbgopening", expectedProviderQuantity: "95", expectedSide: "buy",
    createdAt: now, updatedAt: now + 1,
  });
  return new BitgetSpotOpeningAttributionSource(
    { loadForUser: async () => record }, credentialStore(), { loadForUser: async () => reference },
    () => ({
      getAccountIdentity: async () => ({ accountId, accountFingerprint: "fingerprint", uidHash: "hash" }),
      getOrder: async () => order,
    }),
  );
}

function attributionRequest(grossConfirmedQuantity: string) {
  return {
    accountId, instrumentId: "DOGE-USDT-SPOT", providerSymbol: "DOGEUSDT", baseAsset: "DOGE",
    executionIntentId: "intent-spot", executionRecordId: "execution-spot", grossConfirmedQuantity,
  };
}

function providerOrder(overrides: Partial<BitgetProviderOrder> = {}): BitgetProviderOrder {
  return {
    category: "SPOT", symbol: "DOGEUSDT", orderId: "9001", clientOid: "sxbgopening",
    side: "buy", status: "CONFIRMED", rawStatus: "filled", requestedQuantity: "95",
    filledQuantity: "95", averagePrice: "0.084", fee: "0", feeCurrency: null,
    updatedAt: now + 1, ...overrides,
  };
}

function credentialStore() {
  return {
    findSummary: (userId: string, venue: string) => userId === "user-a" && venue === "bitget" ? {
      userId, venue: "bitget" as const, accountId, accountFingerprint: "fingerprint", maskedApiKey: "***",
      environment: "production" as const, permissions: { providerVerified: true }, lastVerifiedAt: now,
      createdAt: now, updatedAt: now,
    } : null,
    loadForExecution: async () => ({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }),
  };
}

function credential() {
  return { apiKey: "key", apiSecret: "secret", passphrase: "pass" };
}

function accountSnapshot(overrides: Partial<ReturnType<typeof accountSnapshotBase>> = {}) {
  return { ...accountSnapshotBase(), ...overrides };
}

function accountSnapshotBase() {
  return {
    uid, accountMode: "hybrid", assetMode: "multi_assets", accountLevel: "advanced",
    holdMode: "one_way_mode", permType: "read-and-write", permissions: ["uta_trade"],
    boundIps: "127.0.0.1", balances: [], fetchedAt: now,
  };
}

function response(root: Record<string, unknown>) {
  return new Response(JSON.stringify({ code: "00000", msg: "success", ...root }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}
