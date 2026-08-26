import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { SpotOpeningAttributionEvidence } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { InstanceHedgeDeltaService } from "./InstanceHedgeDeltaService";

test("derives zero and signed residuals from instance-attributed Spot and Perpetual exposure", async () => {
  for (const scenario of [
    { spot: "100", perp: "100", expected: "0" },
    { spot: "100", perp: "99.8", expected: "0.2" },
    { spot: "99.8", perp: "100", expected: "-0.2" },
  ]) {
    const instance = spotPerp(scenario.spot, scenario.perp);
    const result = await service(instance, { spot: scenario.spot }).derive("user-a", instance.arbitrageId);
    assert.equal(result?.deltaStatus, "KNOWN");
    assert.equal(result?.signedDeltaBaseQuantity, scenario.expected);
    assert.equal(result?.currentOpeningDelta, scenario.expected);
    assert.equal(result?.actualResidualDelta, scenario.expected);
    assert.equal(result?.openingWorkflow.secondLegRequired, false);
    assert.equal(result?.requiredSecondLegSignedExposure, null);
  }
});

test("uses role signs for ONE_WAY and HEDGE perpetual legs without account reality", async () => {
  const oneLeg = perpetualPair("100", "0");
  const oneLegResult = await service(oneLeg).derive("user-a", oneLeg.arbitrageId);
  assert.equal(oneLegResult?.currentOpeningDelta, "100");
  assert.equal(oneLegResult?.requiredSecondLegSignedExposure, "-100");
  assert.equal(oneLegResult?.openingWorkflow.secondLegRequired, true);
  assert.equal(oneLegResult?.actualResidualDelta, null);

  const hedge = perpetualPair("50", "20");
  const hedgeResult = await service(hedge).derive("user-a", hedge.arbitrageId);
  assert.deepEqual(hedgeResult?.legContributions.map((leg) => leg.openingSignedContribution), ["50", "-20"]);
  assert.equal(hedgeResult?.signedDeltaBaseQuantity, "30");
});

test("confirmed partial close reduces only active managed delta and preserves opening delta", async () => {
  const instance = perpetualPair("100", "100", { shortClosed: "25" });
  const result = await service(instance).derive("user-a", instance.arbitrageId);
  assert.equal(result?.currentOpeningDelta, "0");
  assert.equal(result?.signedDeltaBaseQuantity, "25");
  assert.deepEqual(result?.legContributions.map((leg) => leg.signedContribution), ["100", "-75"]);
});

test("management release removes a leg from active delta but retains historical opening evidence", async () => {
  const base = perpetualPair("100", "100", { longClosed: "40" });
  const instance: ArbitrageInstance = {
    ...base,
    managementReleases: [{
      releaseId: "release-long", arbitrageId: base.arbitrageId, legId: "long", releasedQuantity: "60",
      reason: "USER_CONFIRMED_STOP_MANAGEMENT", source: "AUTHENTICATED_API", requestedByUserId: "user-a",
      requestedAt: 20, confirmedAt: 21, venue: "binance", accountId: "account-a",
      instrumentId: "BTC-USDT-PERP", positionMode: "ONE_WAY", actualQuantity: "20",
      actualSignedNetQuantity: "20", actualLongQuantity: "20", actualShortQuantity: "0",
      availableQuantity: null, realityCheckedAt: 19,
    }],
  };
  const result = await service(instance).derive("user-a", instance.arbitrageId);
  assert.equal(result?.currentOpeningDelta, "0");
  assert.deepEqual(result?.legContributions.map((leg) => leg.openingSignedContribution), ["100", "-100"]);
  assert.deepEqual(result?.legContributions.map((leg) => leg.signedContribution), ["0", "-100"]);
  assert.equal(result?.signedDeltaBaseQuantity, "-100");
});

