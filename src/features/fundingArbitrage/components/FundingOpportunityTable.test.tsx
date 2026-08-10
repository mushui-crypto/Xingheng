import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FundingOpportunityTable } from "./FundingOpportunityTable";
import type { FundingOpportunityView } from "../model/types";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const now = 1_800_000_000_000;

test("funding opportunity table renders opportunity direction and metrics", () => {
  const html = renderToStaticMarkup(
    <FundingOpportunityTable
      opportunities={[opportunity({
        symbol: "XAUTUSDT",
        longVenue: "okx",
        shortVenue: "binance",
        confidence: "high",
      })]}
    />,
  );

  assert.match(html, /XAUTUSDT/);
  assert.match(html, /OKX/);
  assert.match(html, /Binance/);
  assert.match(html, /\+0\.0500%/);
  assert.match(html, /\+0\.0400%/);
  assert.match(html, />高</);
  assert.doesNotMatch(html, /clientOrderId|ExecutionIntent|OrderManager|quantity/u);
});

test("funding opportunity table renders an empty state", () => {
  const html = renderToStaticMarkup(<FundingOpportunityTable opportunities={[]} />);

  assert.match(html, /当前没有资金费率套利机会/);
});

function opportunity(overrides: Partial<FundingOpportunityView> = {}): FundingOpportunityView {
  return {
    symbol: "XAUTUSDT",
    longVenue: "okx",
    shortVenue: "binance",
    fundingSpread: 0.0005,
    estimatedCost: 0.0001,
    estimatedNetYield: 0.0004,
    confidence: "high",
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}
