import assert from "node:assert/strict";
import test from "node:test";
import {
  subtractUnsignedDecimals,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import { ArbitrageInstanceExitService } from "./ArbitrageInstanceExitService";

test("one instance command closes both legs through the existing close service in server order", async () => {
  const fixture = setup();
  const result = await fixture.service.exit("user-a", exitRequest());

  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["short-leg", "long-leg"]);
  assert.equal(new Set(fixture.closeCalls.map((call) => call.commandId)).size, 2);
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.instance.status, "CLOSED");
});

test("instance exit skips a released leg and never asks CloseService to mutate it", async () => {
  const fixture = setup({ releasedShort: true });
  const result = await fixture.service.exit("user-a", exitRequest("released-short"));

  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["long-leg"]);
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.instance.status, "CLOSED");
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "0");
});

test("sequential instance exit requests reuse the CLOSED lifecycle without another closing execution", async () => {
  const fixture = setup();
  const first = await fixture.service.exit("user-a", exitRequest("sequential-a"));
  const second = await fixture.service.exit("user-a", exitRequest("sequential-b"));

  assert.equal(first.status, "CONFIRMED");
  assert.equal(second.status, "CONFIRMED");
  assert.equal(first.instance.status, "CLOSED");
  assert.equal(second.instance.status, "CLOSED");
  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["short-leg", "long-leg"]);
  assert.equal(fixture.lifecycleApplyCount(), 2);
});

test("concurrent instance exit requests share one orchestration for the arbitrageId", async () => {
  const fixture = setup();
  const first = fixture.service.exit("user-a", exitRequest("concurrent-a"));
  const duplicate = fixture.service.exit("user-a", exitRequest("concurrent-b"));
  await fixture.firstLegCompleted;
  fixture.releaseSecondLeg();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

  assert.strictEqual(firstResult, duplicateResult);
  assert.equal(firstResult.instance.status, "CLOSED");
  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["short-leg", "long-leg"]);
  assert.equal(new Set(firstResult.legs.map((leg) => leg.executionId)).size, 2);
  assert.equal(fixture.lifecycleApplyCount(), 2);
});

test("server continues the second leg without browser participation after the first leg confirms", async () => {
  const fixture = setup();
  const operation = fixture.service.exit("user-a", exitRequest("browser-disconnected"));
  await fixture.firstLegCompleted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["short-leg", "long-leg"]);
  fixture.releaseSecondLeg();

  const result = await operation;
  assert.equal(result.instance.status, "CLOSED");
});

test("two-leg Exit records C1-C4 without a server-side inter-leg delay", async (t) => {
  const milliseconds = (end: bigint, start: bigint) => Number(end - start) / 1_000_000;
  for (let run = 1; run <= 5; run += 1) {
    await t.test(`fake provider run ${run}`, async (child) => {
      const marks: Partial<Record<"c1" | "c2" | "c3" | "c4", bigint>> = {};
      const fixture = setup({
        timing: {
          firstAuthoritative: () => { marks.c1 = process.hrtime.bigint(); },
          firstDurable: () => { marks.c2 = process.hrtime.bigint(); },
          secondSafetyReady: () => { marks.c3 = process.hrtime.bigint(); },
          secondDispatch: () => { marks.c4 = process.hrtime.bigint(); },
        },
      });

      const result = await fixture.service.exit("user-a", exitRequest(`exit-timing-${run}`));

      assert.equal(result.status, "CONFIRMED");
      assert.ok(marks.c1 && marks.c2 && marks.c3 && marks.c4);
      assert.ok(marks.c1 <= marks.c2);
      assert.ok(marks.c2 <= marks.c3);
      assert.ok(marks.c3 <= marks.c4);
      child.diagnostic(JSON.stringify({ run,
        "C2-C1-ms": milliseconds(marks.c2, marks.c1),
        "C3-C2-ms": milliseconds(marks.c3, marks.c2),
        "C4-C3-ms": milliseconds(marks.c4, marks.c3),
        "C4-C2-ms": milliseconds(marks.c4, marks.c2),
      }));
    });
  }
});

