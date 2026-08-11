import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalFundingRate,
  CanonicalInstrument,
  CexVenue,
} from "../CexCanonicalModels";
import {
  buildFundingArbitragePlan,
  type FundingArbitragePlanningParameters,
} from "./FundingArbitrageStrategy";

const now = 1_800_000_000_000;
const nextFundingAt = now + 8 * 60 * 60 * 1_000;
const parameters: FundingArbitragePlanningParameters = {
  planId: "plan-1",
  targetBaseQuantity: 0.127,
  minimumFundingSpreadRate: 0.0001,
  maxSnapshotAgeMs: 60_000,
  maxFundingTimeSkewMs: 60_000,
  entryCutoffMs: 5 * 60_000,
  now,
};

test("builds a perpetual/perpetual plan with canonical direction, spread, quantity, and expiry", () => {
  const binance = instrument("binance", "BTC-USDT-PERP");
  const okx = instrument("okx", "BTC-USDT-PERP", {
    quantityUnit: "contract",
    contractSize: 0.01,
    quantityStep: 1,
    minQuantity: 1,
  });
  const plan = buildFundingArbitragePlan(
    [binance, okx],
    [funding(binance, -0.0001, 65_000), funding(okx, 0.0003, 65_010)],
    parameters,
  );

  assert.ok(plan);
  assert.equal(plan.strategyType, "PERPETUAL_PERPETUAL");
  assert.equal(plan.legs[0].role, "long");
  assert.equal(plan.legs[0].venue, "binance");
  assert.equal(plan.legs[1].role, "short");
  assert.equal(plan.legs[1].venue, "okx");
  assert.equal(plan.legs[0].baseQuantity, 0.12);
  assert.equal(plan.legs[1].baseQuantity, 0.12);
  assert.ok(Math.abs(plan.expectedFunding.netRate - 0.0004) < 1e-12);
  assert.equal(plan.expectedFunding.asset, "USDT");
  assert.ok(plan.expectedFunding.amount !== null && plan.expectedFunding.amount > 0);
  assert.ok(Math.abs(plan.details.fundingSpreadRate - 0.0004) < 1e-12);
  assert.equal(plan.details.fundingTimeSkewMs, 0);
  assert.equal(plan.createdAt, now);
  assert.equal(plan.expiresAt, now + 59_000);
  assert.equal(plan.confidence, "high");
});

test("rejects settlement mismatches and stale canonical snapshots", () => {
  const binance = instrument("binance", "BTC-USDT-PERP");
  const bybitUsdc = instrument("bybit", "BTC-USDC-PERP", {
    quoteAsset: "USDC",
    settlementAsset: "USDC",
  });
  assert.equal(buildFundingArbitragePlan(
    [binance, bybitUsdc],
    [funding(binance, -0.0001, 65_000), funding(bybitUsdc, 0.0003, 65_010)],
    parameters,
  ), null);

  const okx = instrument("okx", "BTC-USDT-PERP");
  const staleFunding = { ...funding(okx, 0.0003, 65_010), fetchedAt: now - 60_001 };
  assert.equal(buildFundingArbitragePlan(
    [binance, okx],
    [funding(binance, -0.0001, 65_000), staleFunding],
    parameters,
  ), null);
});

test("rejects funding snapshots outside the configured settlement alignment window", () => {
  const binance = instrument("binance", "BTC-USDT-PERP");
  const bitget = instrument("bitget", "BTC-USDT-PERP");
  const misaligned = {
    ...funding(bitget, 0.0003, 65_010),
    nextFundingAt: nextFundingAt + parameters.maxFundingTimeSkewMs + 1,
  };

  assert.equal(buildFundingArbitragePlan(
    [binance, bitget],
    [funding(binance, -0.0001, 65_000), misaligned],
    parameters,
  ), null);
});

test("keeps expected funding amount nullable when either mark price is unavailable", () => {
  const okx = instrument("okx", "BTC-USDT-PERP");
  const bitget = instrument("bitget", "BTC-USDT-PERP");
  const plan = buildFundingArbitragePlan(
    [okx, bitget],
    [funding(okx, -0.0001, null), funding(bitget, 0.0003, null)],
    parameters,
  );

  assert.ok(plan);
  assert.ok(Math.abs(plan.expectedFunding.netRate - 0.0004) < 1e-12);
  assert.equal(plan.expectedFunding.amount, null);
  assert.equal(plan.expectedFunding.asset, null);
  assert.equal(plan.confidence, "low");
});

test("the strategy output contains no execution-bound fields", () => {
  const binance = instrument("binance", "BTC-USDT-PERP");
  const bybit = instrument("bybit", "BTC-USDT-PERP");
  const plan = buildFundingArbitragePlan(
    [binance, bybit],
    [funding(binance, -0.0001, 65_000), funding(bybit, 0.0003, 65_010)],
    parameters,
  );

  assert.ok(plan);
  const forbiddenFields = new Set([
    "accountId",
    "clientOrderId",
    "limitPrice",
    "slippage",
    "reduceOnly",
    "positionEffect",
    "order",
    "execution",
  ]);
  for (const key of collectKeys(plan)) assert.equal(forbiddenFields.has(key), false, `unexpected field: ${key}`);
});

function instrument(
  venue: CexVenue,
  instrumentId: string,
  overrides: Partial<CanonicalInstrument> = {},
): CanonicalInstrument {
  return {
    instrumentId,
    venue,
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    providerSymbol: venue === "okx" ? "BTC-USDT-SWAP" : "BTCUSDT",
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
  markPrice: number | null,
): CanonicalFundingRate {
  return {
    venue: target.venue,
    instrumentId: target.instrumentId,
    rate,
    intervalHours: 8,
    nextFundingAt,
    markPrice,
    fetchedAt: now - 1_000,
  };
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}
