import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
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

test("accepted residual remains managed and cannot report a confirmed CLOSED exit", async () => {
  const fixture = setup({ residual: "0.006" });
  const result = await fixture.service.exit("user-a", exitRequest("accepted-residual"));

  assert.equal(result.status, "STOPPED");
  assert.equal(result.instance.status, "RESIDUAL");
  assert.equal(result.instance.maxResidualBaseQuantity, "0.006");
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "1");
  assert.equal(result.instance.legs[0].confirmedClosedQuantity, "0.994");
});

test("account dust does not erase an Active Managed residual", async () => {
  const fixture = setup({ residual: "0.006", verifiedActualQuantity: "0.011" });
  const closed = await fixture.service.exit("user-a", exitRequest("dust-independent"));
  const reconciled = await fixture.service.reconcile("user-a", { arbitrageId: closed.instance.arbitrageId });

  assert.equal(closed.instance.status, "RESIDUAL");
  assert.equal(reconciled.instance.status, "RESIDUAL");
  assert.equal(reconciled.verification.legs[0].actualQuantity, "0.011");
});

function setup(options: Readonly<{
  firstStatus?: "CONFIRMED" | "FAILED" | "UNKNOWN" | "PENDING_CONFIRMATION";
  firstConfirmedQuantity?: string;
  residual?: string;
  verifiedActualQuantity?: string;
  releasedShort?: boolean;
  timing?: Readonly<{
    firstAuthoritative(): void;
    firstDurable(): void;
    secondSafetyReady(): void;
    secondDispatch(): void;
  }>;
}> = {}) {
  let instance = baseInstance();
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
  const closeCalls: Array<{ legId: string; commandId: string }> = [];
  let releaseSecondLeg: () => void = () => undefined;
  const secondLegGate = new Promise<void>((resolve) => { releaseSecondLeg = resolve; });
  let completeFirstLeg: () => void = () => undefined;
  const firstLegCompleted = new Promise<void>((resolve) => { completeFirstLeg = resolve; });
  const closeService = {
    async closeLeg(_userId: string, input: any) {
      closeCalls.push({ legId: input.legId, commandId: input.commandId });
      const first = input.legId === "short-leg";
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
          confirmedClosedQuantity: first ? "1" : options.residual ? "0.994" : "1",
        }) as unknown as ArbitrageInstance["legs"];
        instance = {
          ...instance,
          legs,
          status: first ? "CLOSING" : options.residual ? "RESIDUAL" : "CLOSED",
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
          verifiedAt: 1_800_000_000_100,
        },
        idempotentReplay: false,
        secondLegAllowed: false,
      };
    },
  };
  const service = new ArbitrageInstanceExitService(
    { get: () => instance } as any,
    closeService as any,
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
  );
  if (options.firstStatus !== undefined && options.firstStatus !== "CONFIRMED") releaseSecondLeg();
  if (options.firstStatus === undefined && options.residual !== undefined) releaseSecondLeg();
  if (options.verifiedActualQuantity !== undefined) releaseSecondLeg();
  if (options.firstStatus === undefined && options.residual === undefined) queueMicrotask(releaseSecondLeg);
  return { service, closeCalls, firstLegCompleted, releaseSecondLeg, lifecycleApplyCount: () => lifecycleApplyCount };
}

function baseInstance(): ArbitrageInstance {
  return {
    arbitrageId: "arbitrage-exit-1",
    userId: "user-a",
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0",
    status: "HOLDING",
    createdAt: 1_800_000_000_000,
    openedAt: 1_800_000_000_010,
    updatedAt: 1_800_000_000_020,
    closedAt: null,
    legs: [{
      legId: "long-leg", role: "LONG", venue: "bybit", accountId: "account-a",
      instrumentId: "DOGE-USDT-PERP", plannedQuantity: "1", confirmedOpenedQuantity: "1", confirmedClosedQuantity: "0",
    }, {
      legId: "short-leg", role: "SHORT", venue: "bybit", accountId: "account-a",
      instrumentId: "DOGE-USDT-PERP", plannedQuantity: "1", confirmedOpenedQuantity: "1", confirmedClosedQuantity: "0",
    }],
    executionReferences: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}

function exitRequest(commandId = "exit-command") {
  return { arbitrageId: "arbitrage-exit-1", commandId, executionMode: "EXECUTION_PRIORITY", confirmed: true };
}