test("first-leg FAILED, UNKNOWN, or pending reconciliation stops before the second leg", async (context) => {
  for (const status of ["FAILED", "UNKNOWN", "PENDING_CONFIRMATION"] as const) {
    await context.test(status, async () => {
      const fixture = setup({ firstStatus: status });
      const result = await fixture.service.exit("user-a", exitRequest(`${status.toLowerCase()}-first`));

      assert.equal(result.status, "STOPPED");
      assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["short-leg"]);
      assert.equal(result.instance.status, "CLOSING");
    });
  }
});

test("a defensive fake partial-CONFIRMED close stops before the next leg", async () => {
  const fixture = setup({ firstStatus: "CONFIRMED", firstConfirmedQuantity: "0.4" });
  const result = await fixture.service.exit("user-a", exitRequest("fake-partial-confirmed"));

  assert.equal(result.status, "STOPPED");
  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["short-leg"]);
});

test("one-click exit closes the legal quantity, releases quantity-step dust, and reaches CLOSED", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "59",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
    verifiedActualQuantity: "61.795",
  });
  const result = await fixture.service.exit("user-a", exitRequest("accepted-residual"));

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.instance.status, "CLOSED");
  assert.equal(result.instance.maxResidualBaseQuantity, "0.94");
  assert.deepEqual(fixture.closeCalls.map((call) => [call.legId, call.quantity]), [
    ["long-leg", "59"],
    ["short-leg", "59"],
  ]);
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "59");
  assert.equal(result.instance.legs[0].confirmedClosedQuantity, "59");
  assert.equal(result.instance.managementReleases?.[0]?.releasedQuantity, "0.94");
  assert.equal(subtractUnsignedDecimals("61.795", "59"), "2.795");
  assert.equal(subtractUnsignedDecimals("2.795", "0.94"), "1.855");
  assert.equal(fixture.releaseCalls.length, 1);
  assert.equal(fixture.releaseCalls[0]?.legId, "long-leg");
  assert.equal(result.timing?.secondLegExitDelayMs, 1);
  assert.ok(result.timing!.secondLegExitDelayMs <= 3_000);
});

test("SPOT_PERPETUAL joint preflight rejects an unsafe perpetual before either Provider mutation", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "59",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
    unsafeLegId: "short-leg",
    unsafeReason: "PROVIDER_REALITY_UNAVAILABLE",
  });

  const result = await fixture.service.exit("user-a", exitRequest("joint-preflight-perp-unsafe"));

  assert.equal(result.status, "STOPPED");
  assert.equal(result.stop?.phase, "JOINT_PREFLIGHT");
  assert.equal(result.stop?.failedLegId, "short-leg");
  assert.equal(fixture.closeCalls.length, 0);
});

test("Spot confirmation failure stops before the perpetual protection leg is touched", async (t) => {
  for (const status of ["FAILED", "UNKNOWN", "PENDING_CONFIRMATION"] as const) {
    await t.test(status, async () => {
      const fixture = setup({
        longOpenedQuantity: "59.94",
        shortOpenedQuantity: "59",
        legalSpotCloseQuantity: "59",
        residual: "0.94",
        firstStatus: status,
      });
      const result = await fixture.service.exit("user-a", exitRequest(`spot-${status}`));
      assert.equal(result.status, "STOPPED");
      assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["long-leg"]);
    });
  }
});

test("temporary perpetual Reality failure retries reads only and dispatches one close", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "59",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
    transientPerpetualReadFailuresAfterSpot: 1,
  });
  const result = await fixture.service.exit("user-a", exitRequest("temporary-perp-read"));
  assert.equal(result.status, "CONFIRMED");
  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["long-leg", "short-leg"]);
  assert.ok(fixture.safetyCalls("short-leg") >= 3);
});

test("persistent perpetual Reality failure exhausts the bounded read budget without repeating Spot", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "59",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
    transientPerpetualReadFailuresAfterSpot: 10,
  });
  const result = await fixture.service.exit("user-a", exitRequest("persistent-perp-read"));
  assert.equal(result.status, "STOPPED");
  assert.equal(result.stop?.phase, "PERPETUAL_FRESH_SAFETY");
  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["long-leg"]);
});

