import assert from "node:assert/strict";
import test from "node:test";
import {
  FundingOpportunityQueryService,
  toOpportunityView,
} from "./FundingOpportunityQueryService";
import type { FundingSpreadPlan } from "./FundingSpreadPlan";

const now = 1_800_000_000_000;

test("converts FundingSpreadPlan into the public opportunity view without execution fields", () => {
  const view = toOpportunityView(plan({ symbol: "XAUTUSDT", confidence: "high" }));

  assert.deepEqual(view, {
    symbol: "XAUTUSDT",
    longVenue: "okx",
    shortVenue: "binance",
    fundingSpread: 0.0005,
    estimatedCost: 0.0001,
    estimatedNetYield: 0.0004,
    confidence: "high",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  for (const key of collectKeys(view)) {
    assert.equal(forbiddenViewFields.has(key), false, `unexpected public opportunity field: ${key}`);
  }
});

test("sorts opportunities by net yield, confidence, and expiry", async () => {
  const service = new FundingOpportunityQueryService(async () => [
    plan({ symbol: "BTCUSDT", confidence: "low", estimatedNetYield: 0.0002, expiresAt: now + 90_000 }),
    plan({ symbol: "ETHUSDT", confidence: "high", estimatedNetYield: 0.0003, expiresAt: now + 120_000 }),
    plan({ symbol: "XAUTUSDT", confidence: "medium", estimatedNetYield: 0.0006, expiresAt: now + 30_000 }),
  ], () => now);

  assert.deepEqual((await service.list()).opportunities.map((item) => item.symbol), ["XAUTUSDT", "ETHUSDT", "BTCUSDT"]);
  assert.deepEqual((await service.list({ sort: "confidence" })).opportunities.map((item) => item.symbol), ["ETHUSDT", "XAUTUSDT", "BTCUSDT"]);
  assert.deepEqual((await service.list({ sort: "expiresAt" })).opportunities.map((item) => item.symbol), ["XAUTUSDT", "BTCUSDT", "ETHUSDT"]);
});

test("filters by symbol and confidence while preserving display confidence", async () => {
  const service = new FundingOpportunityQueryService(async () => [
    plan({ symbol: "XAUTUSDT", confidence: "high", estimatedNetYield: 0.0004 }),
    plan({ symbol: "XAUTUSDT", confidence: "medium", estimatedNetYield: 0.0003 }),
    plan({ symbol: "BTCUSDT", confidence: "high", estimatedNetYield: 0.0002 }),
  ], () => now);

  const snapshot = await service.list({ symbol: "xautusdt", confidence: "high" });

  assert.equal(snapshot.generatedAt, now);
  assert.deepEqual(snapshot.opportunities.map((item) => item.symbol), ["XAUTUSDT"]);
  assert.equal(snapshot.opportunities[0]?.confidence, "high");
});

test("empty source returns an empty opportunity list", async () => {
  const service = new FundingOpportunityQueryService(async () => [], () => now);

  assert.deepEqual(await service.list(), { generatedAt: now, opportunities: [] });
});

const forbiddenViewFields = new Set([
  "accountId",
  "baseQuantity",
  "clientOrderId",
  "limitPrice",
  "order",
  "orderId",
  "positionEffect",
  "quantity",
  "reduceOnly",
]);

function plan(overrides: Partial<FundingSpreadPlan> = {}): FundingSpreadPlan {
  return {
    strategyType: "PERPETUAL_PERPETUAL",
    symbol: "XAUTUSDT",
    longVenue: "okx",
    shortVenue: "binance",
    longInstrumentId: "okx:perpetual:linear:XAUT:USDT:USDT",
    shortInstrumentId: "binance:perpetual:linear:XAUT:USDT:USDT",
    longFundingRate: -0.0002,
    shortFundingRate: 0.0003,
    fundingSpread: 0.0005,
    estimatedCost: 0.0001,
    estimatedNetYield: 0.0004,
    confidence: "high",
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}
