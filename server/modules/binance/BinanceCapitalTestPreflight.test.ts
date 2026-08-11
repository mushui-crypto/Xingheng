import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SpotPerpetualFundingArbitrageExecutionIntent } from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import {
  preflightBinanceCapitalTest,
  type BinanceCapitalTestExecutionContext,
} from "./BinanceCapitalTestPreflight";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
} from "./BinanceInstrumentCatalog";
import { snapshotFixture } from "./binanceTestFixtures";

const now = 1_800_000_000_000;
const context: BinanceCapitalTestExecutionContext = {
  userId: "capital-test-user",
  accountId: "binance:test",
  venue: "binance",
};

test("passes a valid user-bound Binance spot/perpetual capital test intent", () => {
  assert.deepEqual(
    preflightBinanceCapitalTest(context, intentFixture(), snapshotFixture({ accountId: context.accountId }), now, 20),
    { status: "PASS" },
  );
});

test("rejects an expired intent", () => {
  const intent = intentFixture({ expiresAt: now });
  assertFail(intent, snapshotFixture(), "INTENT_EXPIRED");
});

test("rejects invalid decimal quantity", () => {
  const intent = intentFixture();
  const invalid = {
    ...intent,
    legs: [{ ...intent.legs[0], targetDeltaBaseQuantity: "1e-2" }, intent.legs[1]],
  } as SpotPerpetualFundingArbitrageExecutionIntent;
  assertFail(invalid, snapshotFixture(), "QUANTITY_INVALID");
});

test("rejects an unsupported Binance instrument", () => {
  const intent = intentFixture();
  const unsupported = {
    ...intent,
    legs: [{ ...intent.legs[0], instrumentId: "BTC-USDT-SPOT" }, intent.legs[1]],
  } as SpotPerpetualFundingArbitrageExecutionIntent;
  assertFail(unsupported, snapshotFixture(), "INSTRUMENT_UNSUPPORTED");
});

test("accepts untradeable spot dust and records evidence", () => {
  const result = preflightBinanceCapitalTest(
    context,
    intentFixture(),
    snapshotFixture({
      accountId: context.accountId,
      existingSpotQuantityXaut: 0.0005,
      spotFreeXaut: 0.0005,
      spotAvailableQuantityXaut: 0.0005,
    }),
    now,
    20,
  );
  assert.deepEqual(result, {
    status: "PASS",
    dustEvidence: {
      classification: "untradeable_spot_dust",
      quantityXaut: 0.0005,
      referencePriceUsd: 999,
      notionalUsd: 0.4995,
      venueMinQuantityXaut: 0.001,
      venueMinNotionalUsd: 5,
    },
  });
});

test("rejects tradable spot residual", () => {
  assertFail(
    intentFixture(),
    snapshotFixture({ existingSpotQuantityXaut: 0.01, spotFreeXaut: 0.01 }),
    "EXISTING_EXPOSURE",
  );
});

test("rejects non-zero perpetual exposure", () => {
  assertFail(
    intentFixture(),
    snapshotFixture({ existingPerpetualQuantityXaut: 0.001, perpetualPositionSide: "short" }),
    "EXISTING_EXPOSURE",
  );
  assertFail(
    intentFixture(),
    snapshotFixture({ existingPerpetualQuantityXaut: -0.001, perpetualPositionSide: "short" }),
    "EXISTING_EXPOSURE",
  );
});

test("requires one-way position mode, 1x leverage, and confirmed margin mode", () => {
  assertFail(intentFixture(), snapshotFixture({ accountMode: "single_asset_hedge" }), "POSITION_MODE_INVALID");
  assertFail(
    intentFixture(),
    snapshotFixture({ permissions: { ...snapshotFixture().permissions, positionModeSupported: false } }),
    "POSITION_MODE_INVALID",
  );
  assertFail(
    intentFixture(),
    snapshotFixture({ perpetual: { ...snapshotFixture().perpetual, leverage: 2 } }),
    "LEVERAGE_INVALID",
  );
  assertFail(
    intentFixture(),
    snapshotFixture({ perpetual: { ...snapshotFixture().perpetual, marginMode: "unknown" } }),
    "MARGIN_MODE_UNCONFIRMED",
  );
});

test("rejects existing open orders", () => {
  assertFail(intentFixture(), snapshotFixture({ openPerpetualOrderCount: 1 }), "OPEN_ORDERS");
});