test("a concrete perpetual position conflict after Spot confirmation is not retried", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "59",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
    postSpotPerpetualReason: "ONE_WAY_REALITY_INSUFFICIENT",
  });
  const result = await fixture.service.exit("user-a", exitRequest("perp-business-conflict"));
  assert.equal(result.status, "STOPPED");
  assert.equal(result.stop?.reason, "ONE_WAY_REALITY_INSUFFICIENT");
  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["long-leg"]);
  assert.equal(fixture.safetyCalls("short-leg"), 2);
});

test("restart-like explicit Exit skips a historically closed perpetual and completes Spot dust without reopening it", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "0",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
  });
  const result = await fixture.service.exit("user-a", exitRequest("residual-spot-only"));
  assert.equal(result.status, "CONFIRMED");
  assert.deepEqual(fixture.closeCalls.map((call) => [call.legId, call.quantity]), [["long-leg", "59"]]);
  assert.equal(fixture.releaseCalls[0]?.legId, "long-leg");
});

test("account dust remains independent while quantity-step dust is explicitly released", async () => {
  const fixture = setup({ residual: "0.006", verifiedActualQuantity: "0.011" });
  const closed = await fixture.service.exit("user-a", exitRequest("dust-independent"));
  const reconciled = await fixture.service.reconcile("user-a", { arbitrageId: closed.instance.arbitrageId });

  assert.equal(closed.instance.status, "CLOSED");
  assert.equal(reconciled.instance.status, "CLOSED");
  assert.equal(reconciled.verification.legs[0].actualQuantity, "0.011");
  assert.equal(closed.instance.legs[0].confirmedClosedQuantity, "0.994");
  assert.equal(closed.instance.managementReleases?.[0]?.releasedQuantity, "0.006");
});

test("instance preflight stops every Provider mutation for Reality, attribution, or rule conflicts", async (t) => {
  for (const reason of [
    "PROVIDER_REALITY_UNAVAILABLE",
    "SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT",
    "SPOT_AVAILABLE_BALANCE_UNAVAILABLE",
    "TRADING_RULES_REJECT_FULL_QUANTITY",
  ] as const) {
    await t.test(reason, async () => {
      const fixture = setup({ unsafeLegId: "long-leg", unsafeReason: reason });
      const result = await fixture.service.exit("user-a", exitRequest(`unsafe-${reason}`));

      assert.equal(result.status, "STOPPED");
      assert.equal(result.instance.status, "HOLDING");
      assert.equal(fixture.closeCalls.length, 0);
      assert.equal(fixture.releaseCalls.length, 0);
    });
  }
});

test("instance exit remains mutation-free while any opening or closing execution is unresolved", async () => {
  const fixture = setup({ unresolvedStatus: "UNKNOWN" });
  const result = await fixture.service.exit("user-a", exitRequest("unresolved-opening"));

  assert.equal(result.status, "STOPPED");
  assert.equal(fixture.closeCalls.length, 0);
  assert.equal(fixture.releaseCalls.length, 0);
});

