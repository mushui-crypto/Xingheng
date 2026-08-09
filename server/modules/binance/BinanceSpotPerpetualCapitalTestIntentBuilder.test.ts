import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalInstrument } from "../cex/CexCanonicalModels";
import type { SpotPerpetualFundingArbitragePlan } from "../cex/funding-arbitrage/FundingArbitragePlan";
import {
  buildBinanceSpotPerpetualCapitalTestIntent,
  type BinanceSpotPerpetualCapitalTestIntentBuildParameters,
} from "./BinanceSpotPerpetualCapitalTestIntentBuilder";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
  toCanonicalBinanceInstruments,
} from "./BinanceInstrumentCatalog";
import { snapshotFixture } from "./binanceTestFixtures";

const now = 1_800_000_000_000;
const instruments = toCanonicalBinanceInstruments(snapshotFixture());
const parameters: BinanceSpotPerpetualCapitalTestIntentBuildParameters = {
  now,
  quantities: { spotBaseQuantity: "0.0100", perpetualBaseQuantity: "0.01" },
  maxResidualBaseQuantity: "0.001000",
  maxLegStartSkewMs: 500,
  identityFactory: (identity) => `capital-test-${identity}`,
};

test("builds the Binance XAUT/USDT spot-long and perpetual-short execution intent", () => {
  const decision = decisionFixture();
  const intent = buildBinanceSpotPerpetualCapitalTestIntent(instruments, decision, parameters);

  assert.equal(intent.intentId, "capital-test-intent");
  assert.equal(intent.sourcePlanId, decision.planId);
  assert.equal(intent.strategyType, "SPOT_PERPETUAL");
  assert.equal(intent.objective, "ESTABLISH_HEDGE");
  assert.equal(intent.createdAt, now);
  assert.equal(intent.expiresAt, decision.expiresAt);
  assert.deepEqual(intent.constraints, {
    maxResidualBaseQuantity: "0.001",
    maxLegStartSkewMs: 500,
  });
  assert.deepEqual(intent.legs, [
    {
      legId: "capital-test-spot-leg",
      role: "long",
      venue: "binance",
      instrumentId: BINANCE_SPOT_INSTRUMENT_ID,
      marketType: "spot",
      targetDeltaBaseQuantity: "0.01",
    },
    {
      legId: "capital-test-perpetual-leg",
      role: "short",
      venue: "binance",
      instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
      marketType: "perpetual",
      targetDeltaBaseQuantity: "0.01",
    },
  ]);
  assert.equal(collectKeys(intent).includes("providerSymbol"), false);
  assert.equal(collectKeys(intent).includes("providerLocator"), false);
});

test("rejects a strategy decision with reversed spot/perpetual direction", () => {
  const decision = decisionFixture();
  const reversed = {
    ...decision,
    legs: [
      { ...decision.legs[0], role: "short" },
      { ...decision.legs[1], role: "long" },
    ],
  } as unknown as SpotPerpetualFundingArbitragePlan;

  assert.throws(
    () => buildBinanceSpotPerpetualCapitalTestIntent(instruments, reversed, parameters),
    /spot-long and perpetual-short/u,
  );
});

test("rejects mismatched spot and perpetual quantities", () => {
  assert.throws(
    () => buildBinanceSpotPerpetualCapitalTestIntent(instruments, decisionFixture(), {
      ...parameters,
      quantities: { spotBaseQuantity: "0.01", perpetualBaseQuantity: "0.02" },
    }),
    /quantities must match/u,
  );

  const decision = decisionFixture();
  const driftedDecision = {
    ...decision,
    legs: [decision.legs[0], { ...decision.legs[1], baseQuantity: 0.02 }],
  } as SpotPerpetualFundingArbitragePlan;
  assert.throws(
    () => buildBinanceSpotPerpetualCapitalTestIntent(instruments, driftedDecision, parameters),
    /approved strategy decision/u,
  );
});

test("rejects mismatched canonical and strategy instrument identity", () => {
  const wrongCanonical = instruments.map((instrument) => instrument.marketType === "spot"
    ? { ...instrument, baseAsset: "BTC" }
    : instrument) as CanonicalInstrument[];
  assert.throws(
    () => buildBinanceSpotPerpetualCapitalTestIntent(wrongCanonical, decisionFixture(), parameters),
    /canonical XAUT\/USDT/u,
  );

  const decision = decisionFixture();
  const wrongDecision = {
    ...decision,
    legs: [decision.legs[0], { ...decision.legs[1], instrumentId: "binance:perpetual:linear:BTC:USDT:USDT" }],
  } as SpotPerpetualFundingArbitragePlan;
  assert.throws(
    () => buildBinanceSpotPerpetualCapitalTestIntent(instruments, wrongDecision, parameters),
    /spot-long and perpetual-short/u,
  );
});

test("rejects expired decisions and invalid intent expiry", () => {
  const decision = decisionFixture();
  assert.throws(
    () => buildBinanceSpotPerpetualCapitalTestIntent(instruments, decision, {
      ...parameters,
      now: decision.expiresAt,
    }),
    /expired/u,
  );
  assert.throws(
    () => buildBinanceSpotPerpetualCapitalTestIntent(instruments, decision, {
      ...parameters,
      expiresAt: decision.expiresAt + 1,
    }),
    /cannot exceed/u,
  );
});

function decisionFixture(): SpotPerpetualFundingArbitragePlan {
  const fundingAt = now + 8 * 60 * 60 * 1_000;
  return {
    planId: "plan-binance-capital-test",
    strategyType: "SPOT_PERPETUAL",
    instrument: { baseAsset: "XAUT", quoteAsset: "USDT", settlementAsset: "USDT" },
    legs: [
      {
        role: "long",
        venue: "binance",
        instrumentId: BINANCE_SPOT_INSTRUMENT_ID,
        marketType: "spot",
        baseQuantity: 0.01,
        fundingSnapshot: null,
      },
      {
        role: "short",
        venue: "binance",
        instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
        marketType: "perpetual",
        baseQuantity: 0.01,
        fundingSnapshot: {
          venue: "binance",
          instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
          rate: 0.0001,
          intervalHours: 8,
          nextFundingAt: fundingAt,
          markPrice: 1_000,
          fetchedAt: now - 1_000,
        },
      },
    ],
    expectedFunding: { netRate: 0.0001, amount: 0.001, asset: "USDT", fundingAt },
    confidence: "high",
    details: { perpetualFundingRate: 0.0001, entryBasisBps: 5 },
    createdAt: now - 1_000,
    expiresAt: now + 60_000,
  };
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}