test("checks quantity steps, minimum notional, account binding, and execution constraints", () => {
  const intent = intentFixture();
  const offStep = {
    ...intent,
    legs: [
      { ...intent.legs[0], targetDeltaBaseQuantity: "0.0105" },
      { ...intent.legs[1], targetDeltaBaseQuantity: "0.0105" },
    ],
  } as SpotPerpetualFundingArbitrageExecutionIntent;
  assertFail(offStep, snapshotFixture(), "QUANTITY_STEP_INVALID");

  const tooSmall = {
    ...intent,
    legs: [
      { ...intent.legs[0], targetDeltaBaseQuantity: "0.001" },
      { ...intent.legs[1], targetDeltaBaseQuantity: "0.001" },
    ],
  } as SpotPerpetualFundingArbitrageExecutionIntent;
  assertFail(tooSmall, snapshotFixture(), "NOTIONAL_BELOW_MINIMUM");

  const mismatch = preflightBinanceCapitalTest(
    context,
    intent,
    snapshotFixture({ accountId: "binance:other" }),
    now,
    20,
  );
  assert.equal(mismatch.status, "FAIL");
  if (mismatch.status === "FAIL") assert.equal(mismatch.reason, "ACCOUNT_BINDING_MISMATCH");

  const invalidConstraints = {
    ...intent,
    constraints: { ...intent.constraints, maxResidualBaseQuantity: "-0.001" },
  };
  assertFail(invalidConstraints, snapshotFixture(), "CONSTRAINT_INVALID");
});

test("enforces the 40 USD total planned capital limit and fails closed without prices", () => {
  const withinBase = intentFixture();
  const withinLimit = {
    ...withinBase,
    legs: [
      { ...withinBase.legs[0], targetDeltaBaseQuantity: "0.019" },
      { ...withinBase.legs[1], targetDeltaBaseQuantity: "0.019" },
    ],
  } as SpotPerpetualFundingArbitrageExecutionIntent;
  assert.equal(
    preflightBinanceCapitalTest(context, withinLimit, snapshotFixture({ accountId: context.accountId }), now, 20).status,
    "PASS",
  );

  const aboveBase = intentFixture();
  const aboveLimit = {
    ...aboveBase,
    legs: [
      { ...aboveBase.legs[0], targetDeltaBaseQuantity: "0.021" },
      { ...aboveBase.legs[1], targetDeltaBaseQuantity: "0.021" },
    ],
  } as SpotPerpetualFundingArbitrageExecutionIntent;
  assertFail(aboveLimit, snapshotFixture(), "CAPITAL_LIMIT_EXCEEDED");

  const snapshot = snapshotFixture();
  assertFail(
    intentFixture(),
    { ...snapshot, spot: { ...snapshot.spot, ask: Number.NaN } },
    "CAPITAL_ESTIMATE_UNAVAILABLE",
  );
});

test("preflight imports only Intent, Binance instrument metadata, and read snapshot types", () => {
  const source = readFileSync(new URL("./BinanceCapitalTestPreflight.ts", import.meta.url), "utf8");
  const importPaths = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(importPaths, [
    "../cex/funding-arbitrage/FundingArbitrageExecutionIntent",
    "./BinanceInstrumentCatalog",
    "./BinanceTypes",
  ]);
  assert.doesNotMatch(source, /BinanceClient|BinanceOrderManager|BinanceRiskGuard|Credential|Provider|Database/iu);
});

function assertFail(
  intent: SpotPerpetualFundingArbitrageExecutionIntent,
  snapshot: ReturnType<typeof snapshotFixture>,
  reason: string,
) {
  const result = preflightBinanceCapitalTest(
    context,
    intent,
    { ...snapshot, accountId: context.accountId },
    now,
    20,
  );
  assert.equal(result.status, "FAIL");
  if (result.status === "FAIL") assert.equal(result.reason, reason);
}

function intentFixture(
  overrides: Partial<SpotPerpetualFundingArbitrageExecutionIntent> = {},
): SpotPerpetualFundingArbitrageExecutionIntent {
  return {
    intentId: "intent-capital-test",
    sourcePlanId: "plan-capital-test",
    strategyType: "SPOT_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt: now - 1_000,
    expiresAt: now + 60_000,
    constraints: { maxResidualBaseQuantity: "0.001" },
    legs: [
      {
        legId: "leg-spot-long",
        role: "long",
        venue: "binance",
        instrumentId: BINANCE_SPOT_INSTRUMENT_ID,
        marketType: "spot",
        targetDeltaBaseQuantity: "0.01",
      },
      {
        legId: "leg-perpetual-short",
        role: "short",
        venue: "binance",
        instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.01",
      },
    ],
    ...overrides,
  };
}
