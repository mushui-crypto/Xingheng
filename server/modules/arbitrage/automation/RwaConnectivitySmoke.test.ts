import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConnectivitySmokePolicyAcceptance,
  calculateConnectivitySmokeBudget,
  connectivitySmokePolicyDiscovery,
  RWA_CONNECTIVITY_SMOKE_BUDGET_USD,
  RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
  RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
} from "./RwaConnectivitySmoke";
import type { RwaBinancePreflightSnapshot } from "./RwaBinanceAutomationTypes";

test("connectivity smoke policy discovery is the canonical display and acceptance source", () => {
  const discovery = connectivitySmokePolicyDiscovery("binance:test");
  assert.equal(discovery.executionAuthorized, false);
  assert.equal(discovery.policy.version, RWA_CONNECTIVITY_SMOKE_POLICY_VERSION);
  assert.equal(discovery.policy.digest, RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST);
  assert.deepEqual(discovery.policy.requiredConfirmations, [
    "exclusive_window", "manual_recovery", "non_atomic_risk",
  ]);
  assert.deepEqual(
    discovery.policy.exclusiveWindowRules.map((item) => item.code),
    ["dedicated_blank_subaccount", "single_execution_immediate_exit", "no_other_xaut_activity"],
  );
  assert.deepEqual(
    discovery.policy.manualRecoveryRequirements.map((item) => item.code),
    ["manual_cancel_capability", "manual_close_capability"],
  );
  assert.deepEqual(
    discovery.policy.residualRisks.map((item) => item.code),
    [
      "scan_cutoff_to_mutation_race",
      "rest_history_visibility_delay",
      "same_net_round_trip_may_not_be_detected",
      "asset_fungibility_prevents_mathematical_ownership_proof",
      "budget_is_not_a_maximum_loss_guarantee",
    ],
  );
  assert.ok([
    ...discovery.policy.exclusiveWindowRules,
    ...discovery.policy.manualRecoveryRequirements,
    ...discovery.policy.residualRisks,
  ].every((item) => item.message.length > 0));
  assert.doesNotMatch(
    JSON.stringify(discovery),
    /apiSecret|credential|totp|token|wif|ipAddress|providerRaw/i,
  );
  assert.doesNotThrow(() => assertConnectivitySmokePolicyAcceptance({
    version: discovery.policy.version,
    digest: discovery.policy.digest,
    exclusiveWindowConfirmed: true,
    manualRecoveryConfirmed: true,
    nonAtomicRiskAccepted: true,
  }));
  assert.throws(() => assertConnectivitySmokePolicyAcceptance({
    version: discovery.policy.version,
    digest: `${discovery.policy.digest}-old`,
    exclusiveWindowConfirmed: true,
    manualRecoveryConfirmed: true,
    nonAtomicRiskAccepted: true,
  }));
});

test("connectivity smoke canonical policy remains digest-consistent after runtime mutation attempts", () => {
  const first = connectivitySmokePolicyDiscovery("binance:test");
  const originalPolicy = JSON.stringify(first.policy);
  const originalDigest = first.policy.digest;
  const mutable = first.policy as any;
  for (const mutation of [
    () => mutable.requiredConfirmations.push("bypass"),
    () => mutable.exclusiveWindowRules.splice(0, 1),
    () => { mutable.manualRecoveryRequirements[0] = { code: "bypass", message: "bypass" }; },
    () => { mutable.residualRisks[0].message = "mutated"; },
    () => { mutable.exclusiveWindowRules[0].code = "mutated"; },
  ]) {
    assert.throws(mutation, TypeError);
  }
  const second = connectivitySmokePolicyDiscovery("binance:test");
  assert.equal(JSON.stringify(second.policy), originalPolicy);
  assert.equal(second.policy.digest, originalDigest);
  assert.doesNotThrow(() => assertConnectivitySmokePolicyAcceptance({
    version: second.policy.version,
    digest: second.policy.digest,
    exclusiveWindowConfirmed: true,
    manualRecoveryConfirmed: true,
    nonAtomicRiskAccepted: true,
  }));
  assert.throws(() => assertConnectivitySmokePolicyAcceptance({
    version: second.policy.version,
    digest: "mutated",
    exclusiveWindowConfirmed: true,
    manualRecoveryConfirmed: true,
    nonAtomicRiskAccepted: true,
  }));
});

