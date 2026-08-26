import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveArbitrageManagementEndMethod,
  fetchActiveArbitrageInstances,
  fetchArbitrageCloseSafety,
  fetchArbitrageInstanceHistory,
  fetchArbitragePositionVerification,
  fetchInstanceHedgeDelta,
  releaseArbitrageLegManagement,
  requireArbitrageInstanceList,
} from "./arbitrageInstances";

test("arbitrage instance API uses active and paginated history query boundaries", async () => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return Response.json([arbitrageInstance("OPENING")]);
  };
  try {
    await fetchActiveArbitrageInstances();
    await fetchArbitrageInstanceHistory(2, 50);
    assert.deepEqual(requested, [
      "/api/arbitrage-instances/active",
      "/api/arbitrage-instances/history?page=2&limit=50",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verification API maps decimal strings and preserves unknown actual quantity as null", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "/api/arbitrage-instances/arbitrage%2Fholding/verification");
    return Response.json({
      arbitrageId: "arbitrage/holding",
      checkedAt: 1_800_000_004_000,
      legs: [
        { arbitrageId: "arbitrage/holding", legId: "long-leg", expectedManagedQuantity: "0.3", actualQuantity: "0.3", availableQuantity: "0.25", verificationStatus: "MATCHED", checkedAt: 1_800_000_004_000 },
        { arbitrageId: "arbitrage/holding", legId: "short-leg", expectedManagedQuantity: "0.3", actualQuantity: null, verificationStatus: "UNKNOWN", checkedAt: 1_800_000_004_000 },
      ],
    });
  };
  try {
    const result = await fetchArbitragePositionVerification("arbitrage/holding");
    assert.equal(result.legs[0].expectedManagedQuantity, "0.3");
    assert.equal(result.legs[1].actualQuantity, null);
    assert.equal(result.legs[0].availableQuantity, "0.25");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("arbitrage response preserves the authoritative instance without inferred market fields", () => {
  const [instance] = requireArbitrageInstanceList([{
    ...arbitrageInstance("HOLDING"),
    currentPrice: 123,
    apr: 9.9,
    position: { quantity: "1" },
  }]);

  assert.equal(instance?.status, "HOLDING");
  assert.deepEqual(instance?.legs.map(({ role }) => role), ["LONG", "SHORT"]);
  assert.equal("currentPrice" in instance!, false);
  assert.equal("apr" in instance!, false);
  assert.equal("position" in instance!, false);
});

test("management releases survive parsing and derive normal, release, and mixed endings from execution evidence", () => {
  const release = managementRelease();
  const [normal] = requireArbitrageInstanceList([arbitrageInstance("CLOSED")]);
  const [released] = requireArbitrageInstanceList([{
    ...arbitrageInstance("CLOSED"),
    arbitrageId: "released",
    managementReleases: [{ ...release, arbitrageId: "released" }],
  }]);
  const [mixed] = requireArbitrageInstanceList([{
    ...arbitrageInstance("CLOSED"),
    arbitrageId: "mixed",
    managementReleases: [{ ...release, arbitrageId: "mixed" }],
    executionReferences: [{
      arbitrageId: "mixed",
      legId: "long-leg",
      phase: "CLOSING",
      quantityEffect: "DECREASE",
      executionIntentId: "partial-close",
      executionRecordId: "partial-close-record",
      requestedQuantity: "0.5",
      confirmedQuantity: "0.25",
      status: "FAILED",
      createdAt: 1_800_000_002_100,
      updatedAt: 1_800_000_002_200,
    }],
  }]);

  assert.equal(released?.managementReleases[0]?.releasedQuantity, "0.75");
  assert.equal(released?.managementReleases[0]?.actualSignedNetQuantity, "0.25");
  assert.equal(typeof released?.managementReleases[0]?.releasedQuantity, "string");
  assert.equal(deriveArbitrageManagementEndMethod(normal!), "NORMAL_CLOSE");
  assert.equal(deriveArbitrageManagementEndMethod(released!), "MANAGEMENT_RELEASE");
  assert.equal(deriveArbitrageManagementEndMethod(mixed!), "MIXED");
  assert.equal(deriveArbitrageManagementEndMethod({ ...normal!, status: "HOLDING" }), null);
});

test("close safety and hedge delta clients preserve authoritative decimal strings", async () => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    if (String(input).endsWith("/close-safety")) return Response.json(closeSafetyResponse());
    return Response.json(hedgeDeltaResponse());
  };
  try {
    const safety = await fetchArbitrageCloseSafety("arb/1", "short/leg");
    const delta = await fetchInstanceHedgeDelta("arb/1");
    assert.equal(safety.activeManagedQuantity, "100.00000001");
    assert.equal(safety.safeClosableQuantity, "20.00000001");
    assert.equal(safety.fullManagedCloseAvailable, false);
    assert.equal(safety.realityReliable, true);
    assert.equal(safety.releaseEligible, true);
    assert.equal(safety.releaseEligibilityReason, "RELEASE_ELIGIBLE");
    assert.equal(typeof safety.safeClosableQuantity, "string");
    assert.equal(delta.openingDelta.signedDeltaBaseQuantity, "0.2");
    assert.equal(delta.activeManagedDelta.signedDeltaBaseQuantity, null);
    assert.equal(delta.openingWorkflow.requiredSecondLegSignedExposure, "-0.2");
    assert.equal(delta.plannedResidualDelta, "0.1");
    assert.equal(delta.actualResidualDelta, null);
    assert.equal(delta.legContributions[0].activeManagedQuantity, "100.00000001");
    assert.equal(typeof delta.legContributions[0].activeManagedQuantity, "string");
    assert.deepEqual(requested, [
      "/api/arbitrage-instances/arb%2F1/legs/short%2Fleg/close-safety",
      "/api/arbitrage-instances/arb%2F1/hedge-delta",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("management release client sends only command identity and explicit confirmation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/arbitrage-execution/legs/release-management");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      arbitrageId: "arb-1",
      legId: "short-leg",
      commandId: "release-command-1",
      confirmed: true,
    });
    return Response.json({
      instance: { ...arbitrageInstance("CLOSED"), arbitrageId: "arb-1", managementReleases: [{ ...managementRelease(), arbitrageId: "arb-1", legId: "short-leg" }] },
      release: { ...managementRelease(), arbitrageId: "arb-1", legId: "short-leg" },
      idempotentReplay: false,
    });
  };
  try {
    const result = await releaseArbitrageLegManagement({ arbitrageId: "arb-1", legId: "short-leg", commandId: "release-command-1" });
    assert.equal(result.instance.status, "CLOSED");
    assert.equal(result.release.releasedQuantity, "0.75");
    assert.equal(result.idempotentReplay, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

export function arbitrageInstance(status: string) {
  const terminal = status === "CLOSED" || status === "FAILED";
  return {
    arbitrageId: `arbitrage-${status.toLowerCase()}`,
    userId: "user-a",
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0.001",
    status,
    createdAt: 1_800_000_000_000,
    openedAt: status === "OPENING" || status === "FAILED" ? null : 1_800_000_001_000,
    updatedAt: 1_800_000_002_000,
    closedAt: terminal ? 1_800_000_003_000 : null,
    legs: [
      {
        legId: "long-leg",
        role: "LONG",
        venue: "okx",
        accountId: "okx:private-account-1234",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
        confirmedOpenedQuantity: "1",
        confirmedClosedQuantity: terminal ? "1" : "0",
      },
      {
        legId: "short-leg",
        role: "SHORT",
        venue: "binance",
        accountId: "binance:private-account-5678",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
        confirmedOpenedQuantity: "1",
        confirmedClosedQuantity: terminal ? "1" : "0",
      },
    ],
    executionReferences: [],
    pnl: {
      asset: null,
      cumulativeFundingPnl: null,
      realizedTradingPnl: null,
      feesCosts: null,
      cumulativeNetPnl: null,
      updatedAt: null,
    },
  };
}

function managementRelease() {
  return {
    releaseId: "release-1",
    arbitrageId: "arbitrage-closed",
    legId: "long-leg",
    releasedQuantity: "0.75",
    reason: "USER_CONFIRMED_STOP_MANAGEMENT",
    source: "AUTHENTICATED_API",
    requestedByUserId: "user-a",
    requestedAt: 1_800_000_002_300,
    confirmedAt: 1_800_000_002_400,
    venue: "okx",
    accountId: "okx:private-account-1234",
    instrumentId: "XAUT-USDT-PERP",
    positionMode: "ONE_WAY",
    actualQuantity: "0.25",
    actualSignedNetQuantity: "0.25",
    actualLongQuantity: "0.25",
    actualShortQuantity: "0",
    availableQuantity: null,
    realityCheckedAt: 1_800_000_002_350,
  };
}

function closeSafetyResponse() {
  return {
    activeManagedQuantity: "100.00000001",
    safeClosableQuantity: "20.00000001",
    fullManagedCloseAvailable: false,
    reason: "ONE_WAY_REALITY_INSUFFICIENT",
    checkedAt: 1_800_000_004_000,
    realityReliable: true,
    releaseEligible: true,
    hasUnresolvedExecution: false,
    releaseEligibilityReason: "RELEASE_ELIGIBLE",
    positionMode: "ONE_WAY",
    actualQuantity: "20.00000001",
    actualSignedNetQuantity: "-20.00000001",
    actualLongQuantity: "0",
    actualShortQuantity: "20.00000001",
    availableQuantity: null,
  };
}

function hedgeDeltaResponse() {
  const contribution = (legId: string, role: "LONG" | "SHORT", activeStatus: "KNOWN" | "UNKNOWN") => ({
    legId,
    role,
    marketType: "PERPETUAL",
    signedContribution: activeStatus === "KNOWN" ? role === "LONG" ? "100.00000001" : "-99.80000001" : null,
    openingSignedContribution: role === "LONG" ? "100.00000001" : "-99.80000001",
    activeManagedQuantity: "100.00000001",
    source: "PERPETUAL_CONFIRMED_EXECUTION",
    openingStatus: "KNOWN",
    openingReason: null,
    activeStatus,
    activeReason: activeStatus === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" : null,
    status: activeStatus,
    reason: activeStatus === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" : null,
  });
  return {
    arbitrageId: "arb/1",
    status: "HOLDING",
    openingDelta: { status: "KNOWN", signedDeltaBaseQuantity: "0.2", absoluteDeltaBaseQuantity: "0.2", reason: null },
    activeManagedDelta: { status: "UNKNOWN", signedDeltaBaseQuantity: null, absoluteDeltaBaseQuantity: null, reason: "EXECUTION_EVIDENCE_UNRESOLVED" },
    openingWorkflow: { secondLegRequired: true, secondLegExecutionEligible: null, requiredSecondLegSignedExposure: "-0.2" },
    legContributions: [contribution("long-leg", "LONG", "KNOWN"), contribution("short-leg", "SHORT", "UNKNOWN")],
    plannedResidualDelta: "0.1",
    actualResidualDelta: null,
    derivedAt: 1_800_000_004_000,
    deltaStatus: "UNKNOWN",
    signedDeltaBaseQuantity: null,
    absoluteDeltaBaseQuantity: null,
    currentOpeningDelta: "0.2",
    openingDeltaStatus: "KNOWN",
    requiredSecondLegSignedExposure: "-0.2",
    deltaKnown: false,
    reason: "EXECUTION_EVIDENCE_UNRESOLVED",
  };
}
