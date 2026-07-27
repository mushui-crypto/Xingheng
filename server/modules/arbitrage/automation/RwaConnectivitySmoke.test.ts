import assert from "node:assert/strict";
import test from "node:test";
import {
  appendConnectivitySmokeTimeline,
  assertConnectivitySmokePolicyAcceptance,
  calculateConnectivitySmokeBudget,
  connectivitySmokePolicyDiscovery,
  migrateLegacyConnectivitySmokeRecord,
  RWA_CONNECTIVITY_SMOKE_BUDGET_USD,
  RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
  RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
  validateConnectivitySmokeFacts,
  type RwaConnectivitySmokeRecord,
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

test("connectivity smoke exact facts reject malformed order slots and contradictory receipts", () => {
  const mutations: Array<(record: any) => void> = [
    (record) => { record.spotOpenOrder.orderLinkId = `${record.orderLinkPrefix}p1`; },
    (record) => { record.spotOpenOrder.requestedQuantityXaut = -1; },
    (record) => { record.spotOpenOrder.filledQuantityXaut = Number.NaN; },
    (record) => { record.spotOpenOrder.filledQuantityXaut = 2; },
    (record) => { record.spotOpenOrder.positionQuantityXaut = -1; },
    (record) => { record.spotOpenOrder.averagePrice = -1; },
    (record) => { record.spotOpenOrder.feeUsd = -1; },
    (record) => { record.spotOpenOrder.status = "Pending"; },
    (record) => { record.spotOpenOrder.updatedAt = -1; },
    (record) => { record.stage = "manual_intervention"; record.timeline.at(-1).stage = "manual_intervention"; record.timeline.at(-1).code = "stage_manual_intervention"; },
    (record) => { record.exit.futuresFlatConfirmed = false; },
    (record) => { record.providerState.verificationStatus = "stale"; record.providerState.providerFlatConfirmed = null; },
    (record) => { record.providerState.residualSpotQuantityXaut = 0.1; },
    (record) => { record.providerState.activeSpotOrderCount = 1; record.providerState.activeTotalOrderCount = 1; },
    (record) => { record.receipt.smokeId = "other"; },
    (record) => { record.receipt.accountFingerprint = "other"; },
    (record) => { record.receipt.finalSpotQuantityXaut = 0.1; },
    (record) => { record.receipt.completedAt = 0; },
  ];
  assert.doesNotThrow(() => validateConnectivitySmokeFacts(validFlatSmoke()));
  for (const mutate of mutations) {
    const record = validFlatSmoke() as any;
    mutate(record);
    assert.throws(() => validateConnectivitySmokeFacts(record));
  }
});

test("connectivity smoke timeline enforces the frozen transition graph and generator codes", () => {
  const valid = validFlatSmoke();
  assert.doesNotThrow(() => validateConnectivitySmokeFacts(valid));
  for (const timeline of [
    [
      { stage: "reserved", at: 1, code: "reserved" },
      { stage: "hedged", at: 2, code: "stage_hedged" },
      { stage: "spot_opening", at: 3, code: "stage_spot_opening" },
    ],
    [
      { stage: "reserved", at: 1, code: "reserved" },
      { stage: "spot_opening", at: 2, code: "stage_spot_opening" },
      { stage: "hedged", at: 3, code: "stage_hedged" },
    ],
    [
      { stage: "reserved", at: 1, code: "reserved" },
      { stage: "spot_opening", at: 2, code: "wrong" },
    ],
    [
      { stage: "reserved", at: 2, code: "reserved" },
      { stage: "spot_opening", at: 1, code: "stage_spot_opening" },
    ],
  ]) {
    const record = validFlatSmoke() as any;
    record.stage = timeline.at(-1)!.stage;
    record.timeline = timeline;
    record.receipt = null;
    assert.throws(() => validateConnectivitySmokeFacts(record));
  }
  const manual = validFlatSmoke() as any;
  manual.stage = "hedged";
  manual.receipt = null;
  manual.timeline = manual.timeline.slice(0, 5);
  manual.stage = "manual_intervention";
  manual.updatedAt = 10;
  appendConnectivitySmokeTimeline(manual, 10);
  assert.equal(manual.timeline.at(-1).code, "stage_manual_intervention");
  assert.doesNotThrow(() => validateConnectivitySmokeFacts(manual));
});

test("legacy connectivity smoke migration is exact, additive, and never fabricates provider authority", () => {
  const legacy = validFlatSmoke() as any;
  delete legacy.providerState;
  delete legacy.timeline;
  const migrated = migrateLegacyConnectivitySmokeRecord(legacy) as RwaConnectivitySmokeRecord;
  assert.equal(migrated.providerState.verificationStatus, "unavailable");
  assert.equal(migrated.providerState.observedAt, null);
  assert.equal(migrated.providerState.reason, "legacy_provider_state_unavailable");
  assert.equal(migrated.receipt, null);
  assert.deepEqual(migrated.timeline.map((event) => [event.stage, event.code]), [
    ["reserved", "legacy_migration_reserved"],
    ["flat", "legacy_migration_current_stage"],
  ]);
  assert.doesNotThrow(() => validateConnectivitySmokeFacts(migrated));

  const partial = validFlatSmoke() as any;
  delete partial.timeline;
  assert.equal(migrateLegacyConnectivitySmokeRecord(partial), partial);
  const malformed = { ...legacy, unknown: true };
  assert.equal(migrateLegacyConnectivitySmokeRecord(malformed), malformed);
});

function validFlatSmoke(): RwaConnectivitySmokeRecord {
  const budget = calculateConnectivitySmokeBudget(snapshot(), 20);
  const prefix = "rwacstest";
  const order = (suffix: string) => ({
    orderId: `order-${suffix}`,
    orderLinkId: `${prefix}${suffix}`,
    status: "Filled" as const,
    requestedQuantityXaut: budget.quantityXaut,
    filledQuantityXaut: budget.quantityXaut,
    positionQuantityXaut: budget.quantityXaut,
    averagePrice: 4_100,
    feeUsd: 0.001,
    updatedAt: 7,
  });
  const timeline = [
    ["reserved", "reserved"],
    ["spot_opening", "stage_spot_opening"],
    ["spot_open", "stage_spot_open"],
    ["futures_opening", "stage_futures_opening"],
    ["hedged", "stage_hedged"],
    ["futures_closing", "stage_futures_closing"],
    ["spot_closing", "stage_spot_closing"],
    ["flat", "stage_flat"],
  ].map(([stage, code], index) => ({ stage, code, at: index + 1 })) as RwaConnectivitySmokeRecord["timeline"];
  return {
    smokeId: "smoke-test",
    userId: "user-a",
    accountId: "binance:test",
    accountFingerprint: "fingerprint",
    purpose: "connectivity_smoke",
    mode: "connectivity_smoke",
    idempotencyKey: "smoke:test",
    challengeId: "challenge-test",
    requestDigest: "request-digest",
    policyVersion: RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
    policyDigest: RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
    orderLinkPrefix: prefix,
    stage: "flat",
    budget,
    authorization: {
      operation: "connectivity_smoke_execute",
      consumedBeforeProviderMutation: true,
      exitAuthorized: true,
      reservedAt: 1,
    },
    spotOpenOrder: order("s1"),
    futuresOpenOrder: order("p1"),
    openedSpotQuantityXaut: budget.quantityXaut,
    openedFuturesQuantityXaut: budget.quantityXaut,
    exit: {
      futuresCloseOrder: order("c1"),
      spotCloseOrder: order("c2"),
      futuresFlatConfirmed: true,
      spotFlatConfirmed: true,
    },
    providerState: {
      verificationStatus: "verified",
      observedAt: 8,
      residualSpotQuantityXaut: 0,
      residualFuturesQuantityXaut: 0,
      activeSpotOrderCount: 0,
      activeFuturesOrderCount: 0,
      activeTotalOrderCount: 0,
      providerFlatConfirmed: true,
      reason: "provider_flat_confirmed",
    },
    timeline,
    receipt: {
      receiptId: "receipt-test",
      smokeId: "smoke-test",
      purpose: "connectivity_smoke",
      venue: "binance",
      symbol: "XAUTUSDT",
      accountFingerprint: "fingerprint",
      policyVersion: RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
      policyDigest: RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
      budget,
      openedSpotQuantityXaut: budget.quantityXaut,
      openedFuturesQuantityXaut: budget.quantityXaut,
      finalSpotQuantityXaut: 0,
      finalFuturesQuantityXaut: 0,
      providerFlatConfirmed: true,
      completedAt: 8,
    },
    noReopen: true,
    providerMutationCount: 4,
    errorCategory: null,
    message: "flat",
    createdAt: 1,
    updatedAt: 8,
  };
}

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