function setup(options: Readonly<{
  firstStatus?: "CONFIRMED" | "FAILED" | "UNKNOWN" | "PENDING_CONFIRMATION";
  firstConfirmedQuantity?: string;
  residual?: string;
  verifiedActualQuantity?: string;
  longOpenedQuantity?: string;
  shortOpenedQuantity?: string;
  legalSpotCloseQuantity?: string;
  unsafeLegId?: string;
  unsafeReason?: "PROVIDER_REALITY_UNAVAILABLE" | "SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT"
    | "SPOT_AVAILABLE_BALANCE_UNAVAILABLE" | "TRADING_RULES_REJECT_FULL_QUANTITY";
  unresolvedStatus?: "CLAIMED" | "LINKED" | "PENDING_CONFIRMATION" | "UNKNOWN";
  releasedShort?: boolean;
  timing?: Readonly<{
    firstAuthoritative(): void;
    firstDurable(): void;
    secondSafetyReady(): void;
    secondDispatch(): void;
  }>;
  transientPerpetualReadFailuresAfterSpot?: number;
  postSpotPerpetualReason?: "ONE_WAY_REALITY_INSUFFICIENT" | "HEDGE_BUCKET_INSUFFICIENT";
}> = {}) {
  let instance = baseInstance(
    options.longOpenedQuantity,
    options.shortOpenedQuantity,
    options.residual === undefined ? "DOGE-USDT-PERP" : "DOGE-USDT-SPOT",
  );
  if (options.unresolvedStatus) {
    instance = {
      ...instance,
      executionReferences: [{
        arbitrageId: instance.arbitrageId,
        executionIntentId: "unresolved-opening-intent",
        executionRecordId: "unresolved-opening-record",
        legId: "long-leg",
        phase: "OPENING",
        quantityEffect: "INCREASE",
        requestedQuantity: instance.legs[0].confirmedOpenedQuantity,
        confirmedQuantity: "0",
        status: options.unresolvedStatus,
        createdAt: 1_800_000_000_021,
        updatedAt: 1_800_000_000_022,
      }],
    };
  }
  if (options.releasedShort) {
    instance = {
      ...instance,
      status: "RESIDUAL",
      managementReleases: [{
        releaseId: "release-short", arbitrageId: instance.arbitrageId, legId: "short-leg",
        releasedQuantity: "1", reason: "USER_CONFIRMED_STOP_MANAGEMENT", source: "AUTHENTICATED_API",
        requestedByUserId: "user-a", requestedAt: 1_800_000_000_030, confirmedAt: 1_800_000_000_031,
        venue: "bybit", accountId: "account-a", instrumentId: "DOGE-USDT-PERP", positionMode: "ONE_WAY",
        actualQuantity: "0", actualSignedNetQuantity: "0", actualLongQuantity: "0", actualShortQuantity: "0",
        availableQuantity: null, realityCheckedAt: 1_800_000_000_029,
      }],
    };
  }
  let lifecycleApplyCount = 0;
  const safetyCallCounts = new Map<string, number>();
  const closeCalls: Array<{ legId: string; commandId: string; quantity: string }> = [];
  const releaseCalls: Array<{ legId: string; commandId: string }> = [];
  let releaseSecondLeg: () => void = () => undefined;
  const secondLegGate = new Promise<void>((resolve) => { releaseSecondLeg = resolve; });
  let completeFirstLeg: () => void = () => undefined;
  const firstLegCompleted = new Promise<void>((resolve) => { completeFirstLeg = resolve; });
  const closeService = {
    async evaluateCloseSafety(_userId: string, _arbitrageId: string, legId: string) {
      safetyCallCounts.set(legId, (safetyCallCounts.get(legId) ?? 0) + 1);
      const leg = instance.legs.find((candidate) => candidate.legId === legId)!;
      if (legId === options.unsafeLegId) {
        const active = String(Number(leg.confirmedOpenedQuantity) - Number(leg.confirmedClosedQuantity));
        return {
          activeManagedQuantity: active,
          safeClosableQuantity: "0",
          fullManagedCloseAvailable: false,
          reason: options.unsafeReason!,
          checkedAt: 1_800_000_000_050,
          positionMode: options.unsafeReason === "PROVIDER_REALITY_UNAVAILABLE" ? null : "ONE_WAY",
          actualQuantity: options.unsafeReason === "PROVIDER_REALITY_UNAVAILABLE" ? null : active,
          actualSignedNetQuantity: options.unsafeReason === "PROVIDER_REALITY_UNAVAILABLE" ? null : active,
          actualLongQuantity: options.unsafeReason === "PROVIDER_REALITY_UNAVAILABLE" ? null : active,
          actualShortQuantity: options.unsafeReason === "PROVIDER_REALITY_UNAVAILABLE" ? null : "0",
          availableQuantity: options.unsafeReason === "PROVIDER_REALITY_UNAVAILABLE" ? null : active,
        } as const;
      }
      const spotHasClosed = instance.legs[0].confirmedClosedQuantity !== "0";
      const perpetualReadNumber = safetyCallCounts.get(legId) ?? 0;
      if (legId === "short-leg" && spotHasClosed && options.postSpotPerpetualReason) {
        return {
          activeManagedQuantity: activeManagedFor(leg), safeClosableQuantity: "0",
          fullManagedCloseAvailable: false, reason: options.postSpotPerpetualReason,
          checkedAt: 1_800_000_000_050, positionMode: "ONE_WAY", actualQuantity: "0",
          actualSignedNetQuantity: "0", actualLongQuantity: "0", actualShortQuantity: "0",
          availableQuantity: null,
        } as const;
      }
      if (legId === "short-leg" && spotHasClosed
        && perpetualReadNumber <= 1 + (options.transientPerpetualReadFailuresAfterSpot ?? 0)) {
        return {
          activeManagedQuantity: activeManagedFor(leg), safeClosableQuantity: "0",
          fullManagedCloseAvailable: false, reason: "PROVIDER_REALITY_UNAVAILABLE",
          checkedAt: 1_800_000_000_050, positionMode: null, actualQuantity: null,
          actualSignedNetQuantity: null, actualLongQuantity: null, actualShortQuantity: null,
          availableQuantity: null,
        } as const;
      }
      const residualLeg = options.residual !== undefined && legId === "long-leg";
      const active = residualLeg && leg.confirmedClosedQuantity === (options.legalSpotCloseQuantity ?? "0.994")
        ? options.residual!
        : String(Number(leg.confirmedOpenedQuantity) - Number(leg.confirmedClosedQuantity));
      const dustAfterClose = residualLeg && active === options.residual;
      const safe = residualLeg ? (dustAfterClose ? "0" : (options.legalSpotCloseQuantity ?? "0.994")) : active;
      return {
        activeManagedQuantity: active,
        safeClosableQuantity: safe,
        fullManagedCloseAvailable: !residualLeg,
        reason: residualLeg ? "QUANTITY_STEP_DUST" : "FULL_MANAGED_CLOSE_AVAILABLE",
        checkedAt: 1_800_000_000_050,
        positionMode: "ONE_WAY",
        actualQuantity: options.verifiedActualQuantity ?? active,
        actualSignedNetQuantity: active,
        actualLongQuantity: active,
        actualShortQuantity: "0",
        availableQuantity: options.verifiedActualQuantity ?? active,
      } as const;
    },
    async closeLeg(_userId: string, input: any) {
      const first = closeCalls.length === 0;
      closeCalls.push({ legId: input.legId, commandId: input.commandId, quantity: input.quantity });
      if (!first) options.timing?.secondSafetyReady();
      const status = first ? (options.firstStatus ?? "CONFIRMED") : "CONFIRMED";
      if (first) options.timing?.firstAuthoritative();
      else options.timing?.secondDispatch();
      if (first && status !== "CONFIRMED") {
        instance = { ...instance, status: "CLOSING" };
      } else {
        lifecycleApplyCount += 1;
        const legs = instance.legs.map((leg) => leg.legId !== input.legId ? leg : {
          ...leg,
          confirmedClosedQuantity: input.quantity,
        }) as unknown as ArbitrageInstance["legs"];
        const allManagedComplete = legs.every((leg) => leg.confirmedOpenedQuantity === leg.confirmedClosedQuantity
          || instance.managementReleases?.some((release) => release.legId === leg.legId));
        instance = {
          ...instance,
          legs,
          status: allManagedComplete ? "CLOSED" : first ? "CLOSING" : options.residual ? "RESIDUAL" : "CLOSED",
          maxResidualBaseQuantity: first ? instance.maxResidualBaseQuantity : (options.residual ?? "0"),
        };
      }
      if (first) options.timing?.firstDurable();
      if (first) completeFirstLeg();
      else await secondLegGate;
      return {
        instance,
        executionRecord: {
          executionId: `record-${input.legId}`,
          intentId: `intent-${input.legId}`,
          status,
          plannedQuantity: input.quantity,
          confirmedQuantity: options.firstConfirmedQuantity ?? (status === "CONFIRMED" ? input.quantity : "0"),
          verifiedAt: first ? 1_800_000_000_100 : 1_800_000_000_101,
        },
        providerDispatchStartedAt: first ? 1_800_000_000_090 : 1_800_000_000_101,
        idempotentReplay: false,
        secondLegAllowed: false,
      };
    },
  };
  const managementRelease = {
    async releaseDustAfterClose(_userId: string, input: any) {
      releaseCalls.push({ legId: input.legId, commandId: input.commandId });
      const leg = instance.legs.find((candidate) => candidate.legId === input.legId)!;
      const releasedQuantity = options.residual
        ?? String(Number(leg.confirmedOpenedQuantity) - Number(leg.confirmedClosedQuantity));
      instance = {
        ...instance,
        status: "CLOSED",
        managementReleases: [{
          releaseId: `release-${input.legId}`, arbitrageId: instance.arbitrageId, legId: input.legId,
          releasedQuantity, reason: "USER_CONFIRMED_STOP_MANAGEMENT", source: "AUTHENTICATED_API",
          requestedByUserId: "user-a", requestedAt: 1_800_000_000_110, confirmedAt: 1_800_000_000_120,
          venue: leg.venue, accountId: leg.accountId, instrumentId: leg.instrumentId, positionMode: "ONE_WAY",
          actualQuantity: options.verifiedActualQuantity ?? releasedQuantity, actualSignedNetQuantity: releasedQuantity,
          actualLongQuantity: releasedQuantity, actualShortQuantity: "0", availableQuantity: releasedQuantity,
          realityCheckedAt: 1_800_000_000_100,
        }],
      };
      return { instance, release: instance.managementReleases![0], idempotentReplay: false };
    },
  };
  const service = new ArbitrageInstanceExitService(
    { get: () => instance } as any,
    closeService as any,
    managementRelease as any,
    { reconcileLeg: async () => assert.fail("no unresolved reference") } as any,
    {
      verify: async () => ({
        arbitrageId: instance.arbitrageId,
        checkedAt: 1_800_000_000_200,
        legs: instance.legs.map((leg, index) => ({
          arbitrageId: instance.arbitrageId,
          legId: leg.legId,
          expectedManagedQuantity: "0",
          actualQuantity: index === 0 ? (options.verifiedActualQuantity ?? "0") : "0",
          actualSignedNetQuantity: "0",
          availableQuantity: null,
          verificationStatus: "MATCHED" as const,
          reason: null,
          checkedAt: 1_800_000_000_200,
        })) as any,
      }),
    } as any,
    { now: () => 1_800_000_000_000, sleep: async () => undefined },
  );
  if (options.firstStatus !== undefined && options.firstStatus !== "CONFIRMED") releaseSecondLeg();
  if (options.firstStatus === undefined && options.residual !== undefined) releaseSecondLeg();
  if (options.verifiedActualQuantity !== undefined) releaseSecondLeg();
  if (options.firstStatus === undefined && options.residual === undefined) queueMicrotask(releaseSecondLeg);
  return {
    service, closeCalls, releaseCalls, firstLegCompleted, releaseSecondLeg,
    lifecycleApplyCount: () => lifecycleApplyCount,
    safetyCalls: (legId: string) => safetyCallCounts.get(legId) ?? 0,
  };
}

