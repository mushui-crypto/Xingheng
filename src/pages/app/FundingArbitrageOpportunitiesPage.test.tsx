import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS,
  ArbitrageAnalysisEmptyState,
  FundingArbitrageOpportunitiesPage,
  reduceArbitrageDashboardRefreshState,
} from "./FundingArbitrageOpportunitiesPage";
import type { ArbitrageDashboardSnapshot, ArbitrageOpportunity } from "../../features/arbitrage/model/types";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("invalid analysis opportunity renders a Chinese recovery state", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ArbitrageAnalysisEmptyState
        title="该套利机会当前已不可用或市场数据已更新"
        description="请返回套利看板，根据最新市场数据重新选择机会。"
        actionLabel="返回套利看板"
      />
    </MemoryRouter>,
  );

  assert.match(html, /该套利机会当前已不可用或市场数据已更新/);
  assert.match(html, /返回套利看板/);
  assert.match(html, /href="\/app\/arbitrage"/);
});

test("analysis navigation without an opportunity id renders the selection state without error", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/app/funding-arbitrage"]}>
      <Routes>
        <Route path="/app/funding-arbitrage" element={<FundingArbitrageOpportunitiesPage />} />
      </Routes>
    </MemoryRouter>,
  );

  assert.match(html, /请选择一个套利机会进行分析/);
  assert.match(html, /前往套利看板/);
  assert.doesNotMatch(html, /已不可用|市场数据已更新/u);
});

test("initial analysis load renders loading while no snapshot is available", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/app/funding-arbitrage?opportunityId=op-1&horizonDays=90"]}>
      <Routes>
        <Route path="/app/funding-arbitrage" element={<FundingArbitrageOpportunitiesPage />} />
      </Routes>
    </MemoryRouter>,
  );

  assert.match(html, /animate-pulse/);
  assert.doesNotMatch(html, /该套利机会当前已不可用/);
});

test("automatic background refresh retains the last valid snapshot and mounted execution context", () => {
  const snapshot = makeSnapshot(1, 0.084);
  const refreshing = reduceArbitrageDashboardRefreshState(
    { snapshot, executionOpportunityId: "op-1", status: "idle", error: "" },
    { type: "load-started", selectedOpportunityId: "op-1" },
  );

  assert.equal(ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS, 25_000);
  assert.equal(refreshing.status, "refreshing");
  assert.strictEqual(refreshing.snapshot, snapshot);
  assert.equal(refreshing.executionOpportunityId, "op-1");
});

test("background refresh failure keeps the previous snapshot and reports a non-blocking error", () => {
  const snapshot = makeSnapshot(1, 0.084);
  const failed = reduceArbitrageDashboardRefreshState(
    { snapshot, executionOpportunityId: "op-1", status: "refreshing", error: "" },
    { type: "load-failed", error: "network unavailable" },
  );

  assert.strictEqual(failed.snapshot, snapshot);
  assert.equal(failed.status, "idle");
  assert.equal(failed.error, "network unavailable");
  assert.equal(failed.executionOpportunityId, "op-1");
});

test("successful background refresh replaces market data while keeping the mounted execution entry", () => {
  const previous = makeSnapshot(1, 0.084);
  const next = makeSnapshot(2, 0.086);
  const refreshing = reduceArbitrageDashboardRefreshState(
    { snapshot: previous, executionOpportunityId: "op-1", status: "idle", error: "" },
    { type: "load-started", selectedOpportunityId: "op-1" },
  );
  const updated = reduceArbitrageDashboardRefreshState(refreshing, {
    type: "load-succeeded",
    snapshot: next,
    selectedOpportunityId: "op-1",
  });

  assert.strictEqual(refreshing.snapshot, previous);
  assert.strictEqual(updated.snapshot, next);
  assert.equal(updated.snapshot.markets[0]?.ask, 0.086);
  assert.equal(updated.snapshot.opportunities[0]?.id, "op-1");
  assert.equal(updated.executionOpportunityId, "op-1");
});

test("a refreshed market list cannot unmount an active modal or clear its draft and amount", () => {
  const previous = makeSnapshot(1, 0.084);
  const next = { ...makeSnapshot(2, 0.086), opportunities: [] };
  const updated = reduceArbitrageDashboardRefreshState(
    { snapshot: previous, executionOpportunityId: "op-1", status: "refreshing", error: "" },
    { type: "load-succeeded", snapshot: next, selectedOpportunityId: "op-1" },
  );

  assert.ok(updated.snapshot);
  assert.deepEqual(updated.snapshot.opportunities, []);
  assert.equal(updated.executionOpportunityId, "op-1");
});

function makeSnapshot(generatedAt: number, ask: number): ArbitrageDashboardSnapshot {
  const longLeg = {
    id: "bybit-DOGE-USDT-SPOT",
    venue: "bybit",
    venueLabel: "Bybit",
    symbol: "DOGEUSDT",
    asset: "DOGE",
    kind: "spot",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    bid: ask - 0.001,
    ask,
    fundingRate: null,
    fundingIntervalHours: null,
    currentFundingApr: null,
    historicalFundingApr: null,
    nextFundingTime: null,
  } as const;
  const shortLeg = {
    ...longLeg,
    id: "bybit-DOGE-USDT-PERP",
    kind: "perpetual",
    fundingRate: 0.0001,
  } as const;
  const opportunity = {
    id: "op-1",
    longLeg,
    shortLeg,
  } as ArbitrageOpportunity;
  return {
    generatedAt,
    horizonDays: 90,
    markets: [{ ...longLeg, ask }] as ArbitrageDashboardSnapshot["markets"],
    opportunities: [opportunity],
    summary: {
      bestScore: 1,
      bestNetApr: 1,
      eligibleOpportunityCount: 1,
      connectedVenueCount: 1,
      totalVenueCount: 1,
      trackedMarketCount: 2,
      usdcUsdtPrice: 1,
      stablecoinBasisBps: 0,
    },
    warnings: [],
  };
}