test("historically corrected FAILED opening changes Opening Delta while a release keeps Active Managed at zero", async () => {
  const base = perpetualPair("70", "100", { status: "CLOSED" });
  const correctedOpening = {
    ...base.executionReferences.find((reference) => reference.legId === "long")!,
    requestedQuantity: "100",
    confirmedQuantity: "70",
    status: "FAILED" as const,
    updatedAt: 30,
  };
  const instance: ArbitrageInstance = {
    ...base,
    closedAt: 20,
    executionReferences: [
      correctedOpening,
      ...base.executionReferences.filter((reference) => reference.legId !== "long"),
    ],
    managementReleases: [{
      releaseId: "release-long", arbitrageId: base.arbitrageId, legId: "long", releasedQuantity: "40",
      reason: "USER_CONFIRMED_STOP_MANAGEMENT", source: "AUTHENTICATED_API", requestedByUserId: "user-a",
      requestedAt: 19, confirmedAt: 20, venue: "binance", accountId: "account-a",
      instrumentId: "BTC-USDT-PERP", positionMode: "ONE_WAY", actualQuantity: "40",
      actualSignedNetQuantity: "40", actualLongQuantity: "40", actualShortQuantity: "0",
      availableQuantity: null, realityCheckedAt: 18,
    }],
  };

  const result = await service(instance).derive("user-a", instance.arbitrageId);

  assert.equal(result?.openingDelta.status, "KNOWN");
  assert.equal(result?.openingDelta.signedDeltaBaseQuantity, "-30");
  assert.equal(result?.activeManagedDelta.status, "KNOWN");
  assert.equal(result?.legContributions[0].signedContribution, "0");
  assert.equal(result?.signedDeltaBaseQuantity, "-100");
  assert.equal(result?.openingWorkflow.secondLegRequired, false);
});

test("CLOSED instance has zero active managed delta after close and release combination", async () => {
  const base = perpetualPair("100", "100", { status: "CLOSED", longClosed: "100", shortClosed: "40" });
  const instance: ArbitrageInstance = {
    ...base,
    closedAt: 30,
    managementReleases: [{
      releaseId: "release-short", arbitrageId: base.arbitrageId, legId: "short", releasedQuantity: "60",
      reason: "USER_CONFIRMED_STOP_MANAGEMENT", source: "AUTHENTICATED_API", requestedByUserId: "user-a",
      requestedAt: 29, confirmedAt: 30, venue: "binance", accountId: "account-a",
      instrumentId: "BTC-USDT-PERP", positionMode: "ONE_WAY", actualQuantity: "0",
      actualSignedNetQuantity: "0", actualLongQuantity: "0", actualShortQuantity: "0",
      availableQuantity: null, realityCheckedAt: 28,
    }],
  };
  const result = await service(instance).derive("user-a", instance.arbitrageId);
  assert.equal(result?.deltaStatus, "KNOWN");
  assert.equal(result?.signedDeltaBaseQuantity, "0");
  assert.equal(result?.currentOpeningDelta, "0");
});

test("Spot attribution and unresolved execution failures propagate UNKNOWN", async () => {
  const spot = spotPerp("100", "100");
  const unavailable = await service(spot, { error: true }).derive("user-a", spot.arbitrageId);
  assert.equal(unavailable?.deltaStatus, "UNKNOWN");
  assert.equal(unavailable?.signedDeltaBaseQuantity, null);
  assert.equal(unavailable?.reason, "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE");

  const unresolved: ArbitrageInstance = {
    ...perpetualPair("100", "0"),
    executionReferences: [{
      arbitrageId: "arb-1", legId: "short", phase: "OPENING", quantityEffect: "INCREASE",
      executionIntentId: "open-short", executionRecordId: "record-short", requestedQuantity: "100",
      confirmedQuantity: "0", status: "UNKNOWN", createdAt: 10, updatedAt: 11,
    }, confirmedReference("long", "100")],
  };
  const unknown = await service(unresolved).derive("user-a", unresolved.arbitrageId);
  assert.equal(unknown?.deltaStatus, "UNKNOWN");
  assert.equal(unknown?.reason, "EXECUTION_EVIDENCE_UNRESOLVED");
});