function activeManagedFor(leg: ArbitrageInstance["legs"][number]) {
  return String(Number(leg.confirmedOpenedQuantity) - Number(leg.confirmedClosedQuantity));
}

function baseInstance(
  longOpenedQuantity = "1",
  shortOpenedQuantity = "1",
  longInstrumentId = "DOGE-USDT-PERP",
): ArbitrageInstance {
  return {
    arbitrageId: "arbitrage-exit-1",
    userId: "user-a",
    strategyType: longInstrumentId.endsWith("-SPOT") ? "SPOT_PERPETUAL" : "PERPETUAL_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0",
    status: "HOLDING",
    createdAt: 1_800_000_000_000,
    openedAt: 1_800_000_000_010,
    updatedAt: 1_800_000_000_020,
    closedAt: null,
    legs: [{
      legId: "long-leg", role: "LONG", venue: "bybit", accountId: "account-a",
      instrumentId: longInstrumentId, plannedQuantity: longOpenedQuantity,
      confirmedOpenedQuantity: longOpenedQuantity, confirmedClosedQuantity: "0",
    }, {
      legId: "short-leg", role: "SHORT", venue: "bybit", accountId: "account-a",
      instrumentId: "DOGE-USDT-PERP", plannedQuantity: shortOpenedQuantity,
      confirmedOpenedQuantity: shortOpenedQuantity, confirmedClosedQuantity: "0",
    }],
    executionReferences: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}

function exitRequest(commandId = "exit-command") {
  return { arbitrageId: "arbitrage-exit-1", commandId, executionMode: "EXECUTION_PRIORITY", confirmed: true };
}
