import assert from "node:assert/strict";
import test from "node:test";
import {
  confidenceLabel,
  filterFundingOpportunities,
  formatRate,
  sortFundingOpportunities,
  venueLabel,
  venueOptions,
} from "./opportunityViews";
import type { FundingOpportunityView } from "../model/types";

const now = 1_800_000_000_000;

test("filters funding opportunities by symbol, confidence, and leg venues", () => {
  const opportunities = [
    opportunity({ symbol: "XAUTUSDT", confidence: "high", longVenue: "okx", shortVenue: "binance" }),
    opportunity({ symbol: "BTCUSDT", confidence: "medium", longVenue: "bitget", shortVenue: "bybit" }),
  ];

  assert.deepEqual(filterFundingOpportunities(opportunities, {
    symbol: "xaut",
    confidence: "high",
    longVenue: "okx",
    shortVenue: "binance",
  }).map((item) => item.symbol), ["XAUTUSDT"]);
  assert.deepEqual(filterFundingOpportunities(opportunities, {
    symbol: "",
    confidence: "all",
    longVenue: "all",
    shortVenue: "bybit",
  }).map((item) => item.symbol), ["BTCUSDT"]);
});

test("sorts funding opportunities by net yield, confidence, and expiry", () => {
  const opportunities = [
    opportunity({ symbol: "BTCUSDT", confidence: "low", estimatedNetYield: 0.0002, expiresAt: now + 90_000 }),
    opportunity({ symbol: "ETHUSDT", confidence: "high", estimatedNetYield: 0.0003, expiresAt: now + 120_000 }),
    opportunity({ symbol: "XAUTUSDT", confidence: "medium", estimatedNetYield: 0.0006, expiresAt: now + 30_000 }),
  ];

  assert.deepEqual(sortFundingOpportunities(opportunities, "estimatedNetYield").map((item) => item.symbol), ["XAUTUSDT", "ETHUSDT", "BTCUSDT"]);
  assert.deepEqual(sortFundingOpportunities(opportunities, "confidence").map((item) => item.symbol), ["ETHUSDT", "XAUTUSDT", "BTCUSDT"]);
  assert.deepEqual(sortFundingOpportunities(opportunities, "expiresAt").map((item) => item.symbol), ["XAUTUSDT", "BTCUSDT", "ETHUSDT"]);
});

test("formats display labels without changing opportunity data", () => {
  const opportunities = [
    opportunity({ longVenue: "okx", shortVenue: "binance" }),
    opportunity({ longVenue: "bitget", shortVenue: "bybit" }),
  ];

  assert.deepEqual([...venueOptions(opportunities, "long")], ["okx", "bitget"]);
  assert.equal(venueLabel("okx"), "OKX");
  assert.equal(confidenceLabel("medium"), "中");
  assert.equal(formatRate(0.000456, true), "+0.0456%");
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
