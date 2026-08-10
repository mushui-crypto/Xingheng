import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  CanonicalFundingRate,
  CanonicalInstrument,
  CanonicalTopOfBook,
  CexVenue,
} from "../CexCanonicalModels";
import {
  evaluateBestFundingSpreadOpportunity,
  evaluateFundingSpreadOpportunities,
  type FundingOpportunityEvaluationParameters,
} from "./FundingOpportunityEvaluator";

const now = 1_800_000_000_000;
const nextFundingAt = now + 8 * 60 * 60 * 1_000;
const parameters: FundingOpportunityEvaluationParameters = {
  minimumNetYield: 0,
  maxSnapshotAgeMs: 60_000,
  maxFundingTimeSkewMs: 60_000,
  entryCutoffMs: 5 * 60_000,
  takerFeeRateByVenue: {},
  now,
};

test("calculates a positive funding spread using canonical long-low and short-high direction", () => {
  const binance = instrument("binance");
  const okx = instrument("okx");
  const plan = evaluateBestFundingSpreadOpportunity(
    [binance, okx],
    [funding(binance, -0.0002), funding(okx, 0.0003)],
    [topOfBook(binance), topOfBook(okx)],
    parameters,
  );

  assert.ok(plan);
  assert.equal(plan.strategyType, "PERPETUAL_PERPETUAL");
  assert.equal(plan.symbol, "BTCUSDT");
  assert.equal(plan.longVenue, "binance");
  assert.equal(plan.shortVenue, "okx");
  assert.equal(plan.longFundingRate, -0.0002);
  assert.equal(plan.shortFundingRate, 0.0003);
  assert.equal(plan.fundingSpread, 0.0005);
  assert.equal(plan.estimatedCost, 0);
  assert.equal(plan.estimatedNetYield, 0.0005);
  assert.equal(plan.createdAt, now);
  assert.equal(plan.expiresAt, now + 59_000);
  assert.equal(plan.confidence, "high");
});

test("normalizes a raw negative venue-to-venue difference by flipping long and short venues", () => {
  const binance = instrument("binance");
  const bybit = instrument("bybit");
  const plan = evaluateBestFundingSpreadOpportunity(
    [binance, bybit],
    [funding(binance, 0.0003), funding(bybit, -0.0001)],
    [topOfBook(binance), topOfBook(bybit)],
    parameters,
  );

  assert.ok(plan);
  assert.equal(plan.longVenue, "bybit");
  assert.equal(plan.shortVenue, "binance");
  assert.equal(plan.fundingSpread, 0.0004);
  assert.equal(plan.estimatedNetYield, 0.0004);
});

test("does not emit an opportunity when funding rates are equal after cost", () => {
  const bitget = instrument("bitget");
  const okx = instrument("okx");

  assert.equal(evaluateBestFundingSpreadOpportunity(
    [bitget, okx],
    [funding(bitget, 0.0001), funding(okx, 0.0001)],
    [topOfBook(bitget), topOfBook(okx)],
    { ...parameters, minimumNetYield: 0.000000001 },
  ), null);
});

test("deducts bid/ask spread impact and fee placeholders from estimated net yield", () => {
  const okx = instrument("okx");
  const bitget = instrument("bitget");
  const plan = evaluateBestFundingSpreadOpportunity(
    [okx, bitget],
    [funding(okx, -0.0001), funding(bitget, 0.0006)],
    [
      topOfBook(okx, { bid: 99.95, ask: 100.05 }),
      topOfBook(bitget, { bid: 199.8, ask: 200.2 }),
    ],
    {
      ...parameters,
      minimumNetYield: -0.01,
      takerFeeRateByVenue: { okx: 0.0001, bitget: 0.0002 },
    },
  );

  assert.ok(plan);
  assert.equal(plan.fundingSpread, 0.0007);
  assert.equal(plan.estimatedCost, 0.0018);
  assert.equal(plan.estimatedNetYield, -0.0011);
  assert.equal(plan.confidence, "low");
});

