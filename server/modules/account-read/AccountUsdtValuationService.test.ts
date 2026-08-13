import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageMarket } from "../arbitrage/arbitrageTypes";
import type { ExchangeVenue } from "../credentials/CredentialKeyProvider";
import {
  AccountUsdtValuationService,
  ArbitrageDashboardUsdtSpotPriceSource,
} from "./AccountUsdtValuationService";

const now = 1_800_000_000_000;

test("values USDT directly and other assets from real spot references", async () => {
  const valuation = new AccountUsdtValuationService({
    loadPrices: async () => new Map([["BTC", 60_000]]),
  });
  const input = accountSnapshot("binance", [
    { asset: "USDT", accountType: "spot", total: 120, available: 100, locked: 20 },
    { asset: "BTC", accountType: "spot", total: 0.002, available: 0.001, locked: 0.001 },
    { asset: "MISSING", accountType: "spot", total: 5, available: 5, locked: 0 },
  ]);

  const result = await valuation.value(input);

  assert.deepEqual(result.balances.map(({ asset, estimatedValueUsdt, valuationStatus }) => ({
    asset,
    estimatedValueUsdt,
    valuationStatus,
  })), [
    { asset: "USDT", estimatedValueUsdt: 120, valuationStatus: "VALUED" },
    { asset: "BTC", estimatedValueUsdt: 120, valuationStatus: "VALUED" },
    { asset: "MISSING", estimatedValueUsdt: null, valuationStatus: "UNAVAILABLE" },
  ]);
  assert.equal(result.estimatedTotalValueUsdt, 240);
  assert.equal(result.valuationCoverage, "PARTIAL");
  assert.deepEqual(result.balances.map(({ asset, accountType, total, available, locked }) => ({
    asset,
    accountType,
    total,
    available,
    locked,
  })), input.balances);
});

test("a public price failure does not fail account read or invent non-USDT prices", async () => {
  const valuation = new AccountUsdtValuationService({
    loadPrices: async () => { throw new Error("public market unavailable"); },
  });
  const result = await valuation.value(accountSnapshot("okx", [
    { asset: "USDT", accountType: "unified", total: 20, available: 20, locked: 0 },
    { asset: "BTC", accountType: "unified", total: 1, available: 1, locked: 0 },
  ]));

  assert.equal(result.balances[0]?.estimatedValueUsdt, 20);
  assert.equal(result.balances[1]?.estimatedValueUsdt, null);
  assert.equal(result.estimatedTotalValueUsdt, 20);
  assert.equal(result.valuationCoverage, "PARTIAL");
});

test("an account with no reliable prices remains unavailable", async () => {
  const valuation = new AccountUsdtValuationService({ loadPrices: async () => new Map() });
  const result = await valuation.value(accountSnapshot("bybit", [
    { asset: "UNKNOWN", accountType: "unified", total: 3, available: null, locked: 1 },
  ]));

  assert.equal(result.balances[0]?.estimatedValueUsdt, null);
  assert.equal(result.estimatedTotalValueUsdt, null);
  assert.equal(result.valuationCoverage, "UNAVAILABLE");
});

test("valuation preserves original balances for all account-read venues", async (t) => {
  for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
    await t.test(venue, async () => {
      const balance = { asset: "BTC", accountType: "unified" as const, total: 2, available: null, locked: 0.5 };
      const valuation = new AccountUsdtValuationService({ loadPrices: async () => new Map([["BTC", 50_000]]) });
      const result = await valuation.value(accountSnapshot(venue, [balance]));
      assert.deepEqual(
        (({ asset, accountType, total, available, locked }) => ({ asset, accountType, total, available, locked }))(result.balances[0]!),
        balance,
      );
    });
  }
});

test("dashboard spot prices prefer the account venue and fall back across venues", async () => {
  const markets = [
    spotMarket("binance", "BTC", 59_000, 59_100),
    spotMarket("bybit", "BTC", 60_000, 60_100),
    spotMarket("binance", "ETH", 3_000, 3_010),
  ];
  const source = new ArbitrageDashboardUsdtSpotPriceSource({
    getSnapshot: async () => ({ markets }) as never,
  }, () => now);

  const preferred = await source.loadPrices(["BTC"], "bybit");
  const fallback = await source.loadPrices(["ETH"], "okx");

  assert.equal(preferred.get("BTC"), 60_050);
  assert.equal(fallback.get("ETH"), 3_005);
});

function accountSnapshot(
  venue: ExchangeVenue,
  balances: Array<{ asset: string; accountType: "spot" | "unified"; total: number; available: number | null; locked: number | null }>,
) {
  return {
    venue,
    accountId: `${venue}:fixture`,
    accountFingerprint: "fixture",
    uidHash: null,
    accountTypes: ["unified" as const],
    accountMode: "unified",
    connection: { status: "connected" as const, checkedAt: now },
    credentialValidation: { status: "validated" as const, checkedAt: now },
    balances,
    permissions: {
      read: "UNKNOWN" as const,
      spotTrade: "UNKNOWN" as const,
      derivativesTrade: "UNKNOWN" as const,
      withdraw: "UNKNOWN" as const,
      ipRestricted: "UNKNOWN" as const,
    },
    capabilities: {
      spotAccount: "UNKNOWN" as const,
      derivativesAccount: "UNKNOWN" as const,
      positionModeSupported: "UNKNOWN" as const,
    },
    latestSyncAt: now,
  };
}

function spotMarket(
  venue: Extract<ArbitrageMarket["venue"], "binance" | "bybit">,
  asset: ArbitrageMarket["asset"],
  bid: number,
  ask: number,
): ArbitrageMarket {
  return {
    id: `${venue}-${asset.toLowerCase()}-spot`,
    venue,
    venueLabel: venue,
    symbol: `${asset}USDT`,
    asset,
    kind: "spot",
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    bid,
    ask,
    markPrice: (bid + ask) / 2,
    indexPrice: (bid + ask) / 2,
    spreadBps: null,
    fundingRate: null,
    fundingIntervalHours: null,
    currentFundingApr: 0,
    historicalFundingApr: 0,
    fundingPositiveRatio: null,
    fundingCoverageRatio: 1,
    slippageBps10k: null,
    slippageBps100k: null,
    depthUsd: null,
    volume24h: null,
    openInterest: null,
    nextFundingTime: null,
    takerFeeBps: 10,
    status: "connected",
    fetchedAt: now,
    warnings: [],
  };
}