test("instance delta excludes account balances and other instances with the same symbol", async () => {
  const instanceA = spotPerp("10", "10", "instance-a");
  const instanceB = spotPerp("200", "30", "instance-b");
  const instances = new Map([[instanceA.arbitrageId, instanceA], [instanceB.arbitrageId, instanceB]]);
  const delta = new InstanceHedgeDeltaService(
    evidenceStore((arbitrageId) => instances.get(arbitrageId) ?? null),
    { binance: { readAttributableBaseQuantity: async (_userId, request) => request.executionIntentId.includes("instance-a") ? "10" : "200" } },
    () => 100,
  );
  const result = await delta.derive("user-a", "instance-a");
  assert.equal(result?.signedDeltaBaseQuantity, "0");
  assert.equal(result?.legContributions[0].openingSignedContribution, "10");
});

test("planned residual is signed independently from actual attributed opening delta", async () => {
  const base = spotPerp("100", "99.8");
  const instance: ArbitrageInstance = {
    ...base,
    maxResidualBaseQuantity: "0.2",
    legs: [{ ...base.legs[0], plannedQuantity: "100" }, { ...base.legs[1], plannedQuantity: "99.8" }],
  };
  const result = await service(instance, { spot: "99.9" }).derive("user-a", instance.arbitrageId);
  assert.equal(result?.plannedResidualDelta, "0.2");
  assert.equal(result?.actualResidualDelta, "0.1");
});

test("Spot uses net opening attribution once and subtracts confirmed close without repeating base commission", async () => {
  const base = spotPerp("100", "99.8");
  const instance: ArbitrageInstance = {
    ...base,
    legs: [
      { ...base.legs[0], confirmedOpenedQuantity: "99.9", plannedQuantity: "99.9", confirmedClosedQuantity: "20" },
      base.legs[1],
    ],
    executionReferences: [
      ...base.executionReferences,
      confirmedCloseReference("spot", "20"),
    ],
  };
  const result = await service(instance, { spot: "99.9" }).derive("user-a", instance.arbitrageId);
  assert.equal(result?.deltaStatus, "KNOWN");
  assert.equal(result?.currentOpeningDelta, "0.1");
  assert.equal(result?.legContributions[0].signedContribution, "79.9");
  assert.equal(result?.signedDeltaBaseQuantity, "-19.9");
});

test("persists authoritative Spot attribution and no longer needs Provider historical fills", async () => {
  const instance = spotPerp("100", "100");
  const evidence: SpotOpeningAttributionEvidence[] = [];
  let providerAvailable = true;
  let providerReads = 0;
  const delta = new InstanceHedgeDeltaService(
    evidenceStore(() => instance, evidence),
    { binance: { readAttributableBaseQuantity: async () => {
      providerReads += 1;
      if (!providerAvailable) throw new Error("history expired");
      return "99.9";
    } } },
    () => 100,
  );
  const first = await delta.derive("user-a", instance.arbitrageId);
  providerAvailable = false;
  const second = await delta.derive("user-a", instance.arbitrageId);
  assert.equal(first?.openingDelta.status, "KNOWN");
  assert.equal(second?.openingDelta.signedDeltaBaseQuantity, "-0.1");
  assert.equal(providerReads, 1);
  assert.equal(evidence[0]?.attributableBaseQuantity, "99.9");
});

test("keeps Opening KNOWN when an active close execution becomes UNKNOWN", async () => {
  const base = perpetualPair("100", "100");
  const instance: ArbitrageInstance = {
    ...base,
    executionReferences: [...base.executionReferences, {
      arbitrageId: base.arbitrageId, legId: "short", phase: "CLOSING", quantityEffect: "DECREASE",
      executionIntentId: "close-short", executionRecordId: "close-record", requestedQuantity: "20",
      confirmedQuantity: "0", status: "UNKNOWN", createdAt: 20, updatedAt: 21,
    }],
  };
  const result = await service(instance).derive("user-a", instance.arbitrageId);
  assert.equal(result?.openingDelta.status, "KNOWN");
  assert.equal(result?.openingDelta.signedDeltaBaseQuantity, "0");
  assert.equal(result?.activeManagedDelta.status, "UNKNOWN");
});