test("sorts multi-venue perpetual opportunities by estimated net yield across Binance, OKX, Bybit, and Bitget", () => {
  const instruments = [
    instrument("binance"),
    instrument("okx"),
    instrument("bybit"),
    instrument("bitget"),
  ];
  const opportunities = evaluateFundingSpreadOpportunities(
    instruments,
    [
      funding(instruments[0]!, -0.0001),
      funding(instruments[1]!, 0.0002),
      funding(instruments[2]!, 0.0004),
      funding(instruments[3]!, -0.0003),
    ],
    instruments.map((entry) => topOfBook(entry)),
    { ...parameters, minimumNetYield: 0.0001 },
  );

  assert.equal(opportunities.length, 6);
  assert.equal(opportunities[0]?.longVenue, "bitget");
  assert.equal(opportunities[0]?.shortVenue, "bybit");
  assert.equal(opportunities[0]?.fundingSpread, 0.0007);
  assert.deepEqual(
    new Set(opportunities.flatMap((plan) => [plan.longVenue, plan.shortVenue])),
    new Set<CexVenue>(["binance", "okx", "bybit", "bitget"]),
  );
});

test("ignores stale, mismatched, or misaligned canonical snapshots", () => {
  const binance = instrument("binance");
  const okx = instrument("okx");
  const bybitUsdc = instrument("bybit", { quoteAsset: "USDC", settlementAsset: "USDC" });

  assert.equal(evaluateBestFundingSpreadOpportunity(
    [binance, bybitUsdc],
    [funding(binance, -0.0001), funding(bybitUsdc, 0.0003)],
    [topOfBook(binance), topOfBook(bybitUsdc)],
    parameters,
  ), null);

  assert.equal(evaluateBestFundingSpreadOpportunity(
    [binance, okx],
    [funding(binance, -0.0001), funding(okx, 0.0003)],
    [topOfBook(binance), topOfBook(okx, { fetchedAt: now - 60_001 })],
    parameters,
  ), null);

  assert.equal(evaluateBestFundingSpreadOpportunity(
    [binance, okx],
    [
      funding(binance, -0.0001),
      funding(okx, 0.0003, { nextFundingAt: nextFundingAt + parameters.maxFundingTimeSkewMs + 1 }),
    ],
    [topOfBook(binance), topOfBook(okx)],
    parameters,
  ), null);
});

test("boundary stays canonical-read only and output contains no execution fields", () => {
  const source = readFileSync(new URL("./FundingOpportunityEvaluator.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /BinanceClient|OrderManager|RiskGuard|ExecutionIntent/iu);
  assert.doesNotMatch(source, /placeOrder|cancelOrder|clientOrderId|orderId|accountId/iu);

  const binance = instrument("binance");
  const okx = instrument("okx");
  const plan = evaluateBestFundingSpreadOpportunity(
    [binance, okx],
    [funding(binance, -0.0001), funding(okx, 0.0003)],
    [topOfBook(binance), topOfBook(okx)],
    parameters,
  );

  assert.ok(plan);
  const forbiddenFields = new Set([
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
  for (const key of collectKeys(plan)) assert.equal(forbiddenFields.has(key), false, `unexpected field: ${key}`);
});

function instrument(venue: CexVenue, overrides: Partial<CanonicalInstrument> = {}): CanonicalInstrument {
  const baseAsset = overrides.baseAsset ?? "BTC";
  const quoteAsset = overrides.quoteAsset ?? "USDT";
  const settlementAsset = overrides.settlementAsset ?? quoteAsset;
  return {
    instrumentId: `${venue}:perpetual:linear:${baseAsset}:${quoteAsset}:${settlementAsset}`,
    venue,
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset,
    quoteAsset,
    settlementAsset,
    providerSymbol: venue === "okx" ? `${baseAsset}-${quoteAsset}-SWAP` : `${baseAsset}${quoteAsset}`,
    providerLocator: {},
    quantityUnit: "base",
    contractSize: 1,
    priceTick: 0.1,
    quantityStep: 0.001,
    minQuantity: 0.001,
    minNotional: 5,
    status: "trading",
    fetchedAt: now - 1_000,
    ...overrides,
  };
}

function funding(
  target: CanonicalInstrument,
  rate: number,
  overrides: Partial<CanonicalFundingRate> = {},
): CanonicalFundingRate {
  return {
    venue: target.venue,
    instrumentId: target.instrumentId,
    rate,
    intervalHours: 8,
    nextFundingAt,
    markPrice: null,
    fetchedAt: now - 1_000,
    ...overrides,
  };
}

function topOfBook(
  target: CanonicalInstrument,
  overrides: Partial<CanonicalTopOfBook> = {},
): CanonicalTopOfBook {
  return {
    venue: target.venue,
    instrumentId: target.instrumentId,
    bid: 100,
    ask: 100,
    markPrice: null,
    depthUsd: null,
    fetchedAt: now - 1_000,
    ...overrides,
  };
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}
