import assert from "node:assert/strict";
import test from "node:test";
import { buildArbitrageOpportunities, calculateHistoricalFundingMetrics, scoreOpportunity } from "./arbitrageScoring";
import type { ArbitrageAsset, ArbitrageVenue, InternalArbitrageMarket } from "./arbitrageTypes";

test("same-venue exact spot and perpetual pairs are included without admitting same-venue perp or proxy pairs", () => {
  const markets = [
    marketAtVenue("bybit-xaut-spot", "bybit", "XAUT", "spot", 0),
    marketAtVenue("bybit-xaut-perp", "bybit", "XAUT", "perpetual", 0.0004),
    marketAtVenue("bybit-paxg-perp", "bybit", "PAXG", "perpetual", 0.0005),
    marketAtVenue("bybit-xau-perp", "bybit", "XAU", "perpetual", 0.0002),
  ];

  const opportunities = buildArbitrageOpportunities(markets, 90);

  assert.deepEqual(opportunities.map((item) => item.id), ["bybit-xaut-spot--bybit-xaut-perp"]);
  assert.equal(opportunities[0]?.strategyType, "same_venue_neutral");
  assert.equal(opportunities[0]?.strategyLabel, "同所中性");
  assert.equal(opportunities[0]?.automationEligible, true);
});

test("stock RWA opportunities require the same underlying while allowing same-venue and cross-venue hedges", () => {
  const markets = [
    {
      ...marketAtVenue("bitget-mu-spot", "bitget", "MU", "spot", 0),
      availableSince: Date.now() - 7 * 24 * 60 * 60 * 1000,
    },
    marketAtVenue("bitget-mu-perp", "bitget", "MU", "perpetual", 0.0004),
    marketAtVenue("bybit-mu-perp", "bybit", "MU", "perpetual", 0.0005),
    marketAtVenue("bitget-nvda-perp", "bitget", "NVDA", "perpetual", 0.0007),
  ];
  const opportunities = buildArbitrageOpportunities(markets, 90);
  const ids = opportunities.map((item) => item.id);

  assert.ok(ids.includes("bitget-mu-spot--bitget-mu-perp"));
  assert.ok(ids.includes("bitget-mu-spot--bybit-mu-perp"));
  assert.ok(ids.includes("bitget-mu-perp--bybit-mu-perp"));
  assert.ok(!ids.some((id) => id.includes("nvda") && id.includes("mu")));
  assert.ok(opportunities.find((item) => item.id === "bitget-mu-spot--bitget-mu-perp")?.warnings
    .some((warning) => warning.includes("公司行动")));
  assert.ok(opportunities.find((item) => item.id === "bitget-mu-spot--bitget-mu-perp")?.warnings
    .some((warning) => warning.includes("历史数据覆盖不足")));
});

test("exact-asset opportunity can be recommended when persistent net carry covers costs", () => {
  const long = market("long", "XAUT", "spot", 0);
  const short = market("short", "XAUT", "perpetual", 0.0004);
  const opportunity = scoreOpportunity(long, short, 90);

  assert.equal(opportunity.matchQuality, "exact");
  assert.equal(opportunity.recommendation, "recommended");
  assert.equal(opportunity.entryStatus, "favorable");
  assert.ok(opportunity.score >= 80);
  assert.ok(opportunity.netApr > 0);
  assert.equal(opportunity.shortLeg.fundingRate, 0.0004);
  assert.equal(opportunity.shortLeg.fundingIntervalHours, 24);
  assert.equal(opportunity.strategyType, "cross_venue_arbitrage");
  assert.equal(opportunity.automationEligible, false);
  assert.ok(opportunity.automationDisqualifiers.some((reason) => reason.includes("仅评估同所")));
});

test("proxy-asset opportunities are capped at 79 and cannot become recommended", () => {
  const long = market("long", "PAXG", "spot", 0);
  const short = market("short", "GOLD", "perpetual", 0.001);
  const opportunity = scoreOpportunity(long, short, 90);

  assert.equal(opportunity.matchQuality, "proxy");
  assert.equal(opportunity.score, 79);
  assert.equal(opportunity.historicalQualityScore, 79);
  assert.notEqual(opportunity.recommendation, "recommended");
});

