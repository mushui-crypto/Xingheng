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

test("accepted residual reaches CLOSED from the persisted instance contract", async () => {
  const fixture = setup({ residual: "0.006" });
  const result = await fixture.service.exit("user-a", exitRequest("accepted-residual"));

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.instance.status, "CLOSED");
  assert.equal(result.instance.maxResidualBaseQuantity, "0.006");
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "1");
  assert.equal(result.instance.legs[0].confirmedClosedQuantity, "0.994");
});

test("unrelated account dust does not override an instance CLOSED result", async () => {
  const fixture = setup({ residual: "0.006", verifiedActualQuantity: "0.011" });
  const closed = await fixture.service.exit("user-a", exitRequest("dust-independent"));
  const reconciled = await fixture.service.reconcile("user-a", { arbitrageId: closed.instance.arbitrageId });

  assert.equal(closed.instance.status, "CLOSED");
  assert.equal(reconciled.instance.status, "CLOSED");
  assert.equal(reconciled.verification.legs[0].actualQuantity, "0.011");
});

function setup(options: Readonly<{
  firstStatus?: "CONFIRMED" | "FAILED" | "UNKNOWN" | "PENDING_CONFIRMATION";
  residual?: string;
  verifiedActualQuantity?: string;
}> = {}) {
  let instance = baseInstance();
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
      const status = first ? (options.firstStatus ?? "CONFIRMED") : "CONFIRMED";
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
          status: first ? "CLOSING" : "CLOSED",
          maxResidualBaseQuantity: first ? instance.maxResidualBaseQuantity : (options.residual ?? "0"),
        };
      }
      if (first) completeFirstLeg();
      else await secondLegGate;
      return {
        instance,
        executionRecord: {
          executionId: `record-${input.legId}`,
          intentId: `intent-${input.legId}`,
          status,
          plannedQuantity: input.quantity,
          confirmedQuantity: status === "CONFIRMED" ? input.quantity : "0",
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
