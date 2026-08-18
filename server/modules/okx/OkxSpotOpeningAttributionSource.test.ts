import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import { OkxSpotOpeningAttributionSource } from "./OkxSpotOpeningAttributionSource";

test("uses the persisted OKX order reference when a recovered Spot ExecutionRecord has no remoteOrderId", async () => {
  let orderQuery: unknown = null;
  const source = new OkxSpotOpeningAttributionSource(
    { loadForUser: async () => executionRecord() },
    {
      findSummary: () => ({ accountId: "okx:account" }) as never,
      loadForExecution: async () => ({ apiKey: "key", apiSecret: "secret", passphrase: "passphrase" }),
    },
    { loadForUser: async () => orderReference() },
    () => ({
      getAccountIdentity: async () => ({
        accountId: "okx:account",
        accountFingerprint: "fingerprint",
        uidHash: "uid-hash",
        accountLevel: "2",
      }),
      getOrder: async (query) => {
        orderQuery = query;
        return {
          instId: "DOGE-USDT",
          ordId: "3842710862301057024",
          clOrdId: "sxokx-recovered",
          side: "buy",
          status: "CONFIRMED",
          statusReason: null,
          rawState: "filled",
          requestedQuantity: "114.711786",
          filledQuantity: "114.711786",
          averagePrice: "0.0697",
          fee: "-0.114711786",
          feeCcy: "DOGE",
          updatedAt: 1_800_000_000_100,
        };
      },
    }),
  );

  assert.equal(await source.readAttributableBaseQuantity("user-a", request()), "114.711786");
  assert.deepEqual(orderQuery, {
    instId: "DOGE-USDT",
    ordId: "3842710862301057024",
    clOrdId: "sxokx-recovered",
  });
});

test("fails closed when ExecutionRecord and persisted OKX order reference disagree", async () => {
  let providerReads = 0;
  const source = new OkxSpotOpeningAttributionSource(
    { loadForUser: async () => ({ ...executionRecord(), remoteOrderId: "different-order" }) },
    {
      findSummary: () => ({ accountId: "okx:account" }) as never,
      loadForExecution: async () => ({ apiKey: "key", apiSecret: "secret", passphrase: "passphrase" }),
    },
    { loadForUser: async () => orderReference() },
    () => ({
      getAccountIdentity: async () => {
        providerReads += 1;
        throw new Error("must not read provider");
      },
      getOrder: async () => {
        providerReads += 1;
        throw new Error("must not read provider");
      },
    }),
  );

  await assert.rejects(
    source.readAttributableBaseQuantity("user-a", request()),
    /order reference identity is unavailable/u,
  );
  assert.equal(providerReads, 0);
});

function executionRecord(): ExecutionRecord {
  return {
    executionId: "execution-a",
    intentId: "intent-a",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account",
    instrumentId: "DOGE-USDT-SPOT",
    status: "CONFIRMED",
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_100,
  };
}

function orderReference() {
  return {
    executionId: "execution-a",
    intentId: "intent-a",
    userId: "user-a",
    accountId: "okx:account",
    instrumentId: "DOGE-USDT-SPOT",
    instId: "DOGE-USDT",
    ordId: "3842710862301057024",
    clOrdId: "sxokx-recovered",
    expectedProviderQuantity: "114.711786",
    expectedSide: "buy" as const,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_100,
  };
}

function request() {
  return {
    accountId: "okx:account",
    instrumentId: "DOGE-USDT-SPOT",
    providerSymbol: "DOGE-USDT",
    baseAsset: "DOGE",
    executionIntentId: "intent-a",
    executionRecordId: "execution-a",
    grossConfirmedQuantity: "114.711786",
  };
}
