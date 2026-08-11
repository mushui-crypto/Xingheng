import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  FundingRatePort,
  InstrumentCatalogPort,
  MarketDataPort,
} from "../CexCapabilityPorts";
import type {
  CanonicalFundingRate,
  CanonicalInstrument,
  CanonicalTopOfBook,
  CexVenue,
} from "../CexCanonicalModels";
import { CanonicalFundingOpportunitySource, type FundingOpportunityReadVenue } from "./CanonicalFundingOpportunitySource";

const now = 1_800_000_000_000;
const parameters = {
  minimumNetYield: 0,
  maxSnapshotAgeMs: 30_000,
  maxFundingTimeSkewMs: 5 * 60_000,
  entryCutoffMs: 5 * 60_000,
};

test("assembles canonical read data and evaluates FundingSpreadPlan", async () => {
  const source = new CanonicalFundingOpportunitySource({
    venues: [
      venue("okx", { fundingRate: -0.0001, bid: 4_300, ask: 4_300.2 }),
      venue("binance", { fundingRate: 0.0003, bid: 4_300.5, ask: 4_300.7 }),
      venue("bybit", { fundingRate: 0.00005, bid: 4_299.9, ask: 4_300.1, baseAsset: "ETH" }),
    ],
    parameters,
    now: () => now,
    symbols: ["XAUTUSDT"],
  });

  const plans = await source.getOpportunities();

  assert.equal(plans.length, 1);
  const plan = plans[0]!;
  assert.equal(plan.strategyType, "PERPETUAL_PERPETUAL");
  assert.equal(plan.symbol, "XAUTUSDT");
  assert.equal(plan.longVenue, "okx");
  assert.equal(plan.shortVenue, "binance");
  assert.equal(plan.longInstrumentId, "XAUT-USDT-PERP");
  assert.equal(plan.shortInstrumentId, "XAUT-USDT-PERP");
  assert.equal(plan.longFundingRate, -0.0001);
  assert.equal(plan.shortFundingRate, 0.0003);
  assert.equal(plan.fundingSpread, 0.0004);
  assert.equal(plan.confidence, "high");
  assert.equal(plan.createdAt, now);
  assert.equal(plan.expiresAt, now + parameters.maxSnapshotAgeMs);
  assert.equal(plan.estimatedCost > 0, true);
  assert.equal(plan.estimatedNetYield > 0, true);
});

test("missing catalog, funding, or market data does not fabricate opportunities", async () => {
  const source = new CanonicalFundingOpportunitySource({
    venues: [
      venue("okx", { fundingRate: -0.0001, failMarketData: true }),
      venue("binance", { fundingRate: 0.0003 }),
      venue("bitget", { fundingRate: 0.0002, failCatalog: true }),
    ],
    parameters,
    now: () => now,
    symbols: ["XAUTUSDT"],
  });

  assert.deepEqual(await source.getOpportunities(), []);
});

test("source boundary remains read-only and independent from execution components", () => {
  const source = readFileSync(new URL("./CanonicalFundingOpportunitySource.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /placeOrder|cancelOrder|transfer|withdrawal|ExecutionIntent|OrderManager|RiskGuard/u);
  assert.doesNotMatch(source, /BinanceClient|BinanceOrderManager|BinanceRiskGuard|CapitalTestRuntime/u);
});

function venue(
  venueName: CexVenue,
  options: {
    fundingRate: number;
    bid?: number;
    ask?: number;
    baseAsset?: string;
    failCatalog?: boolean;
    failFunding?: boolean;
    failMarketData?: boolean;
  },
): FundingOpportunityReadVenue {
  const instrument = canonicalInstrument(venueName, options.baseAsset ?? "XAUT");
  const catalog: InstrumentCatalogPort = {
    venue: venueName,
    getInstrument: async () => instrument,
    listInstruments: async () => {
      if (options.failCatalog) throw new Error("catalog unavailable");
      return [instrument];
    },
  };
  const fundingRate: FundingRatePort = {
    venue: venueName,
    getFundingRate: async () => {
      if (options.failFunding) throw new Error("funding unavailable");
      return canonicalFundingRate(instrument, options.fundingRate);
    },
  };
  const marketData: MarketDataPort = {
    venue: venueName,
    getTopOfBook: async () => {
      if (options.failMarketData) throw new Error("ticker unavailable");
      return canonicalTopOfBook(instrument, options.bid ?? 4_300, options.ask ?? 4_300.2);
    },
  };
  return { venue: venueName, instrumentCatalog: catalog, fundingRate, marketData };
}

function canonicalInstrument(venueName: CexVenue, baseAsset: string): CanonicalInstrument {
  return {
    instrumentId: `${baseAsset}-USDT-PERP`,
    venue: venueName,
    marketType: "perpetual",
    contractType: "linear_perpetual",
    baseAsset,
    quoteAsset: "USDT",
    settlementAsset: "USDT",
    providerSymbol: `${baseAsset}USDT`,
    providerLocator: {},
    quantityUnit: "base",
    contractSize: 1,
    priceTick: 0.01,
    quantityStep: 0.001,
    minQuantity: 0.001,
    minNotional: 5,
    status: "trading",
    fetchedAt: now,
  };
}

function canonicalFundingRate(instrument: CanonicalInstrument, rate: number): CanonicalFundingRate {
  return {
    venue: instrument.venue,
    instrumentId: instrument.instrumentId,
    rate,
    intervalHours: 8,
    nextFundingAt: now + 8 * 60 * 60_000,
    markPrice: null,
    fetchedAt: now,
  };
}

function canonicalTopOfBook(instrument: CanonicalInstrument, bid: number, ask: number): CanonicalTopOfBook {
  return {
    venue: instrument.venue,
    instrumentId: instrument.instrumentId,
    bid,
    ask,
    markPrice: null,
    depthUsd: null,
    fetchedAt: now,
  };
}
