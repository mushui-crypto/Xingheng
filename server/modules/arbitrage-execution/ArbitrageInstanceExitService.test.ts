import assert from "node:assert/strict";
import test from "node:test";
import {
  subtractUnsignedDecimals,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import { ArbitrageExecutionCloseError } from "./ArbitrageExecutionCloseService";
import { ArbitrageInstanceExitService } from "./ArbitrageInstanceExitService";
import { ArbitrageManagementReleaseError } from "./ArbitrageManagementReleaseService";

test("one instance command closes both legs through the existing close service in server order", async () => {
  const fixture = setup();
  const result = await fixture.service.exit("user-a", exitRequest());

  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["short-leg", "long-leg"]);
  assert.equal(new Set(fixture.closeCalls.map((call) => call.commandId)).size, 2);
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.instance.status, "CLOSED");
  assert.equal(fixture.outcomeAudits.length, 1);
  assert.equal(fixture.outcomeAudits[0]?.terminalStatus, "CONFIRMED");
});

test("Exit STOPPED outcome is audited once with the structured stop snapshot", async () => {
  const fixture = setup({ unsafeLegId: "short-leg", unsafeReason: "PROVIDER_REALITY_UNAVAILABLE" });
  const request = exitRequest("stopped-audit");
  const first = await fixture.service.exit("user-a", request);
  const replay = await fixture.service.exit("user-a", request);
  assert.equal(first.status, "STOPPED");
  assert.equal(replay.status, "STOPPED");
  assert.equal(fixture.outcomeAudits.length, 1);
  assert.equal(fixture.outcomeAudits[0]?.stopPhase, "JOINT_PREFLIGHT");
  assert.equal(fixture.outcomeAudits[0]?.stopReason, "PROVIDER_REALITY_UNAVAILABLE");
  assert.equal(fixture.outcomeAudits[0]?.failedLegId, "short-leg");
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

test("one-click exit preserves structured dust release stop diagnostics", async (t) => {
  for (const [category, reason] of [
    ["dust_release_reality_unavailable", "DUST_RELEASE_REALITY_UNAVAILABLE"],
    ["dust_release_eligibility_changed", "DUST_RELEASE_ELIGIBILITY_CHANGED"],
    ["dust_release_attribution_unavailable", "DUST_RELEASE_ATTRIBUTION_UNAVAILABLE"],
    ["dust_release_provider_read_failed", "DUST_RELEASE_PROVIDER_READ_FAILED"],
  ] as const) {
    await t.test(category, async () => {
      const fixture = setup({
        longOpenedQuantity: "59.94",
        shortOpenedQuantity: "59",
        legalSpotCloseQuantity: "59",
        residual: "0.94",
        releaseErrorCategory: category,
      });
      const result = await fixture.service.exit("user-a", exitRequest(category));
      assert.equal(result.status, "STOPPED");
      assert.equal(result.stop?.phase, "SPOT_DUST_RELEASE");
      assert.equal(result.stop?.reason, reason);
      assert.equal(fixture.releaseCalls.length, 1);
    });
  }
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
  assert.equal(fixture.safetyCalls("short-leg"), 1);
  assert.equal(fixture.mutationSafetyCalls("short-leg"), 2);
  assert.deepEqual(fixture.mutationSafetyDeadlines("short-leg"), [1_800_000_015_000, 1_800_000_015_000]);
});

test("authoritative NOT_DISPATCHED perpetual close retries with fresh safety and completes the same Exit", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "59",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
    perpetualPreMutationFailures: 1,
  });
  const result = await fixture.service.exit("user-a", exitRequest("perp-not-dispatched-retry"));

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.instance.status, "CLOSED");
  assert.equal(fixture.closeCalls.filter(({ legId }) => legId === "short-leg").length, 2);
  assert.equal(fixture.providerMutationCalls.filter((legId) => legId === "short-leg").length, 1);
  assert.equal(fixture.mutationSafetyCalls("short-leg"), 2);
  assert.equal(new Set(fixture.closeCalls.filter(({ legId }) => legId === "short-leg").map(({ commandId }) => commandId)).size, 2);
  assert.equal(fixture.outcomeAudits[0]?.mutationDisposition, "NOT_DISPATCHED");
  assert.equal(fixture.outcomeAudits[0]?.failureStage, "PRE_MUTATION");
  assert.equal(fixture.outcomeAudits[0]?.diagnosticCategory, "POSITION_MODE_UNAVAILABLE");
});

