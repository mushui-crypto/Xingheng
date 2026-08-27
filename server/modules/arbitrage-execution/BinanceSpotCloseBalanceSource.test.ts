import assert from "node:assert/strict";
import test from "node:test";
import { BinanceSpotCloseBalanceSource } from "./BinanceSpotCloseBalanceSource";

test("reads the exact Spot free balance through the authenticated user-scoped service", async () => {
  let receivedUserId: string | null = null;
  const source = new BinanceSpotCloseBalanceSource({
    run: async (userId, operation) => {
      receivedUserId = userId;
      return operation({
        readSpotCloseBalance: async (baseAsset) => {
          assert.equal(baseAsset, "BTC");
          return {
            accountId: "account-a",
            baseAsset: "BTC",
            totalQuantity: "0.223456789012345678",
            availableQuantity: "0.123456789012345678",
            fetchedAt: 1_900_000_000_000,
          };
        },
      });
    },
  });

  assert.deepEqual(await source.readAvailableBalance("user-a", {
    accountId: "account-a",
    instrumentId: "BTC-USDT-SPOT",
    providerSymbol: "BTCUSDT",
    baseAsset: "BTC",
  }), {
    totalQuantity: "0.223456789012345678",
    availableQuantity: "0.123456789012345678",
    checkedAt: 1_900_000_000_000,
  });
  assert.equal(receivedUserId, "user-a");
});

test("fails closed on account, instrument binding, or available balance mismatch", async () => {
  const source = (snapshot: Record<string, unknown>, accountId = "account-a") => new BinanceSpotCloseBalanceSource({
    run: async (_userId, operation) => operation({
      readSpotCloseBalance: async () => ({
        accountId,
        baseAsset: "BTC",
        totalQuantity: "1",
        availableQuantity: "1",
        fetchedAt: 1,
        ...snapshot,
      } as never),
    }),
  });
  const request = {
    accountId: "account-a",
    instrumentId: "BTC-USDT-SPOT",
    providerSymbol: "BTCUSDT",
    baseAsset: "BTC",
  };

  await assert.rejects(source({}, "account-b").readAvailableBalance("user-a", request), /identity is invalid/u);
  await assert.rejects(source({ baseAsset: "ETH" }).readAvailableBalance("user-a", request), /identity is invalid/u);
  await assert.rejects(source({ availableQuantity: "NaN" }).readAvailableBalance("user-a", request), /not a Decimal/u);
});
