import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageMarket } from "../arbitrage/arbitrageTypes";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ExecutionAccountingFact } from "../cex/arbitrage-instance/ExecutionAccountingFact";
import type { ArbitrageFundingFact, FundingHistoryCoverage } from "../cex/arbitrage-instance/FundingAccounting";
import { BybitFundingIngestionService } from "./BybitFundingIngestionService";

const hour = 3_600_000;
const settlement = 8 * hour;
const now = settlement + 5 * 60_000;

test("Bybit settlement catch-up uniquely attributes signed USDT funding when provider size equals managed exposure", async () => {
  const result = await ingest("-68", "-0.003");
  assert.equal(result.reads, 1);
  assert.deepEqual(result.facts, [{
    providerFundingId: "funding-1", venue: "bybit", accountId: "account",
    instrumentId: "DOGE-USDT-PERP", positionSideOrBucket: "SHORT", providerPositionSize: "-68",
    settlementTime: settlement,
    amount: "-0.003", asset: "USDT", amountUsdt: "-0.003", arbitrageId: "arb",
    attributionStatus: "ATTRIBUTED", integrityStatus: "VERIFIED", createdAt: now,
  }]);
  assert.deepEqual(result.coverages, [{
    venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP",
    coveredFrom: hour, coveredThrough: settlement, lastSuccessfulReadAt: now, paginationComplete: true,
  }]);
});

test("Bybit settlement catch-up refuses unique attribution when Provider bucket contains external exposure", async () => {
  const result = await ingest("-70", "-0.003");
  assert.equal(result.facts[0]?.attributionStatus, "AMBIGUOUS");
  assert.equal(result.facts[0]?.arbitrageId, null);
});

test("startup catch-up recalculates stored attribution from current authoritative execution evidence", async () => {
  const value = instance();
  const stored: ArbitrageFundingFact = {
    providerFundingId: "funding-stored", venue: "bybit", accountId: "account",
    instrumentId: "DOGE-USDT-PERP", positionSideOrBucket: "SHORT", providerPositionSize: "-68",
    settlementTime: settlement, amount: "-0.002", asset: "USDT", amountUsdt: "-0.002",
    arbitrageId: null, attributionStatus: "AMBIGUOUS", integrityStatus: "VERIFIED", createdAt: settlement,
  };
  const writes: ArbitrageFundingFact[] = [];
  const service = new BybitFundingIngestionService({
    listFundingManagedPerpContexts: () => [{ userId: "user", venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP" }],
    listFundingAttributionCandidates: () => [value],
    listExecutionAccountingFacts: () => [executionFact()],
  }, {
    recordFact: (fact) => { writes.push(fact); return fact; },
    listFacts: () => [stored],
    readCoverage: () => ({
      venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP",
      coveredFrom: hour, coveredThrough: settlement, lastSuccessfulReadAt: now, paginationComplete: true,
    }),
    recordCoverage: (coverage) => coverage,
  }, {
    async getCurrentMarketSnapshot() { return { generatedAt: now, markets: [market()] }; },
  }, { async read() { return []; } }, { now: () => now });

  await service.runOnce();
  assert.equal(writes[0]?.providerFundingId, "funding-stored");
  assert.equal(writes[0]?.arbitrageId, "arb");
  assert.equal(writes[0]?.attributionStatus, "ATTRIBUTED");
});

async function ingest(size: string, funding: string) {
  const value = instance();
  const facts: ArbitrageFundingFact[] = [];
  const coverages: FundingHistoryCoverage[] = [];
  let reads = 0;
  const service = new BybitFundingIngestionService({
    listFundingManagedPerpContexts: () => [{ userId: "user", venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP" }],
    listFundingAttributionCandidates: () => [value],
    listExecutionAccountingFacts: () => [executionFact()],
  }, {
    recordFact: (fact) => { facts.push(fact); return fact; },
    listFacts: () => [],
    readCoverage: () => null,
    recordCoverage: (coverage) => { coverages.push(coverage); return coverage; },
  }, {
    async getCurrentMarketSnapshot() { return { generatedAt: now, markets: [market()] }; },
  }, {
    async read(userId, input) {
      reads += 1;
      assert.equal(userId, "user");
      assert.deepEqual(input, { symbol: "DOGEUSDT", startTime: hour, endTime: settlement });
      return [{ id: "funding-1", symbol: "DOGEUSDT", side: "Sell", transactionTime: settlement, funding, currency: "USDT", size }];
    },
  }, { now: () => now });
  await service.runOnce();
  return { facts, coverages, reads };
}

function instance(): ArbitrageInstance {
  return {
    arbitrageId: "arb", userId: "user", strategyType: "SPOT_PERPETUAL", sourcePlanId: null,
    maxResidualBaseQuantity: "0", status: "HOLDING", createdAt: hour - 1, openedAt: hour,
    updatedAt: hour, closedAt: null,
    legs: [
      { legId: "spot", role: "LONG", venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "68", confirmedOpenedQuantity: "68", confirmedClosedQuantity: "0" },
      { legId: "perp", role: "SHORT", venue: "bybit", accountId: "account", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "68", confirmedOpenedQuantity: "68", confirmedClosedQuantity: "0" },
    ],
    executionReferences: [{
      arbitrageId: "arb", legId: "perp", phase: "OPENING", quantityEffect: "INCREASE",
      executionIntentId: "intent", executionRecordId: "record", requestedQuantity: "68",
      confirmedQuantity: "68", status: "CONFIRMED", createdAt: hour - 1, updatedAt: hour,
    }],
    managementReleases: [], legacyUnresolvedExecutionSeals: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}

function executionFact(): ExecutionAccountingFact {
  return {
    executionRecordId: "record", arbitrageId: "arb", legId: "perp", executionIntentId: "intent",
    providerOrderId: "order", executionPhase: "OPENING", quantityEffect: "INCREASE",
    terminalExecutionStatus: "CONFIRMED", filledQuantity: "68", averageFillPrice: "0.1",
    feeAmountProvider: "0", feeAsset: "USDT", tradingFeeNetCostUsdt: "0", confirmedAt: hour,
    priceCompleteness: "COMPLETE", feeCompleteness: "COMPLETE", integrityStatus: "VERIFIED",
    completeness: "COMPLETE", createdAt: hour,
  };
}

function market(): ArbitrageMarket {
  return {
    id: "bybit:DOGEUSDT:perpetual", venue: "bybit", venueLabel: "Bybit", symbol: "DOGEUSDT",
    asset: "DOGE", kind: "perpetual", quoteAsset: "USDT", settlementAsset: "USDT",
    bid: 0.1, ask: 0.11, markPrice: 0.105, indexPrice: 0.105, spreadBps: null,
    fundingRate: 0.001, fundingIntervalHours: 8, currentFundingApr: null, historicalFundingApr: null,
    fundingPositiveRatio: null, fundingCoverageRatio: null, slippageBps10k: null, slippageBps100k: null,
    depthUsd: null, volume24h: null, openInterest: null, nextFundingTime: 16 * hour,
    fundingScheduleCompleteness: "COMPLETE", takerFeeBps: 5.5, status: "connected", fetchedAt: now, warnings: [],
  };
}