test("repeated NOT_DISPATCHED perpetual closes exhaust bounded attempts without a Provider mutation", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "59",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
    perpetualPreMutationFailures: 3,
  });
  const result = await fixture.service.exit("user-a", exitRequest("perp-not-dispatched-exhausted"));

  assert.equal(result.status, "STOPPED");
  assert.equal(result.stop?.phase, "PERPETUAL_PRE_MUTATION");
  assert.equal(result.stop?.reason, "POSITION_MODE_UNAVAILABLE");
  assert.equal(result.stop?.mutationDisposition, "NOT_DISPATCHED");
  assert.equal(fixture.closeCalls.filter(({ legId }) => legId === "short-leg").length, 3);
  assert.equal(fixture.providerMutationCalls.filter((legId) => legId === "short-leg").length, 0);
  assert.equal(fixture.outcomeAudits[0]?.stopPhase, "PERPETUAL_PRE_MUTATION");
  assert.equal(fixture.outcomeAudits[0]?.mutationDisposition, "NOT_DISPATCHED");
});

test("UNKNOWN or dispatched-possible perpetual failure never retries a close mutation", async (t) => {
  for (const disposition of ["UNKNOWN", "DISPATCHED_OR_POSSIBLE"] as const) {
    await t.test(disposition, async () => {
      const fixture = setup({
        longOpenedQuantity: "59.94",
        shortOpenedQuantity: "59",
        legalSpotCloseQuantity: "59",
        residual: "0.94",
        perpetualPreMutationFailures: 1,
        perpetualFailureDisposition: disposition,
      });
      const result = await fixture.service.exit("user-a", exitRequest(`perp-${disposition}`));
      assert.equal(result.status, "STOPPED");
      assert.equal(result.stop?.phase, "PERPETUAL_CONFIRMATION");
      assert.equal(result.stop?.mutationDisposition, disposition);
      assert.equal(fixture.closeCalls.filter(({ legId }) => legId === "short-leg").length, 1);
    });
  }
});

test("business and non-transient pre-mutation failures are not retried", async (t) => {
  for (const category of ["live_trading_disabled", "provider_identity_invalid", "provider_request_rejected"] as const) {
    await t.test(category, async () => {
      const fixture = setup({
        longOpenedQuantity: "59.94",
        shortOpenedQuantity: "59",
        legalSpotCloseQuantity: "59",
        residual: "0.94",
        perpetualPreMutationFailures: 1,
        perpetualFailureCategory: category,
      });
      const result = await fixture.service.exit("user-a", exitRequest(`perp-business-${category}`));
      assert.equal(result.status, "STOPPED");
      assert.equal(result.stop?.phase, "PERPETUAL_PRE_MUTATION");
      assert.equal(fixture.closeCalls.filter(({ legId }) => legId === "short-leg").length, 1);
      assert.equal(fixture.providerMutationCalls.filter((legId) => legId === "short-leg").length, 0);
    });
  }
});

test("fresh mutation-time safety conflict after NOT_DISPATCHED stops before retry mutation", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "59",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
    perpetualPreMutationFailures: 1,
    postSpotPerpetualReason: "ONE_WAY_REALITY_INSUFFICIENT",
    safetyConflictAfterPreMutationFailure: true,
  });
  const result = await fixture.service.exit("user-a", exitRequest("perp-retry-reality-conflict"));

  assert.equal(result.status, "STOPPED");
  assert.equal(result.stop?.phase, "PERPETUAL_CLOSE");
  assert.equal(result.stop?.reason, "CLOSE_QUANTITY_UNAVAILABLE");
  assert.equal(fixture.closeCalls.filter(({ legId }) => legId === "short-leg").length, 1);
  assert.equal(fixture.providerMutationCalls.filter((legId) => legId === "short-leg").length, 0);
  assert.equal(fixture.mutationSafetyCalls("short-leg"), 2);
});

