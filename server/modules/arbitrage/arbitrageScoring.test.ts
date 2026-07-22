import assert from "node:assert/strict";
import test from "node:test";
import { calculateHistoricalFundingMetrics, scoreOpportunity } from "./arbitrageScoring";
import type { ArbitrageAsset, InternalArbitrageMarket } from "./arbitrageTypes";

test("exact-asset opportunity can be recommended when persistent net carry covers costs", () => {
  const long = market("long", "XAUT", "spot", 0);
  const short = market("short", "XAUT", "perpetual", 0.0004);
  const opportunity = scoreOpportunity(long, short, 90);

  assert.equal(opportunity.matchQuality, "exact");
  assert.equal(opportunity.recommendation, "recommended");
  assert.ok(opportunity.score >= 80);
  assert.ok(opportunity.netApr > 0);
  assert.equal(opportunity.shortLeg.fundingRate, 0.0004);
  assert.equal(opportunity.shortLeg.fundingIntervalHours, 24);
});

test("proxy-asset opportunities can exceed 79 and become recommended", () => {
  const long = market("long", "PAXG", "spot", 0);
  const short = market("short", "GOLD", "perpetual", 0.001);
  const opportunity = scoreOpportunity(long, short, 90);

  assert.equal(opportunity.matchQuality, "proxy");
  assert.ok(opportunity.score > 79);
  assert.equal(opportunity.recommendation, "recommended");
});

test("exact-asset opportunities become recommended at the relaxed 75-point threshold", () => {
  const long = market("long", "XAUT", "spot", 0);
  const short = market("short", "XAUT", "perpetual", 0.00007);
  const opportunity = scoreOpportunity(long, short, 90);

  assert.ok(opportunity.score >= 75 && opportunity.score < 80);
  assert.equal(opportunity.recommendation, "recommended");
});

test("disconnected leg blocks recommendation even when carry is positive", () => {
  const long = market("long", "XAU", "perpetual", 0);
  const short = { ...market("short", "GOLD", "perpetual", 0.001), status: "disconnected" as const };
  const opportunity = scoreOpportunity(long, short, 90);

  assert.equal(opportunity.recommendation, "blocked");
  assert.ok(opportunity.disqualifiers.some((reason) => reason.includes("数据源不可用")));
});

test("historical funding metrics preserve horizon coverage and annualize daily yield", () => {
  const history = dailyHistory(90, 0.0002);
  const metrics = calculateHistoricalFundingMetrics(history, 90);

  assert.ok((metrics.apr ?? 0) > 7);
  assert.equal(metrics.positiveRatio, 1);
  assert.ok(metrics.coverageRatio >= 0.9);
});

test("holding period changes cost amortization without changing the 90-day funding baseline", () => {
  const long = { ...market("long", "XAUT", "spot", 0), takerFeeBps: 5, slippageBps10k: 2 };
  const short = { ...market("short", "XAUT", "perpetual", 0.0004), takerFeeBps: 5, slippageBps10k: 2 };
  const ninetyDay = scoreOpportunity(long, short, 90, 90);
  const annual = scoreOpportunity(long, short, 365, 90);

  assert.equal(annual.historicalGrossApr, ninetyDay.historicalGrossApr);
  assert.ok(annual.annualizedTradingCostApr < ninetyDay.annualizedTradingCostApr);
  assert.ok(annual.netApr > ninetyDay.netApr);
});

function market(id: string, asset: ArbitrageAsset, kind: "spot" | "perpetual", dailyRate: number): InternalArbitrageMarket {
  const history = kind === "spot" ? [] : dailyHistory(14, dailyRate);
  return {
    id,
    venue: id === "long" ? "binance" : "bybit",
    venueLabel: id === "long" ? "Binance" : "Bybit",
    symbol: `${asset}USDT`,
    asset,
    kind,
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    bid: 4_100,
    ask: 4_100.1,
    markPrice: 4_100,
    indexPrice: 4_100,
    spreadBps: 0.25,
    fundingRate: kind === "spot" ? null : dailyRate,
    fundingIntervalHours: kind === "spot" ? null : 24,
    currentFundingApr: kind === "spot" ? 0 : dailyRate * 365 * 100,
    historicalFundingApr: kind === "spot" ? 0 : dailyRate * 365 * 100,
    fundingPositiveRatio: kind === "spot" ? null : 1,
    fundingCoverageRatio: 1,
    slippageBps10k: 0,
    slippageBps100k: 0,
    depthUsd: 250_000,
    volume24h: 1_000_000,
    openInterest: 500_000,
    nextFundingTime: null,
    takerFeeBps: 0,
    status: "connected",
    fetchedAt: Date.now(),
    warnings: [],
    fundingHistory: history,
  };
}

function dailyHistory(days: number, rate: number) {
  return Array.from({ length: days }, (_, index) => ({
    rate,
    timestamp: Date.now() - index * 24 * 60 * 60 * 1000,
  }));
}
