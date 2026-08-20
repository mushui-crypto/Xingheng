import assert from "node:assert/strict";
import test from "node:test";
import { createTradingRules } from "../cex/TradingRules";
import { BinanceRealTradingTestVenuePreparation } from "./BinanceRealTradingTestVenuePreparation";

const now = 1_800_000_000_000;

test("Binance preparation plans Spot and Perpetual quantities through shared planner", async () => {
  const preparation = new BinanceRealTradingTestVenuePreparation(credentials(), {
    now: () => now,
    tickerSource: async (symbol) => ({
      ticker: { symbol, bidPrice: "0.09", askPrice: "0.1" },
      fetchedAt: now,
    }),
    tradingRules: {
      async getTradingRules(instrument) {
        return instrument.category === "spot"
          ? createTradingRules({ quantityStep: "1", minQuantity: "1", priceTick: "0.00001", precision: {} })
          : createTradingRules({ quantityStep: "1", minQuantity: "1", priceTick: "0.00001", precision: {} });
      },
    },
  });

  const spot = await preparation.prepare(request("DOGE-USDT-SPOT"));
  const perpetual = await preparation.prepare(request("DOGE-USDT-PERP"));
  assert.equal(spot.accountId, "binance:account-user-a");
  assert.equal(spot.quantityPlan.plannedAssetQuantity.quantity, "80");
  assert.equal(perpetual.quantityPlan.plannedAssetQuantity.quantity, "80");
});

test("Binance preparation fails closed when execution permission is absent", async () => {
  const preparation = new BinanceRealTradingTestVenuePreparation(credentials(false), {
    tickerSource: async () => { throw new Error("must not read ticker"); },
  });
  await assert.rejects(() => preparation.prepare(request("DOGE-USDT-PERP")), /not enabled for execution/u);
});

function request(instrumentId: string) {
  return {
    userId: "user-a",
    venue: "binance" as const,
    instrumentId,
    side: "buy" as const,
    quantityInput: { mode: "NOTIONAL_USDT" as const, amountUsdt: "8" },
    reduceOnly: false,
    executionMode: "EXECUTION_PRIORITY" as const,
  };
}

function credentials(executionEnabled = true) {
  return {
    findSummary(userId: string, venue: string) {
      assert.equal(userId, "user-a");
      assert.equal(venue, "binance");
      return {
        userId,
        venue: "binance" as const,
        accountId: "binance:account-user-a",
        accountFingerprint: "fingerprint",
        maskedApiKey: "key-...-1234",
        environment: "test" as const,
        permissions: { executionEnabled },
        lastVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      };
    },
  };
}
