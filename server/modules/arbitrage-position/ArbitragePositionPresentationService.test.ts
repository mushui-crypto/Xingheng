import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageMarket } from "../arbitrage/arbitrageTypes";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import { ArbitragePositionPresentationService } from "./ArbitragePositionPresentationService";

const now = 1_800_000_000_000;

test("maps same-venue spot/perpetual executable exit quotes and signed funding", async () => {
  let reads = 0;
  const service = new ArbitragePositionPresentationService({ async getCurrentMarketSnapshot() {
    reads += 1;
    return { generatedAt: now, markets: [market("binance", "spot", 100, 101), market("binance", "perpetual", 110, 111, 0.001, 110)] };
  } }, () => now);
  const [result] = await service.present([instance("binance", "binance", "DOGE-USDT-SPOT")]);
  assert.equal(reads, 1);
  assert.equal(result?.market.fundingRate, 0.001);
  assert.equal(result?.market.fundingIntervalHours, 8);
  assert.equal(result?.market.nextFundingTime, now + 3_600_000);
  assert.equal(result?.market.nextEstimatedFundingFee, "0.22");
  assert.equal(result?.market.spreadQuotePerBase, 11);
  assert.equal(result?.market.quotedAt, now);
  assert.equal(result?.market.completeness, "COMPLETE");
});

test("maps cross-venue long bid and short ask without extra snapshot reads", async () => {
  let reads = 0;
  const service = new ArbitragePositionPresentationService({ async getCurrentMarketSnapshot() {
    reads += 1;
    return { generatedAt: now, markets: [market("binance", "spot", 99, 100), market("bitget", "perpetual", 104, 105, 0.002, 104)] };
  } }, () => now);
  const results = await service.present([
    instance("binance", "bitget", "DOGE-USDT-SPOT", "a"),
    instance("binance", "bitget", "DOGE-USDT-SPOT", "b"),
  ]);
  assert.equal(reads, 1);
  assert.equal(results[0]?.market.spreadQuotePerBase, 6);
  assert.equal(results[1]?.market.spreadQuotePerBase, 6);
});

test("applies signed funding for perpetual long and short legs", async () => {
  const service = new ArbitragePositionPresentationService({ async getCurrentMarketSnapshot() {
    return { generatedAt: now, markets: [
      market("binance", "perpetual", 99, 100, 0.002, 100),
      market("bitget", "perpetual", 104, 105, 0.003, 105),
    ] };
  } }, () => now);
  const [result] = await service.present([instance("binance", "bitget", "DOGE-USDT-PERP")]);
  assert.equal(result?.market.fundingRate, 0.001);
  assert.equal(result?.market.nextEstimatedFundingFee, "0.23");
});

test("fails closed for stale market data and never exposes unreliable revenue values", async () => {
  const stale = { ...market("binance", "spot", 100, 101), fetchedAt: now - 20_001 };
  const service = new ArbitragePositionPresentationService({ async getCurrentMarketSnapshot() {
    return { generatedAt: now, markets: [stale, market("binance", "perpetual", 110, 111, 0.001, 110)] };
  } }, () => now);
  const [result] = await service.present([instance("binance", "binance", "DOGE-USDT-SPOT")]);
  assert.equal(result?.market.completeness, "INCOMPLETE");
  assert.equal(result?.market.fundingRate, null);
  assert.equal(result?.market.spreadQuotePerBase, null);
  assert.deepEqual(result?.revenue, {
    cumulativeFundingIncome: null, incurredFees: null, estimatedExitFees: null,
    currentArbitrageNetProfit: null, completeness: "INCOMPLETE",
  });
});

test("isolates one invalid instrument mapping without failing the batch", async () => {
  const service = new ArbitragePositionPresentationService({ async getCurrentMarketSnapshot() {
    return { generatedAt: now, markets: [market("binance", "spot", 100, 101), market("binance", "perpetual", 110, 111, 0.001, 110)] };
  } }, () => now);
  const invalid = { ...instance("binance", "binance", "DOGE-USDT-SPOT", "invalid"), legs: [
    { ...instance("binance", "binance", "DOGE-USDT-SPOT").legs[0], instrumentId: "INVALID" },
    instance("binance", "binance", "DOGE-USDT-SPOT").legs[1],
  ] } as ArbitrageInstance;
  const results = await service.present([invalid, instance("binance", "binance", "DOGE-USDT-SPOT", "valid")]);
  assert.equal(results[0]?.market.completeness, "INCOMPLETE");
  assert.equal(results[1]?.market.completeness, "COMPLETE");
});

function instance(longVenue: "binance" | "bitget", shortVenue: "binance" | "bitget", longInstrument: string, id = "arb-1") {
  return {
    arbitrageId: id, userId: "user-a", strategyType: longInstrument.endsWith("SPOT") ? "SPOT_PERPETUAL" : "PERPETUAL_PERPETUAL",
    sourcePlanId: null, maxResidualBaseQuantity: "0", status: "HOLDING", createdAt: now, openedAt: now, updatedAt: now, closedAt: null,
    legs: [
      { legId: "long", role: "LONG", venue: longVenue, accountId: "a", instrumentId: longInstrument, plannedQuantity: "2", confirmedOpenedQuantity: "2", confirmedClosedQuantity: "0" },
      { legId: "short", role: "SHORT", venue: shortVenue, accountId: "b", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "2", confirmedOpenedQuantity: "2", confirmedClosedQuantity: "0" },
    ], executionReferences: [], managementReleases: [], legacyUnresolvedExecutionSeals: [],
    pnl: { asset: "USDT", cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  } as ArbitrageInstance;
}

function market(venue: "binance" | "bitget", kind: "spot" | "perpetual", bid: number, ask: number, fundingRate: number | null = null, markPrice: number | null = null): ArbitrageMarket {
  return {
    id: `${venue}:DOGEUSDT:${kind}`, venue, venueLabel: venue, symbol: "DOGEUSDT", asset: "DOGE", kind,
    quoteAsset: "USDT", settlementAsset: "USDT", bid, ask, markPrice, indexPrice: null, spreadBps: null,
    fundingRate, fundingIntervalHours: kind === "perpetual" ? 8 : null, currentFundingApr: null, historicalFundingApr: null,
    fundingPositiveRatio: null, fundingCoverageRatio: null, slippageBps10k: null, slippageBps100k: null, depthUsd: null,
    volume24h: null, openInterest: null, nextFundingTime: kind === "perpetual" ? now + 3_600_000 : null,
    takerFeeBps: 10, status: "connected", fetchedAt: now, warnings: [],
  };
}
