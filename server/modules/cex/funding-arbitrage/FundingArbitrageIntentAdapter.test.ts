import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FundingArbitrageIntentAdapter } from "./FundingArbitrageIntentAdapter";
import type { FundingArbitrageExecutionIntent } from "./FundingArbitrageExecutionIntent";

const now = 1_800_000_000_000;

test("converts a confirmed funding leg into a canonical ExecutionIntent", () => {
  const intent = new FundingArbitrageIntentAdapter().createExecutionIntent(
    fundingIntent(),
    confirmation(),
  );

  assert.deepEqual(intent, {
    intentId: "execution-intent-long",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    instrumentId: "BTC-USDT-PERP",
    side: "buy",
    quantity: {
      asset: { symbol: "BTC", type: "DIGITAL_ASSET" },
      quantity: "0.01",
    },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now + 1_000,
    expiresAt: now + 30_000,
  });
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.quantity), true);
});

test("rejects missing explicit human confirmation", () => {
  assert.throws(
    () => new FundingArbitrageIntentAdapter().createExecutionIntent(
      fundingIntent(),
      confirmation({ confirmed: false }),
    ),
    /explicit human confirmation is required/u,
  );
});

test("rejects missing user and account context", () => {
  const adapter = new FundingArbitrageIntentAdapter();
  assert.throws(
    () => adapter.createExecutionIntent(fundingIntent(), confirmation({ userId: "" })),
    /userId is invalid/u,
  );
  assert.throws(
    () => adapter.createExecutionIntent(fundingIntent(), confirmation({ accountId: "" })),
    /accountId is invalid/u,
  );
});

test("rejects quantity asset mismatches against the canonical instrument base asset", () => {
  assert.throws(
    () => new FundingArbitrageIntentAdapter().createExecutionIntent(
      fundingIntent(),
      confirmation({ quantityAsset: { symbol: "ETH", type: "DIGITAL_ASSET" } }),
    ),
    /quantity asset must match/u,
  );
});

test("rejects invalid expiry windows", () => {
  const adapter = new FundingArbitrageIntentAdapter();
  assert.throws(
    () => adapter.createExecutionIntent(fundingIntent(), confirmation({ confirmedAt: now - 1 })),
    /confirmation must be within/u,
  );
  assert.throws(
    () => adapter.createExecutionIntent(fundingIntent(), confirmation({ expiresAt: now + 1_000 })),
    /expiry must be after confirmation/u,
  );
  assert.throws(
    () => adapter.createExecutionIntent(fundingIntent(), confirmation({ expiresAt: now + 90_001 })),
    /cannot exceed funding intent expiry/u,
  );
});

test("requires one explicit conversion per funding leg", () => {
  const adapter = new FundingArbitrageIntentAdapter();
  const funding = fundingIntent();
  const longIntent = adapter.createExecutionIntent(funding, confirmation({
    intentId: "execution-intent-long",
    legId: "leg-long",
  }));
  const shortIntent = adapter.createExecutionIntent(funding, confirmation({
    intentId: "execution-intent-short",
    legId: "leg-short",
    venue: "okx",
    accountId: "okx:account-1",
  }));

  assert.equal(longIntent.side, "buy");
  assert.equal(shortIntent.side, "sell");
  assert.notEqual(longIntent.intentId, shortIntent.intentId);
  assert.throws(
    () => adapter.createExecutionIntent(funding, confirmation({ legId: "missing-leg" })),
    /funding leg does not belong/u,
  );
});

test("supports RWA spot legs without venue-native symbols in ExecutionIntent", () => {
  const intent = new FundingArbitrageIntentAdapter().createExecutionIntent(
    spotPerpetualFundingIntent(),
    confirmation({
      intentId: "execution-intent-rwa-spot",
      legId: "leg-spot-long",
      quantityAsset: {
        symbol: "XAUT",
        type: "RWA_ASSET",
        externalReference: { namespace: "lbma", identifier: "gold" },
      },
    }),
  );

  assert.equal(intent.instrumentId, "XAUT-USDT-SPOT");
  assert.equal(intent.quantity.asset.symbol, "XAUT");
  assert.equal(intent.quantity.asset.type, "RWA_ASSET");
});

test("adapter stays a pure translation boundary", () => {
  const source = readFileSync(new URL("./FundingArbitrageIntentAdapter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ExecutionCoordinator|ExecutionCapability|OrderManager|RiskGuard|Client|fetch\(|placeOrder|cancelOrder/u);
  assert.doesNotMatch(source, /expectedFunding|fundingRate|profit|strategyScore|opportunityRanking|autoExecute/iu);
});

function confirmation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    confirmed: true,
    intentId: "execution-intent-long",
    legId: "leg-long",
    userId: "user-1",
    accountId: "binance:account-1",
    venue: "binance",
    quantityAsset: { symbol: "BTC", type: "DIGITAL_ASSET" },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    confirmedAt: now + 1_000,
    expiresAt: now + 30_000,
    ...overrides,
  };
}

function fundingIntent(): FundingArbitrageExecutionIntent {
  return {
    intentId: "funding-intent-1",
    sourcePlanId: "plan-1",
    strategyType: "PERPETUAL_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt: now,
    expiresAt: now + 90_000,
    constraints: { maxResidualBaseQuantity: "0.0001" },
    legs: [
      {
        legId: "leg-long",
        role: "long",
        venue: "binance",
        instrumentId: "BTC-USDT-PERP",
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.010000",
      },
      {
        legId: "leg-short",
        role: "short",
        venue: "okx",
        instrumentId: "BTC-USDT-PERP",
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.010000",
      },
    ],
  };
}

function spotPerpetualFundingIntent(): FundingArbitrageExecutionIntent {
  return {
    intentId: "funding-intent-rwa",
    sourcePlanId: "plan-rwa",
    strategyType: "SPOT_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt: now,
    expiresAt: now + 90_000,
    constraints: { maxResidualBaseQuantity: "0.0001" },
    legs: [
      {
        legId: "leg-spot-long",
        role: "long",
        venue: "binance",
        instrumentId: "XAUT-USDT-SPOT",
        marketType: "spot",
        targetDeltaBaseQuantity: "1",
      },
      {
        legId: "leg-perp-short",
        role: "short",
        venue: "okx",
        instrumentId: "XAUT-USDT-PERP",
        marketType: "perpetual",
        targetDeltaBaseQuantity: "1",
      },
    ],
  };
}
