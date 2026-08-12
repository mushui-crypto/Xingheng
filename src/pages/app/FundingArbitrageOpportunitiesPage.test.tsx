import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  ArbitrageAnalysisEmptyState,
  FundingArbitrageOpportunitiesPage,
} from "./FundingArbitrageOpportunitiesPage";

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