test("NOT_DISPATCHED retry respects the shared continuation deadline", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "59",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
    perpetualPreMutationFailures: 3,
    transientReadRetryBudgetMs: 250,
    preMutationRetryInitialDelayMs: 250,
    advanceClockOnSleep: true,
  });
  const result = await fixture.service.exit("user-a", exitRequest("perp-retry-deadline"));

  assert.equal(result.status, "STOPPED");
  assert.equal(result.stop?.phase, "PERPETUAL_PRE_MUTATION");
  assert.equal(fixture.closeCalls.filter(({ legId }) => legId === "short-leg").length, 1);
  assert.equal(fixture.providerMutationCalls.filter((legId) => legId === "short-leg").length, 0);
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
  assert.equal(result.stop?.phase, "PERPETUAL_CLOSE");
  assert.equal(result.stop?.reason, "POSITION_VERIFICATION_UNAVAILABLE");
  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["long-leg"]);
  assert.equal(fixture.safetyCalls("short-leg"), 1);
  assert.equal(fixture.mutationSafetyCalls("short-leg"), 3);
});

test("the transient read deadline stops before another mutation-time attempt", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "59",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
    transientPerpetualReadFailuresAfterSpot: 10,
    transientReadRetryBudgetMs: 15_000,
    transientReadRetryIntervalMs: 15_000,
    advanceClockOnSleep: true,
  });
  const result = await fixture.service.exit("user-a", exitRequest("perp-read-deadline"));
  assert.equal(result.status, "STOPPED");
  assert.equal(result.stop?.reason, "POSITION_VERIFICATION_UNAVAILABLE");
  assert.equal(fixture.mutationSafetyCalls("short-leg"), 1);
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
  assert.equal(result.stop?.phase, "PERPETUAL_CLOSE");
  assert.equal(result.stop?.reason, "CLOSE_QUANTITY_UNAVAILABLE");
  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["long-leg"]);
  assert.equal(fixture.safetyCalls("short-leg"), 1);
  assert.equal(fixture.mutationSafetyCalls("short-leg"), 1);
});

test("a transient read failure after a closing reference is created is never retried", async () => {
  const fixture = setup({
    longOpenedQuantity: "59.94",
    shortOpenedQuantity: "59",
    legalSpotCloseQuantity: "59",
    residual: "0.94",
    transientPerpetualReadFailuresAfterSpot: 1,
    createClosingReferenceOnTransientFailure: true,
  });
  const result = await fixture.service.exit("user-a", exitRequest("reference-before-read-failure"));
  assert.equal(result.status, "STOPPED");
  assert.equal(result.stop?.phase, "PERPETUAL_CLOSE");
  assert.equal(fixture.mutationSafetyCalls("short-leg"), 1);
  assert.deepEqual(fixture.closeCalls.map((call) => call.legId), ["long-leg"]);
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

test("first close pending finalizes online and continues through fresh second-leg safety", async () => {
  const fixture = setupOnlineFinalization({ firstInitial: outcome("PENDING_CONFIRMATION", "0"),
    firstReconciles: [outcome("CONFIRMED", "1")] });
  const result = await fixture.service.exit("user-a", exitRequest("pending-first-online"));

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.instance.status, "CLOSED");
  assert.deepEqual(fixture.closeCalls, ["long-leg", "short-leg"]);
  assert.equal(fixture.reconcileCalls.filter((legId) => legId === "long-leg").length, 1);
  assert.equal(fixture.safetyCalls("short-leg"), 1);
});

test("repeated pending first-close observations never repeat its Provider mutation", async () => {
  const fixture = setupOnlineFinalization({ firstInitial: outcome("PENDING_CONFIRMATION", "0"),
    firstReconciles: [outcome("PENDING_CONFIRMATION", "0"), outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "1")] });
  const result = await fixture.service.exit("user-a", exitRequest("repeated-pending-first"));

  assert.equal(result.status, "CONFIRMED");
  assert.deepEqual(fixture.closeCalls, ["long-leg", "short-leg"]);
  assert.equal(fixture.reconcileCalls.filter((legId) => legId === "long-leg").length, 3);
});

