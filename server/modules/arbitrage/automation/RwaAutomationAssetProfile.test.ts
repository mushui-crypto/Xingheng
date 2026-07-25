import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRwaAutomationInstrumentRules,
  assertRwaAutomationNewRisk,
  calculateRwaAutomationNewRiskUsage,
  listRwaAutomationAssetProfiles,
  requireRwaAutomationAssetProfile,
  requireRwaAutomationExecutionProfile,
  requireRwaAutomationVenueAssetProfile,
  rwaAutomationProfileId,
  RwaAutomationAssetProfileError,
  validateRwaAutomationAssetProfile,
  XAUT_AUTOMATION_ASSET_PROFILE,
} from "./RwaAutomationAssetProfile";

test("XAUT is the only enabled profile and V1 limits are layered configuration", () => {
  const profiles = listRwaAutomationAssetProfiles();
  assert.deepEqual(profiles.map((value) => value.assetId), ["xaut", "btc", "eth", "sol"]);
  assert.deepEqual(profiles.filter((value) => value.executionStatus === "enabled").map((value) => value.assetId), ["xaut"]);
  assert.deepEqual(XAUT_AUTOMATION_ASSET_PROFILE.currentStageRiskLimits, {
    maxOrderNotionalUsd: 25,
    maxAssetCapitalUsd: 300,
    maxAccountCapitalUsd: 300,
    maxGlobalCapitalUsd: 300,
  });
});

test("reserved assets and unknown venue fail closed for execution", () => {
  for (const assetId of ["btc", "eth", "sol"]) {
    assert.throws(
      () => requireRwaAutomationAssetProfile(assetId, { executionRequired: true }),
      (error: unknown) => error instanceof RwaAutomationAssetProfileError
        && error.category === "asset_profile_disabled",
    );
  }
  assert.throws(() => requireRwaAutomationVenueAssetProfile("xaut", "okx"));
});

test("profiles are deeply frozen", () => {
  assert.equal(Object.isFrozen(XAUT_AUTOMATION_ASSET_PROFILE), true);
  assert.equal(Object.isFrozen(XAUT_AUTOMATION_ASSET_PROFILE.venues[0]?.spotRules), true);
});

test("profile rejects symbol, contract, activity, precision, and inverted risk limits", () => {
  const valid = structuredClone(XAUT_AUTOMATION_ASSET_PROFILE);
  const invalid = [
    { ...structuredClone(valid), venues: [{ ...structuredClone(valid.venues[0]!), spotSymbol: "BTCUSDT" }] },
    { ...structuredClone(valid), venues: [{ ...structuredClone(valid.venues[0]!), perpetualContract: { kind: "linear" as const, baseQuantityMultiplier: 0 } }] },
    { ...structuredClone(valid), venues: [{ ...structuredClone(valid.venues[0]!), activitySources: [] }] },
    { ...structuredClone(valid), venues: [{ ...structuredClone(valid.venues[0]!), spotRules: { ...structuredClone(valid.venues[0]!.spotRules), contractUnitBase: 0 } }] },
    { ...structuredClone(valid), currentStageRiskLimits: { maxOrderNotionalUsd: 301, maxAssetCapitalUsd: 300, maxAccountCapitalUsd: 300, maxGlobalCapitalUsd: 300 } },
  ];
  invalid.forEach((value) => assert.throws(() => validateRwaAutomationAssetProfile(value)));
});

test("server profile rejects precision mismatch and each new-risk aggregation tier", () => {
  const profile = requireRwaAutomationExecutionProfile("xaut", "binance");
  assert.doesNotThrow(() => assertRwaAutomationInstrumentRules(profile, "spot", {
    qtyStep: 0.0001, priceTick: 0.01, minOrderQty: 0.0001, minNotionalUsd: 5,
  }));
  assert.throws(() => assertRwaAutomationInstrumentRules(profile, "spot", {
    qtyStep: 0.002, priceTick: 0.01, minOrderQty: 0.002, minNotionalUsd: 5,
  }));
  assert.throws(() => assertRwaAutomationInstrumentRules(profile, "spot", {
    qtyStep: 0.0001, priceTick: 0.01, minOrderQty: 0.001, minNotionalUsd: 5,
  }));
  const bybitProfile = requireRwaAutomationExecutionProfile("xaut", "bybit");
  assert.doesNotThrow(() => assertRwaAutomationInstrumentRules(bybitProfile, "spot", {
    qtyStep: 0.0001, priceTick: 0.01, minOrderQty: 0.0001, minNotionalUsd: 5,
  }));
  assert.throws(() => assertRwaAutomationInstrumentRules(bybitProfile, "spot", {
    qtyStep: 0.0001, priceTick: 0.01, minOrderQty: 0.00005, minNotionalUsd: 5,
  }));
  const limits = profile.asset.currentStageRiskLimits!;
  for (const values of [
    [26, 26, 26, 26],
    [25, 301, 301, 301],
    [25, 300, 301, 301],
    [25, 300, 300, 301],
  ]) {
    assert.throws(() => assertRwaAutomationNewRisk({
      limits,
      orderNotionalUsd: values[0]!,
      assetNotionalUsd: values[1]!,
      accountNotionalUsd: values[2]!,
      globalNotionalUsd: values[3]!,
    }));
  }
});

test("risk aggregation isolates assets and accounts while preserving the global total", () => {
  const profile = requireRwaAutomationExecutionProfile("xaut", "binance");
  const exposures = [
    {
      executionId: "xaut-a",
      userId: "user-a",
      accountId: "binance:account-a",
      assetId: "xaut" as const,
      profileId: rwaAutomationProfileId(profile),
      capitalUsd: 100,
    },
    {
      executionId: "btc-a",
      userId: "user-a",
      accountId: "binance:account-a",
      assetId: "btc" as const,
      profileId: "btc:binance-btc-spot-perp-v1",
      capitalUsd: 20,
    },
    {
      executionId: "xaut-b",
      userId: "user-b",
      accountId: "binance:account-b",
      assetId: "xaut" as const,
      profileId: rwaAutomationProfileId(profile),
      capitalUsd: 30,
    },
  ];
  assert.deepEqual(calculateRwaAutomationNewRiskUsage({
    exposures,
    profile,
    userId: "user-a",
    accountId: "binance:account-a",
    orderNotionalUsd: 10,
    proposedCapitalUsd: 10,
  }), {
    orderNotionalUsd: 10,
    assetNotionalUsd: 140,
    accountNotionalUsd: 130,
    globalNotionalUsd: 160,
  });
});
