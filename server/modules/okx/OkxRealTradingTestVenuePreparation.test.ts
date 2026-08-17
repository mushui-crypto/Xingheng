import assert from "node:assert/strict";
import test from "node:test";
import { createTradingRules } from "../cex/TradingRules";
import { OkxRealTradingTestVenuePreparation } from "./OkxRealTradingTestVenuePreparation";

const now = 1_800_000_000_000;

test("OKX preparation plans Spot and Perpetual canonical quantities from an 8 USDT maximum", async () => {
  const preparation = new OkxRealTradingTestVenuePreparation(credentials(), {
    now: () => now,
    tickerSource: async (instId) => ({
      ticker: { instType: instId.endsWith("SWAP") ? "SWAP" : "SPOT", instId, bidPx: "0.09", askPx: "0.1", ts: String(now) },
      fetchedAt: now,
    }),
    tradingRules: {
      async getTradingRules(instrument) {
        return instrument.category === "spot"
          ? createTradingRules({ quantityStep: "1", minQuantity: "1", priceTick: "0.00001", precision: {} })
          : createTradingRules({ quantityStep: "1", minQuantity: "1", priceTick: "0.00001", contractSize: "0.1", precision: {} });
      },
    },
  });

  const spot = await preparation.prepare(request("DOGE-USDT-SPOT"));
  const perpetual = await preparation.prepare(request("DOGE-USDT-PERP"));

  assert.equal(spot.accountId, "okx:account-user-a");
  assert.equal(spot.quantityPlan.plannedAssetQuantity.quantity, "80");
  assert.equal(spot.quantityPlan.plannedVenueQuantity, undefined);
  assert.equal(spot.quantityPlan.estimatedNotionalUsdt, "8");
  assert.equal(perpetual.quantityPlan.plannedAssetQuantity.quantity, "80");
  assert.equal(perpetual.quantityPlan.plannedVenueQuantity, "800");
  assert.equal(perpetual.quantityPlan.estimatedNotionalUsdt, "8");
});

test("OKX preparation fails closed when execution permission is absent", async () => {
  const preparation = new OkxRealTradingTestVenuePreparation(credentials(false), {
    now: () => now,
    tickerSource: async () => { throw new Error("must not read ticker"); },
  });

  await assert.rejects(() => preparation.prepare(request("DOGE-USDT-PERP")), /not enabled for execution/u);
});

test("OKX Spot rejects reduceOnly and PRICE_PRIORITY before market or rule reads", async () => {
  const preparation = new OkxRealTradingTestVenuePreparation(credentials(), {
    now: () => now,
    tickerSource: async () => { throw new Error("must not read ticker"); },
  });

  await assert.rejects(
    () => preparation.prepare({ ...request("DOGE-USDT-SPOT"), reduceOnly: true }),
    /does not support reduceOnly/u,
  );
  await assert.rejects(
    () => preparation.prepare({ ...request("DOGE-USDT-SPOT"), executionMode: "PRICE_PRIORITY" }),
    /supports EXECUTION_PRIORITY only/u,
  );
});

function request(instrumentId: string) {
  return {
    userId: "user-a",
    venue: "okx" as const,
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
      assert.equal(venue, "okx");
      return {
        userId,
        venue: "okx" as const,
        accountId: "okx:account-user-a",
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
