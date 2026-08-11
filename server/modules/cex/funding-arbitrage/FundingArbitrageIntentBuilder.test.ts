import assert from "node:assert/strict";
import test from "node:test";
import type { FundingArbitragePlan } from "./FundingArbitragePlan";
import { buildFundingArbitrageExecutionIntent } from "./FundingArbitrageIntentBuilder";

const now = 1_800_000_000_000;
const plan = perpetualPlan();
const buildParameters = {
  now,
  maxResidualBaseQuantity: "0.00100000",
} as const;

test("builds a decimal-safe perpetual/perpetual execution intent without changing the plan", () => {
  const intent = buildFundingArbitrageExecutionIntent(plan, buildParameters);

  assert.equal(intent.sourcePlanId, plan.planId);
  assert.ok(intent.intentId);
  assert.notEqual(intent.legs[0].legId, intent.legs[1].legId);
  assert.equal(intent.strategyType, "PERPETUAL_PERPETUAL");
  assert.equal(intent.objective, "ESTABLISH_HEDGE");
  assert.equal(intent.createdAt, now);
  assert.equal(intent.expiresAt, plan.expiresAt);
  assert.equal(intent.constraints.maxResidualBaseQuantity, "0.001");

  for (const index of [0, 1] as const) {
    assert.equal(intent.legs[index].role, plan.legs[index].role);
    assert.equal(intent.legs[index].venue, plan.legs[index].venue);
    assert.equal(intent.legs[index].instrumentId, plan.legs[index].instrumentId);
    assert.equal(intent.legs[index].marketType, plan.legs[index].marketType);
    assert.equal(intent.legs[index].targetDeltaBaseQuantity, "0.12");
    assert.match(intent.legs[index].targetDeltaBaseQuantity, /^(?:0|[1-9]\d*)(?:\.\d+)?$/u);
  }
});

test("rejects venue-qualified instrument identity at the funding intent boundary", () => {
  const venueQualifiedPlan = {
    ...plan,
    legs: [
      { ...plan.legs[0], instrumentId: "binance:perpetual:linear:BTC:USDT:USDT" },
      plan.legs[1],
    ],
  } as FundingArbitragePlan;

  assert.throws(
    () => buildFundingArbitrageExecutionIntent(venueQualifiedPlan, buildParameters),
    /Invalid canonical instrument id/u,
  );
});

test("rejects expired plans and intent expiry beyond the source plan", () => {
  assert.throws(
    () => buildFundingArbitrageExecutionIntent(plan, { ...buildParameters, now: plan.expiresAt }),
    /expired/u,
  );
  assert.throws(
    () => buildFundingArbitrageExecutionIntent(plan, {
      ...buildParameters,
      expiresAt: plan.expiresAt + 1,
    }),
    /cannot exceed/u,
  );
});

test("rejects unsupported strategy types and invalid leg structures", () => {
  const spotPerpetual = {
    ...plan,
    strategyType: "SPOT_PERPETUAL",
  } as unknown as FundingArbitragePlan;
  assert.throws(
    () => buildFundingArbitrageExecutionIntent(spotPerpetual, buildParameters),
    /Unsupported/u,
  );

  const missingLeg = { ...plan, legs: [plan.legs[0]] } as unknown as FundingArbitragePlan;
  assert.throws(
    () => buildFundingArbitrageExecutionIntent(missingLeg, buildParameters),
    /exactly two legs/u,
  );

  const missingShort = {
    ...plan,
    legs: [plan.legs[0], { ...plan.legs[1], role: "long" }],
  } as unknown as FundingArbitragePlan;
  assert.throws(
    () => buildFundingArbitrageExecutionIntent(missingShort, buildParameters),
    /ordered long leg/u,
  );
});

test("rejects non-positive quantities and non-perpetual legs for v1", () => {
  const zeroQuantity = {
    ...plan,
    legs: [{ ...plan.legs[0], baseQuantity: 0 }, plan.legs[1]],
  } as FundingArbitragePlan;
  assert.throws(
    () => buildFundingArbitrageExecutionIntent(zeroQuantity, buildParameters),
    /quantities must be positive/u,
  );

  const spotLeg = {
    ...plan,
    legs: [{ ...plan.legs[0], marketType: "spot", fundingSnapshot: null }, plan.legs[1]],
  } as unknown as FundingArbitragePlan;
  assert.throws(
    () => buildFundingArbitrageExecutionIntent(spotLeg, buildParameters),
    /requires two perpetual legs/u,
  );
});

test("intent contains no order, account, provider, credential, price, or persistence fields", () => {
  const intent = buildFundingArbitrageExecutionIntent(plan, buildParameters);
  const forbiddenFields = new Set([
    "orderId",
    "clientOrderId",
    "accountId",
    "credential",
    "price",
    "orderType",
    "providerSymbol",
    "executedQuantity",
    "residualQuantity",
    "reconciliation",
    "storage",
  ]);
  for (const key of collectKeys(intent)) {
    assert.equal(forbiddenFields.has(key), false, `unexpected execution field: ${key}`);
  }
});

function perpetualPlan(): FundingArbitragePlan {
  const fundingAt = now + 8 * 60 * 60 * 1_000;
  return {
    planId: "plan-phase-5",
    strategyType: "PERPETUAL_PERPETUAL",
    instrument: { baseAsset: "BTC", quoteAsset: "USDT", settlementAsset: "USDT" },
    legs: [
      {
        role: "long",
        venue: "binance",
        instrumentId: "BTC-USDT-PERP",
        marketType: "perpetual",
        baseQuantity: 0.12,
        fundingSnapshot: funding("binance", "BTC-USDT-PERP", -0.0001, fundingAt),
      },
      {
        role: "short",
        venue: "okx",
        instrumentId: "BTC-USDT-PERP",
        marketType: "perpetual",
        baseQuantity: 0.12,
        fundingSnapshot: funding("okx", "BTC-USDT-PERP", 0.0003, fundingAt),
      },
    ],
    expectedFunding: { netRate: 0.0004, amount: 3.12, asset: "USDT", fundingAt },
    confidence: "high",
    details: { fundingSpreadRate: 0.0004, fundingTimeSkewMs: 0 },
    createdAt: now - 1_000,
    expiresAt: now + 60_000,
  };
}

function funding(
  venue: "binance" | "okx",
  instrumentId: string,
  rate: number,
  nextFundingAt: number,
) {
  return { venue, instrumentId, rate, intervalHours: 8, nextFundingAt, markPrice: 65_000, fetchedAt: now - 1_000 };
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}