test("released Spot is active zero while missing historical evidence remains Opening UNKNOWN", async () => {
  const base = spotPerp("100", "100");
  const instance: ArbitrageInstance = {
    ...base,
    managementReleases: [{
      releaseId: "release-spot", arbitrageId: base.arbitrageId, legId: "spot", releasedQuantity: "100",
      reason: "USER_CONFIRMED_STOP_MANAGEMENT", source: "AUTHENTICATED_API", requestedByUserId: "user-a",
      requestedAt: 20, confirmedAt: 21, venue: "binance", accountId: "account-a",
      instrumentId: "BTC-USDT-SPOT", positionMode: "ONE_WAY", actualQuantity: "0",
      actualSignedNetQuantity: "0", actualLongQuantity: "0", actualShortQuantity: "0",
      availableQuantity: "0", realityCheckedAt: 19,
    }],
  };
  const result = await service(instance, { error: true }).derive("user-a", instance.arbitrageId);
  assert.equal(result?.openingDelta.status, "UNKNOWN");
  assert.equal(result?.activeManagedDelta.status, "KNOWN");
  assert.equal(result?.legContributions[0].signedContribution, "0");
});

test("released Spot keeps historical Opening KNOWN from local evidence without Provider history", async () => {
  const base = spotPerp("100", "100");
  const instance: ArbitrageInstance = {
    ...base,
    managementReleases: [{
      releaseId: "release-spot", arbitrageId: base.arbitrageId, legId: "spot", releasedQuantity: "100",
      reason: "USER_CONFIRMED_STOP_MANAGEMENT", source: "AUTHENTICATED_API", requestedByUserId: "user-a",
      requestedAt: 20, confirmedAt: 21, venue: "binance", accountId: "account-a",
      instrumentId: "BTC-USDT-SPOT", positionMode: "ONE_WAY", actualQuantity: "0",
      actualSignedNetQuantity: "0", actualLongQuantity: "0", actualShortQuantity: "0",
      availableQuantity: "0", realityCheckedAt: 19,
    }],
  };
  const opening = instance.executionReferences.find((reference) => reference.legId === "spot")!;
  const evidence: SpotOpeningAttributionEvidence[] = [{
    arbitrageId: instance.arbitrageId, legId: "spot", executionIntentId: opening.executionIntentId,
    executionRecordId: opening.executionRecordId!, attributableBaseQuantity: "99.9",
    source: "PROVIDER_ORDER_FILLS", confirmedAt: 10, venue: "binance", accountId: "account-a",
    instrumentId: "BTC-USDT-SPOT",
  }];
  const delta = new InstanceHedgeDeltaService(
    evidenceStore(() => instance, evidence),
    { binance: { readAttributableBaseQuantity: async () => { throw new Error("must not query"); } } },
    () => 100,
  );
  const result = await delta.derive("user-a", instance.arbitrageId);
  assert.equal(result?.openingDelta.status, "KNOWN");
  assert.equal(result?.openingDelta.signedDeltaBaseQuantity, "-0.1");
  assert.equal(result?.activeManagedDelta.status, "KNOWN");
  assert.equal(result?.legContributions[0].signedContribution, "0");
});

function service(instance: ArbitrageInstance, spot: { spot?: string; error?: boolean } = {}) {
  return new InstanceHedgeDeltaService(
    evidenceStore((arbitrageId) => arbitrageId === instance.arbitrageId ? instance : null),
    { binance: { readAttributableBaseQuantity: async () => {
      if (spot.error) throw new Error("unavailable");
      return spot.spot ?? "0";
    } } },
    () => 100,
  );
}