test("current opportunity score exposes the new explainable breakdown and separate historical quality", () => {
  const long = market("long", "XAUT", "spot", 0);
  const short = market("short", "XAUT", "perpetual", 0.0004);
  const opportunity = scoreOpportunity(long, short, 90);

  assert.deepEqual(Object.keys(opportunity.scoreBreakdown), [
    "conservativeNetReturn",
    "driverStrength",
    "persistence",
    "costEfficiency",
    "liquidity",
    "confidence",
  ]);
  assert.equal(opportunity.opportunityDriver, "funding");
  assert.equal(opportunity.opportunityDriverLabel, "资金费率驱动");
  assert.equal(opportunity.confidence, "high");
  assert.equal(opportunity.confidenceLabel, "高");
  assert.ok(opportunity.historicalQualityScore >= 80);
  assert.ok(opportunity.score >= 80);
  assert.equal(opportunity.recommendation, "recommended");
});

test("negative expected return is a warning rather than a hard execution block", () => {
  const long = { ...market("long", "XAUT", "spot", 0), takerFeeBps: 10, slippageBps10k: 10 };
  const short = { ...market("short", "XAUT", "perpetual", 0.00001), takerFeeBps: 10, slippageBps10k: 10 };
  const opportunity = scoreOpportunity(long, short, 90);

  assert.ok(opportunity.netApr < 0);
  assert.equal(opportunity.disqualifiers.length, 0);
  assert.notEqual(opportunity.recommendation, "blocked");
  assert.ok(opportunity.warnings.some((reason) => reason.includes("无法覆盖往返成本")));
  assert.equal(opportunity.automationEligible, false);
});

test("zero current Funding changes entry timing without downgrading long-term carry quality", () => {
  const long = market("long", "XAUT", "spot", 0);
  const short = {
    ...market("short", "XAUT", "perpetual", 0.001),
    fundingRate: 0,
    currentFundingApr: 0,
  };
  const opportunity = scoreOpportunity(long, short, 90);

  assert.equal(opportunity.recommendation, "recommended");
  assert.equal(opportunity.entryStatus, "waiting");
  assert.ok(opportunity.score <= 49);
  assert.ok(opportunity.historicalQualityScore >= 80);
  assert.equal(opportunity.disqualifiers.length, 0);
  assert.ok(opportunity.warnings.some((reason) => reason.includes("未处于收取 Funding")));
});

test("cross-venue perpetual entry timing uses the net funding spread rather than the short leg alone", () => {
  const long = market("long", "XAUT", "perpetual", -0.0005);
  const short = market("short", "XAUT", "perpetual", -0.0001);
  const opportunity = scoreOpportunity(long, short, 90);

  assert.ok((opportunity.shortLeg.fundingRate ?? 0) < 0);
  assert.ok(opportunity.currentGrossApr > 0);
  assert.equal(opportunity.entryStatus, "favorable");
});

test("disconnected leg blocks recommendation even when carry is positive", () => {
  const long = market("long", "XAU", "perpetual", 0);
  const short = { ...market("short", "GOLD", "perpetual", 0.001), status: "disconnected" as const };
  const opportunity = scoreOpportunity(long, short, 90);

  assert.equal(opportunity.recommendation, "blocked");
  assert.equal(opportunity.entryStatus, "blocked");
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

function marketAtVenue(
  id: string,
  venue: ArbitrageVenue,
  asset: ArbitrageAsset,
  kind: "spot" | "perpetual",
  dailyRate: number,
) {
  return {
    ...market(id, asset, kind, dailyRate),
    venue,
    venueLabel: venue === "bybit" ? "Bybit" : venue,
  } satisfies InternalArbitrageMarket;
}

function dailyHistory(days: number, rate: number) {
  return Array.from({ length: days }, (_, index) => ({
    rate,
    timestamp: Date.now() - index * 24 * 60 * 60 * 1000,
  }));
}