test("connectivity smoke budget uses the common step and reserves all four action fees and slippage", () => {
  const result = calculateConnectivitySmokeBudget(snapshot(), 20);
  assert.equal(result.quantityXaut, 0.002);
  assert.equal(result.commonQtyStep, 0.001);
  assert.ok(result.spotFeesUsd > 0);
  assert.ok(result.futuresFeesUsd > 0);
  assert.ok(result.spotSlippageReserveUsd > 0);
  assert.ok(result.futuresSlippageReserveUsd > 0);
  assert.ok(result.totalCapitalUsd <= RWA_CONNECTIVITY_SMOKE_BUDGET_USD);
});

test("connectivity smoke budget returns zero provider quantity when the dynamic minimum exceeds 25 USDT", () => {
  const expensive = snapshot();
  expensive.spot.ask = 7_000;
  expensive.perpetual.bid = 7_000;
  expensive.spot.minNotionalUsd = 15;
  expensive.perpetual.minNotionalUsd = 15;
  const result = calculateConnectivitySmokeBudget(expensive, 20);
  assert.equal(result.quantityXaut, 0);
  assert.equal(result.totalCapitalUsd, 0);
});

test("connectivity smoke budget rounds a finer spot step to the futures common step", () => {
  const value = snapshot();
  value.spot.qtyStep = 0.0001;
  value.perpetual.qtyStep = 0.001;
  value.spot.minOrderQty = 0.0001;
  value.perpetual.minOrderQty = 0.001;
  const result = calculateConnectivitySmokeBudget(value, 20);
  assert.equal(result.commonQtyStep, 0.001);
  assert.equal(result.quantityXaut % 0.001, 0);
});

test("connectivity smoke budget never under-reserves the frozen order bounds when config requests one bps", () => {
  const result = calculateConnectivitySmokeBudget(snapshot(), 1);
  assert.equal(result.slippageBpsPerAction, 10);
  assert.ok(result.prices.spotOpenLimit >= 4_104.1);
  assert.ok(result.prices.futuresOpenLimit <= 4_095.9);
  assert.ok(result.prices.futuresCloseLimit >= 4_105.11);
  assert.ok(result.prices.spotCloseLimit <= 4_094.9);
  assert.ok(result.totalCapitalUsd <= RWA_CONNECTIVITY_SMOKE_BUDGET_USD);
});

test("connectivity smoke budget includes adverse price-tick rounding and fails closed at the cap edge", () => {
  const value = snapshot();
  value.spot.priceTick = 1;
  value.perpetual.priceTick = 1;
  value.spot.minNotionalUsd = 12.49;
  value.perpetual.minNotionalUsd = 12.49;
  const result = calculateConnectivitySmokeBudget(value, 1);
  assert.equal(result.quantityXaut, 0);
  assert.equal(result.totalCapitalUsd, 0);
});

function snapshot(): RwaBinancePreflightSnapshot {
  return {
    accountId: "binance:test",
    accountFingerprint: "fingerprint",
    fetchedAt: Date.now(),
    accountMode: "single_asset_one_way",
    permissions: {
      read: true,
      spotTrade: true,
      contractTrade: true,
      withdraw: false,
      ipRestricted: true,
      spotAccount: true,
      futuresAccount: true,
      positionModeSupported: true,
    },
    productAvailability: {
      available: true,
      status: "available",
      spotSymbol: "XAUTUSDT",
      perpetualSymbol: "XAUTUSDT",
      checkedAt: Date.now(),
      message: null,
    },
    availableUsdt: 30,
    spotAvailableUsdt: 15,
    futuresAvailableUsdt: 15,
    existingSpotQuantityXaut: 0,
    spotAvailableQuantityXaut: 0,
    spotLockedQuantityXaut: 0,
    spotFreeXaut: 0,
    spotLockedXaut: 0,
    existingPerpetualQuantityXaut: 0,
    perpetualPositionSide: "flat",
    openSpotOrderCount: 0,
    openPerpetualOrderCount: 0,
    spot: {
      status: "Trading",
      minOrderQty: 0.0001,
      qtyStep: 0.0001,
      minNotionalUsd: 5,
      priceTick: 0.01,
      bid: 4_099,
      ask: 4_100,
      depthUsd: 100_000,
    },
    perpetual: {
      status: "Trading",
      minOrderQty: 0.001,
      qtyStep: 0.001,
      minNotionalUsd: 5,
      priceTick: 0.01,
      bid: 4_100,
      ask: 4_101,
      depthUsd: 100_000,
      mark: 4_100,
      fundingRate: 0,
      fundingIntervalHours: 8,
      nextFundingTime: null,
      liquidationDistancePercent: null,
    },
    fees: { spotTakerBps: 10, perpetualTakerBps: 5 },
  };
}