function evidenceStore(
  get: (arbitrageId: string) => ArbitrageInstance | null,
  evidence: SpotOpeningAttributionEvidence[] = [],
) {
  return {
    get: (userId: string, arbitrageId: string) => {
      const instance = get(arbitrageId);
      return instance?.userId === userId ? instance : null;
    },
    readSpotOpeningAttributionEvidence: (_userId: string, arbitrageId: string, legId: string) =>
      evidence.filter((item) => item.arbitrageId === arbitrageId && item.legId === legId),
    recordSpotOpeningAttributionEvidence: (_userId: string, item: SpotOpeningAttributionEvidence) => {
      const existing = evidence.find((candidate) => candidate.executionIntentId === item.executionIntentId);
      if (existing) return existing;
      evidence.push(item);
      return item;
    },
  };
}

function spotPerp(spot: string, perp: string, arbitrageId = "arb-1"): ArbitrageInstance {
  return instance(arbitrageId, [
    { legId: "spot", role: "LONG", instrumentId: "BTC-USDT-SPOT", quantity: spot },
    { legId: "short", role: "SHORT", instrumentId: "BTC-USDT-PERP", quantity: perp },
  ]);
}

function perpetualPair(long: string, short: string, options: {
  status?: ArbitrageInstance["status"];
  longClosed?: string;
  shortClosed?: string;
} = {}): ArbitrageInstance {
  return instance("arb-1", [
    { legId: "long", role: "LONG", instrumentId: "BTC-USDT-PERP", quantity: long, closed: options.longClosed },
    { legId: "short", role: "SHORT", instrumentId: "BTC-USDT-PERP", quantity: short, closed: options.shortClosed },
  ], options.status);
}

function instance(
  arbitrageId: string,
  legs: readonly [{ legId: string; role: "LONG"; instrumentId: string; quantity: string; closed?: string },
    { legId: string; role: "SHORT"; instrumentId: string; quantity: string; closed?: string }],
  status: ArbitrageInstance["status"] = "HOLDING",
): ArbitrageInstance {
  return {
    arbitrageId, userId: "user-a", strategyType: legs[0].instrumentId.endsWith("SPOT") ? "SPOT_PERPETUAL" : "PERPETUAL_PERPETUAL",
    sourcePlanId: null, maxResidualBaseQuantity: "0", status, createdAt: 1, openedAt: 2,
    updatedAt: 10, closedAt: null,
    legs: legs.map((leg) => ({
      legId: leg.legId, role: leg.role, venue: "binance" as const, accountId: "account-a",
      instrumentId: leg.instrumentId, plannedQuantity: leg.quantity,
      confirmedOpenedQuantity: leg.quantity, confirmedClosedQuantity: leg.closed ?? "0",
    })) as unknown as ArbitrageInstance["legs"],
    executionReferences: legs.flatMap((leg) => [
      ...(leg.quantity === "0" ? [] : [confirmedReference(leg.legId, leg.quantity, arbitrageId)]),
      ...(leg.closed && leg.closed !== "0" ? [confirmedCloseReference(leg.legId, leg.closed, arbitrageId)] : []),
    ]),
    managementReleases: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}

function confirmedReference(legId: string, quantity: string, arbitrageId = "arb-1") {
  return {
    arbitrageId, legId, phase: "OPENING" as const, quantityEffect: "INCREASE" as const,
    executionIntentId: `open-${legId}-${arbitrageId}`, executionRecordId: `record-${legId}-${arbitrageId}`,
    requestedQuantity: quantity, confirmedQuantity: quantity, status: "CONFIRMED" as const,
    createdAt: 3, updatedAt: 4,
  };
}

function confirmedCloseReference(legId: string, quantity: string, arbitrageId = "arb-1") {
  return {
    arbitrageId, legId, phase: "CLOSING" as const, quantityEffect: "DECREASE" as const,
    executionIntentId: `close-${legId}-${arbitrageId}`, executionRecordId: `close-record-${legId}-${arbitrageId}`,
    requestedQuantity: quantity, confirmedQuantity: quantity, status: "CONFIRMED" as const,
    createdAt: 8, updatedAt: 9,
  };
}