test("partial, failed, unknown, query error, and exhausted pending all stop before second close", async (t) => {
  const cases = [
    { name: "partial", reconciles: [outcome("PENDING_CONFIRMATION", "0.4")] },
    { name: "failed", reconciles: [outcome("FAILED", "0")] },
    { name: "unknown", reconciles: [outcome("UNKNOWN", "0")] },
    { name: "query-error", reconciles: [] as Outcome[], reconcileThrows: true },
    { name: "timeout", reconciles: [outcome("PENDING_CONFIRMATION", "0"), outcome("PENDING_CONFIRMATION", "0")] },
  ];
  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const fixture = setupOnlineFinalization({
        firstInitial: outcome("PENDING_CONFIRMATION", "0"),
        firstReconciles: candidate.reconciles,
        reconcileThrows: candidate.reconcileThrows,
        closeFinalizationMaxAttempts: 2,
      });
      const result = await fixture.service.exit("user-a", exitRequest(`first-${candidate.name}`));
      assert.equal(result.status, "STOPPED");
      assert.deepEqual(fixture.closeCalls, ["long-leg"]);
    });
  }
});

test("second close pending finalizes before dust release and reaches CLOSED", async () => {
  const fixture = setupOnlineFinalization({
    spotOpened: "1.0000005", spotLegalClose: "1", spotDust: "0.0000005",
    secondInitial: outcome("PENDING_CONFIRMATION", "0"),
    secondReconciles: [outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "1")],
  });
  const result = await fixture.service.exit("user-a", exitRequest("pending-second-dust"));

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.instance.status, "CLOSED");
  assert.deepEqual(fixture.closeCalls, ["long-leg", "short-leg"]);
  assert.equal(fixture.closeCalls.filter((legId) => legId === "short-leg").length, 1);
  assert.deepEqual(fixture.releaseCalls, ["long-leg"]);
});

test("second close timeout stops without duplicate mutation or dust release", async () => {
  const fixture = setupOnlineFinalization({
    spotOpened: "1.0000005", spotLegalClose: "1", spotDust: "0.0000005",
    secondInitial: outcome("PENDING_CONFIRMATION", "0"),
    secondReconciles: [outcome("PENDING_CONFIRMATION", "0"), outcome("PENDING_CONFIRMATION", "0")],
    closeFinalizationMaxAttempts: 2,
  });
  const result = await fixture.service.exit("user-a", exitRequest("pending-second-timeout"));

  assert.equal(result.status, "STOPPED");
  assert.deepEqual(fixture.closeCalls, ["long-leg", "short-leg"]);
  assert.deepEqual(fixture.releaseCalls, []);
});

test("idempotent or restart-like existing close never resumes an old Exit continuation", async () => {
  const fixture = setupOnlineFinalization({
    firstInitial: outcome("CONFIRMED", "1"),
    firstIdempotentReplay: true,
  });
  const result = await fixture.service.exit("user-a", exitRequest("existing-close"));

  assert.equal(result.status, "STOPPED");
  assert.equal(result.stop?.reason, "EXISTING_CLOSING_EXECUTION_REQUIRES_USER_CONTINUE");
  assert.deepEqual(fixture.closeCalls, ["long-leg"]);
  assert.deepEqual(fixture.reconcileCalls, []);
});

test("Binance, OKX, Bybit, and Bitget share the same delayed close finalization", async (t) => {
  for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
    await t.test(venue, async () => {
      const fixture = setupOnlineFinalization({ venue,
        firstInitial: outcome("PENDING_CONFIRMATION", "0"), firstReconciles: [outcome("CONFIRMED", "1")] });
      const result = await fixture.service.exit("user-a", exitRequest(`delayed-${venue}`));
      assert.equal(result.status, "CONFIRMED");
      assert.deepEqual(fixture.closeCalls, ["long-leg", "short-leg"]);
    });
  }
});

