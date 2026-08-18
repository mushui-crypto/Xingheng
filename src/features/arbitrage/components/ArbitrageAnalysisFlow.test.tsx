import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArbitrageMarket, ArbitrageOpportunity } from "../model/types";
import { ArbitrageOpportunityAnalysis } from "./ArbitrageOpportunityAnalysis";
import { ArbitrageOpportunityTable } from "./ArbitrageOpportunityTable";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const nextFundingTime = Date.now() + 3_600_000;
const longMarket = market({
  id: "binance-btc-spot",
  kind: "spot",
  fundingRate: null,
  fundingIntervalHours: null,
  currentFundingApr: 0,
  historicalFundingApr: 0,
  fundingPositiveRatio: null,
});
const shortMarket = market({
  id: "okx-btc-perp",
  venue: "okx",
  venueLabel: "OKX",
  symbol: "BTC-USDT-SWAP",
  kind: "perpetual",
  fundingRate: 0.0001,
  fundingIntervalHours: 8,
  currentFundingApr: 10.95,
  historicalFundingApr: 8.5,
  fundingPositiveRatio: 0.72,
});
const opportunity = {
  id: `${longMarket.id}--${shortMarket.id}`,
  longLeg: leg(longMarket),
  shortLeg: leg(shortMarket),
  strategyType: "cross_venue_arbitrage",
  strategyLabel: "跨所套利",
  matchQuality: "exact",
  matchLabel: "精确匹配",
  currentGrossApr: 10.95,
  historicalGrossApr: 8.5,
  netApr: 6.25,
  persistenceRatio: 0.72,
  annualizedTradingCostApr: 2.25,
  roundTripCostBps: 55,
  entryBasisBps: 4,
  capacityUsd: 25_000,
  score: 76,
  historicalQualityScore: 73,
  confidence: "high",
  opportunityDriver: "funding",
  opportunityDriverLabel: "资金费率驱动",
  recommendation: "watch",
  entryStatus: "favorable",
  scoreBreakdown: {
    conservativeNetReturn: 20,
    driverStrength: 15,
    persistence: 12,
    costEfficiency: 10,
    liquidity: 9,
    confidence: 10,
  },
  disqualifiers: [],
  warnings: ["示例风险说明"],
  automationEligible: false,
  automationDisqualifiers: ["首版自动执行仅评估同所中性组合"],
} satisfies ArbitrageOpportunity;

test("dashboard opportunity table provides analysis navigation without inline deep analysis", () => {
  const html = renderToStaticMarkup(
    <ArbitrageOpportunityTable
      opportunities={[opportunity]}
      holdingDays={90}
      yieldMetric="apr"
      onAnalyze={() => undefined}
    />,
  );

  assert.match(html, /查看分析/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-label="查看 BTCUSDT 与 BTC-USDT-SWAP 套利分析"/);
  assert.match(html, /资金费率（Funding）/);
  assert.doesNotMatch(html, /分析因子|评分构成|自动执行条件（旧规则）/u);
});

test("analysis component renders dashboard metrics and keeps old automation rules secondary", () => {
  const html = renderToStaticMarkup(
    <ArbitrageOpportunityAnalysis
      opportunity={opportunity}
      longMarket={longMarket}
      shortMarket={shortMarket}
      holdingDays={90}
    />,
  );

  for (const label of ["机会摘要", "持有测算", "历史资金费率", "成本与流动性", "两腿市场对比", "综合分析", "分析因子", "评分构成"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /自动执行条件（旧规则）/);
  assert.match(html, /不代表当前系统会自动执行/);
  assert.match(html, /24小时成交额/);
  assert.match(html, /未平仓量/);
  assert.doesNotMatch(html, /Estimated Net Yield|Funding Spread|Expiry/u);
});

function market(overrides: Partial<ArbitrageMarket>): ArbitrageMarket {
  return {
    id: "binance-btc-spot",
    venue: "binance",
    venueLabel: "Binance",
    symbol: "BTCUSDT",
    asset: "BTC",
    kind: "spot",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    bid: 100_000,
    ask: 100_010,
    markPrice: 100_005,
    indexPrice: 100_004,
    spreadBps: 1,
    fundingRate: null,
    fundingIntervalHours: null,
    currentFundingApr: 0,
    historicalFundingApr: 0,
    fundingPositiveRatio: null,
    fundingCoverageRatio: 1,
    slippageBps10k: 2,
    slippageBps100k: 8,
    depthUsd: 50_000,
    volume24h: 5_000_000,
    openInterest: 2_000_000,
    nextFundingTime,
    takerFeeBps: 5,
    status: "connected",
    fetchedAt: Date.now(),
    warnings: [],
    ...overrides,
  };
}

function leg(source: ArbitrageMarket): ArbitrageOpportunity["longLeg"] {
  return {
    id: source.id,
    venue: source.venue,
    venueLabel: source.venueLabel,
    symbol: source.symbol,
    asset: source.asset,
    kind: source.kind,
    quoteAsset: source.quoteAsset,
    settlementAsset: source.settlementAsset,
    bid: source.bid,
    ask: source.ask,
    fundingRate: source.fundingRate,
    fundingIntervalHours: source.fundingIntervalHours,
    currentFundingApr: source.currentFundingApr,
    historicalFundingApr: source.historicalFundingApr,
    nextFundingTime: source.nextFundingTime,
  };
}