test("Bitget unresolved not-found evidence remains UNKNOWN and never continues", async () => {
  const fixture = setupOnlineFinalization({ venue: "bitget",
    firstInitial: outcome("PENDING_CONFIRMATION", "0"), firstReconciles: [outcome("UNKNOWN", "0")] });
  const result = await fixture.service.exit("user-a", exitRequest("bitget-25204-unknown"));

  assert.equal(result.status, "STOPPED");
  assert.equal(result.legs[0]?.status, "UNKNOWN");
  assert.deepEqual(fixture.closeCalls, ["long-leg"]);
});

type Outcome = Readonly<{
  status: "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED" | "UNKNOWN";
  confirmedQuantity: string;
}>;

function outcome(status: Outcome["status"], confirmedQuantity: string): Outcome {
  return Object.freeze({ status, confirmedQuantity });
}

function setupOnlineFinalization(options: Readonly<{
  venue?: "binance" | "okx" | "bybit" | "bitget";
  firstInitial?: Outcome;
  firstReconciles?: readonly Outcome[];
  firstIdempotentReplay?: boolean;
  secondInitial?: Outcome;
  secondReconciles?: readonly Outcome[];
  reconcileThrows?: boolean;
  closeFinalizationMaxAttempts?: number;
  spotOpened?: string;
  spotLegalClose?: string;
  spotDust?: string;
}> = {}) {
  const venue = options.venue ?? "okx";
  const outcomeAudits: any[] = [];
  const auditedCommands = new Set<string>();
  let instance = baseInstance(options.spotOpened ?? "1", "1", "DOGE-USDT-SPOT");
  instance = { ...instance, legs: instance.legs.map((leg) => ({ ...leg, venue })) as unknown as ArbitrageInstance["legs"] };
  const closeCalls: string[] = [];
  const reconcileCalls: string[] = [];
  const releaseCalls: string[] = [];
  const safetyCallCounts = new Map<string, number>();
  const reconciles = new Map<string, Outcome[]>([
    ["long-leg", [...(options.firstReconciles ?? [])]],
    ["short-leg", [...(options.secondReconciles ?? [])]],
  ]);

  function currentOutcome(legId: string, initial: Outcome) {
    const reference = instance.executionReferences.find((candidate) => candidate.phase === "CLOSING" && candidate.legId === legId);
    return reference ? outcome(reference.status as Outcome["status"], reference.confirmedQuantity) : initial;
  }

  function apply(legId: string, next: Outcome) {
    const leg = instance.legs.find((candidate) => candidate.legId === legId)!;
    const requestedQuantity = legId === "long-leg" ? (options.spotLegalClose ?? leg.confirmedOpenedQuantity) : leg.confirmedOpenedQuantity;
    const executionIntentId = `intent-${legId}`;
    const executionRecordId = `record-${legId}`;
    const references = instance.executionReferences.filter((reference) => !(reference.phase === "CLOSING" && reference.legId === legId));
    references.push({
      arbitrageId: instance.arbitrageId,
      legId,
      phase: "CLOSING",
      quantityEffect: "DECREASE",
      executionIntentId,
      executionRecordId,
      requestedQuantity,
      confirmedQuantity: next.confirmedQuantity,
      status: next.status,
      createdAt: 1_800_000_000_100,
      updatedAt: 1_800_000_000_101,
    });
    const legs = instance.legs.map((candidate) => candidate.legId !== legId ? candidate : {
      ...candidate,
      confirmedClosedQuantity: next.confirmedQuantity,
    }) as unknown as ArbitrageInstance["legs"];
    const allClosed = legs.every((candidate) => candidate.confirmedOpenedQuantity === candidate.confirmedClosedQuantity);
    instance = {
      ...instance,
      executionReferences: references,
      legs,
      status: allClosed ? "CLOSED" : next.status === "CONFIRMED" ? "CLOSING" : "CLOSING",
    };
    return confirmation(legId, next, false);
  }

  function confirmation(legId: string, next: Outcome, idempotentReplay: boolean) {
    const leg = instance.legs.find((candidate) => candidate.legId === legId)!;
    const plannedQuantity = legId === "long-leg" ? (options.spotLegalClose ?? leg.confirmedOpenedQuantity) : leg.confirmedOpenedQuantity;
    return {
      instance,
      executionRecord: {
        executionId: `record-${legId}`,
        intentId: `intent-${legId}`,
        status: next.status,
        plannedQuantity,
        confirmedQuantity: next.confirmedQuantity,
        verifiedAt: 1_800_000_000_200,
      },
      providerDispatchStartedAt: 1_800_000_000_190,
      idempotentReplay,
      secondLegAllowed: false,
    };
  }

  const closeService = {
    async evaluateCloseSafety(_userId: string, _arbitrageId: string, legId: string) {
      safetyCallCounts.set(legId, (safetyCallCounts.get(legId) ?? 0) + 1);
      const leg = instance.legs.find((candidate) => candidate.legId === legId)!;
      const active = subtractUnsignedDecimals(leg.confirmedOpenedQuantity, leg.confirmedClosedQuantity);
      if (legId === "long-leg" && options.spotDust !== undefined) {
        const beforeClose = leg.confirmedClosedQuantity === "0";
        return {
          activeManagedQuantity: active,
          safeClosableQuantity: beforeClose ? options.spotLegalClose! : "0",
          fullManagedCloseAvailable: false,
          reason: "QUANTITY_STEP_DUST",
          checkedAt: 1_800_000_000_050,
          positionMode: "ONE_WAY",
          actualQuantity: active,
          actualSignedNetQuantity: active,
          actualLongQuantity: active,
          actualShortQuantity: "0",
          availableQuantity: active,
        } as const;
      }
      return {
        activeManagedQuantity: active,
        safeClosableQuantity: active,
        fullManagedCloseAvailable: true,
        reason: "FULL_MANAGED_CLOSE_AVAILABLE",
        checkedAt: 1_800_000_000_050,
        positionMode: "ONE_WAY",
        actualQuantity: active,
        actualSignedNetQuantity: leg.role === "SHORT" ? `-${active}` : active,
        actualLongQuantity: leg.role === "LONG" ? active : "0",
        actualShortQuantity: leg.role === "SHORT" ? active : "0",
        availableQuantity: legId === "long-leg" ? active : null,
      } as const;
    },
    async closeLeg(_userId: string, input: any) {
      closeCalls.push(input.legId);
      const first = input.legId === "long-leg";
      const initial = first ? (options.firstInitial ?? outcome("CONFIRMED", input.quantity))
        : (options.secondInitial ?? outcome("CONFIRMED", input.quantity));
      apply(input.legId, initial);
      return confirmation(input.legId, currentOutcome(input.legId, initial), first && options.firstIdempotentReplay === true);
    },
  };
  const managementRelease = {
    async releaseDustAfterClose(_userId: string, input: any) {
      releaseCalls.push(input.legId);
      const leg = instance.legs.find((candidate) => candidate.legId === input.legId)!;
      instance = {
        ...instance,
        status: "CLOSED",
        managementReleases: [{
          releaseId: `release-${input.legId}`, arbitrageId: instance.arbitrageId, legId: input.legId,
          releasedQuantity: options.spotDust!, reason: "USER_CONFIRMED_STOP_MANAGEMENT", source: "AUTHENTICATED_API",
          requestedByUserId: "user-a", requestedAt: 1_800_000_000_210, confirmedAt: 1_800_000_000_211,
          venue: leg.venue, accountId: leg.accountId, instrumentId: leg.instrumentId, positionMode: "ONE_WAY",
          actualQuantity: options.spotDust!, actualSignedNetQuantity: options.spotDust!, actualLongQuantity: options.spotDust!,
          actualShortQuantity: "0", availableQuantity: options.spotDust!, realityCheckedAt: 1_800_000_000_209,
        }],
      };
      return { instance, release: instance.managementReleases![0], idempotentReplay: false };
    },
  };
  const reconciliationService = {
    async reconcileLeg(_userId: string, input: any) {
      reconcileCalls.push(input.legId);
      if (options.reconcileThrows) throw new Error("temporary query failure");
      const queue = reconciles.get(input.legId)!;
      const current = currentOutcome(input.legId, outcome("PENDING_CONFIRMATION", "0"));
      return apply(input.legId, queue.shift() ?? current);
    },
  };
  const service = new ArbitrageInstanceExitService(
    {
      get: () => instance,
      recordCommandOutcome: (_userId: string, audit: any) => {
        if (!auditedCommands.has(audit.commandId)) {
          auditedCommands.add(audit.commandId);
          outcomeAudits.push(audit);
        }
        return audit;
      },
    } as any,
    closeService as any,
    managementRelease as any,
    reconciliationService as any,
    { verify: async () => ({ arbitrageId: instance.arbitrageId, checkedAt: 1_800_000_000_300, legs: [] }) } as any,
    {
      now: () => 1_800_000_000_000,
      sleep: async () => undefined,
      closeFinalizationBudgetMs: 15_000,
      closeFinalizationInitialPollMs: 250,
      closeFinalizationMaxPollMs: 2_000,
      closeFinalizationMaxAttempts: options.closeFinalizationMaxAttempts ?? 10,
    },
  );
  return {
    service, closeCalls, reconcileCalls, releaseCalls, outcomeAudits,
    safetyCalls: (legId: string) => safetyCallCounts.get(legId) ?? 0,
  };
}

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
  createClosingReferenceOnTransientFailure?: boolean;
  transientReadRetryBudgetMs?: number;
  transientReadRetryIntervalMs?: number;
  advanceClockOnSleep?: boolean;
  releaseErrorCategory?: ArbitrageManagementReleaseError["category"];
  perpetualPreMutationFailures?: number;
  perpetualFailureDisposition?: "NOT_DISPATCHED" | "DISPATCHED_OR_POSSIBLE" | "UNKNOWN";
  perpetualFailureCategory?: string;
  safetyConflictAfterPreMutationFailure?: boolean;
  preMutationRetryInitialDelayMs?: number;
}> = {}) {
  const outcomeAudits: any[] = [];
  const auditedCommands = new Set<string>();
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
  const mutationSafetyCallCounts = new Map<string, number>();
  const mutationSafetyDeadlineValues = new Map<string, number[]>();
  const closeCalls: Array<{ legId: string; commandId: string; quantity: string }> = [];
  const providerMutationCalls: string[] = [];
  const closeAttemptsByLeg = new Map<string, number>();
  let currentTime = 1_800_000_000_000;
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
      const legAttempt = (closeAttemptsByLeg.get(input.legId) ?? 0) + 1;
      closeAttemptsByLeg.set(input.legId, legAttempt);
      if (input.legId === "short-leg" && legAttempt <= (options.perpetualPreMutationFailures ?? 0)) {
        const mutationDisposition = options.perpetualFailureDisposition ?? "NOT_DISPATCHED";
        return {
          instance: { ...instance, status: "CLOSING" },
          executionRecord: {
            executionId: `record-${input.legId}-${legAttempt}`,
            intentId: `intent-${input.legId}-${legAttempt}`,
            status: mutationDisposition === "DISPATCHED_OR_POSSIBLE" ? "FAILED" : mutationDisposition === "UNKNOWN" ? "UNKNOWN" : "FAILED",
            plannedQuantity: input.quantity,
            confirmedQuantity: "0",
            verifiedAt: 1_800_000_000_100 + legAttempt,
          },
          mutationDisposition,
          failureStage: mutationDisposition === "NOT_DISPATCHED" ? "PRE_MUTATION" : "MUTATION_OR_RESPONSE",
          diagnostic: {
            category: options.perpetualFailureCategory ?? (mutationDisposition === "NOT_DISPATCHED"
              ? "position_mode_unavailable"
              : "provider_transport_error"),
            stage: "execution-capability",
            failureStage: mutationDisposition === "NOT_DISPATCHED" ? "PRE_MUTATION" : "MUTATION_OR_RESPONSE",
            errorType: "Error",
            sanitizedMessage: "Controlled failure.",
          },
          providerDispatchStartedAt: 1_800_000_000_101,
          idempotentReplay: false,
          secondLegAllowed: false,
        };
      }
      providerMutationCalls.push(input.legId);
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
    async closeLegForExit(userId: string, input: any, mutationDeadline: number) {
      const attempts = (mutationSafetyCallCounts.get(input.legId) ?? 0) + 1;
      mutationSafetyCallCounts.set(input.legId, attempts);
      mutationSafetyDeadlineValues.set(input.legId, [
        ...(mutationSafetyDeadlineValues.get(input.legId) ?? []),
        mutationDeadline,
      ]);
      const spotHasClosed = instance.legs[0].confirmedClosedQuantity !== "0";
      if (input.legId === "short-leg" && spotHasClosed
        && attempts <= (options.transientPerpetualReadFailuresAfterSpot ?? 0)) {
        if (options.createClosingReferenceOnTransientFailure) {
          instance = {
            ...instance,
            executionReferences: [...instance.executionReferences, {
              arbitrageId: instance.arbitrageId,
              executionIntentId: "claimed-close-intent",
              executionRecordId: "claimed-close-record",
              legId: input.legId,
              phase: "CLOSING",
              quantityEffect: "DECREASE",
              requestedQuantity: input.quantity,
              confirmedQuantity: "0",
              status: "CLAIMED",
              createdAt: 1_800_000_000_090,
              updatedAt: 1_800_000_000_090,
            }],
          };
        }
        throw new ArbitrageExecutionCloseError(
          "position_verification_unavailable",
          "受控的临时仓位读取失败。",
        );
      }
      if (input.legId === "short-leg" && spotHasClosed && options.postSpotPerpetualReason) {
        if (options.safetyConflictAfterPreMutationFailure
          && (closeAttemptsByLeg.get(input.legId) ?? 0) === 0) return this.closeLeg(userId, input);
        throw new ArbitrageExecutionCloseError(
          "close_quantity_unavailable",
          "当前真实仓位不足以安全完成退出。",
        );
      }
      return this.closeLeg(userId, input);
    },
  };
  const managementRelease = {
    async releaseDustAfterClose(_userId: string, input: any) {
      releaseCalls.push({ legId: input.legId, commandId: input.commandId });
      if (options.releaseErrorCategory) {
        throw new ArbitrageManagementReleaseError(options.releaseErrorCategory, "safe controlled diagnostic");
      }
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
    {
      get: () => instance,
      recordCommandOutcome: (_userId: string, audit: any) => {
        if (!auditedCommands.has(audit.commandId)) {
          auditedCommands.add(audit.commandId);
          outcomeAudits.push(audit);
        }
        return audit;
      },
    } as any,
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
    {
      now: () => currentTime,
      sleep: async (milliseconds) => {
        if (options.advanceClockOnSleep) currentTime += milliseconds;
      },
      transientReadRetryBudgetMs: options.transientReadRetryBudgetMs,
      transientReadRetryIntervalMs: options.transientReadRetryIntervalMs,
      preMutationRetryInitialDelayMs: options.preMutationRetryInitialDelayMs,
    },
  );
  if (options.firstStatus !== undefined && options.firstStatus !== "CONFIRMED") releaseSecondLeg();
  if (options.firstStatus === undefined && options.residual !== undefined) releaseSecondLeg();
  if (options.verifiedActualQuantity !== undefined) releaseSecondLeg();
  if (options.firstStatus === undefined && options.residual === undefined) queueMicrotask(releaseSecondLeg);
  return {
    service, closeCalls, providerMutationCalls, releaseCalls, firstLegCompleted, releaseSecondLeg, outcomeAudits,
    lifecycleApplyCount: () => lifecycleApplyCount,
    safetyCalls: (legId: string) => safetyCallCounts.get(legId) ?? 0,
    mutationSafetyCalls: (legId: string) => mutationSafetyCallCounts.get(legId) ?? 0,
    mutationSafetyDeadlines: (legId: string) => mutationSafetyDeadlineValues.get(legId) ?? [],
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
