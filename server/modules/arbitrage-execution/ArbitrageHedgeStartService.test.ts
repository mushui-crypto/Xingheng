import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import { ArbitrageExecutionCommandError, type ArbitrageLegExecutionConfirmation } from "./ArbitrageExecutionCommandService";
import { ArbitrageHedgeStartError, ArbitrageHedgeStartService } from "./ArbitrageHedgeStartService";

test("one confirmed start executes both full legs strictly in server order", async () => {
  const fixture = setup([outcome("CONFIRMED", "100"), outcome("CONFIRMED", "100")]);
  const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.requiresUserAction, false);
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg", "short-leg"]);
  assert.equal(new Set(fixture.executor.commandIds).size, 2);
  assert.equal(result.instanceStatus, "HOLDING");
  assert.ok(result.timing.secondLegDispatchStartedAt! >= result.timing.firstLegCompletedAt);
  assert.equal(fixture.executor.reconcileCalls.length, 0);
  assert.equal(fixture.outcomeAudits.length, 1);
  assert.equal(fixture.outcomeAudits[0]?.operation, "START");
  assert.equal(fixture.outcomeAudits[0]?.terminalStatus, "COMPLETED");
});

test("Start STOPPED outcome is audited once with controlled diagnostics and idempotent replay", async () => {
  const fixture = setup([outcome("UNKNOWN", "0")]);
  const first = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  const replay = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(first.status, "STOPPED_FIRST_LEG_UNKNOWN");
  assert.equal(replay.status, "STOPPED_FIRST_LEG_UNKNOWN");
  assert.equal(fixture.outcomeAudits.length, 1);
  assert.deepEqual({ ...fixture.outcomeAudits[0], terminalAt: 0 }, {
    commandId: "hedge-start-1", requestedByUserId: "user-a", arbitrageId: "arbitrage-1",
    operation: "START", terminalStatus: "STOPPED_FIRST_LEG_UNKNOWN", stopPhase: "FIRST_LEG",
    stopReason: "STOPPED_FIRST_LEG_UNKNOWN", failedLegId: "long-leg", completedLegIds: [],
    currentManagedExposure: [{ legId: "long-leg", quantity: "0" }, { legId: "short-leg", quantity: "0" }],
    mutationDisposition: null, diagnosticCategory: null, failureStage: null,
    providerCode: null, reconcileAttempts: [],
    terminalAt: 0,
  });
  assert.equal(Number.isSafeInteger(fixture.outcomeAudits[0]?.terminalAt), true);
});

test("an online first-leg pending acknowledgement is authoritatively finalized before automatic second-leg dispatch", async () => {
  const fixture = setup(
    [outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "100")],
    { reconciliationOutcomes: [outcome("CONFIRMED", "100")] },
  );
  const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg", "short-leg"]);
  assert.equal(fixture.executor.reconcileCalls.length, 1);
  assert.equal(fixture.executor.reconcileCalls[0]?.executionIntentId, `intent-${childCommandId("hedge-start-1", "first")}`);
});

test("repeated zero-fill pending observations remain read-only until full confirmation", async () => {
  const fixture = setup(
    [outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "100")],
    { reconciliationOutcomes: [
      outcome("PENDING_CONFIRMATION", "0"),
      outcome("PENDING_CONFIRMATION", "0"),
      outcome("CONFIRMED", "100"),
    ] },
  );
  assert.equal((await fixture.service.start("user-a", fixture.instance.arbitrageId, request())).status, "COMPLETED");
  assert.equal(fixture.executor.reconcileCalls.length, 3);
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg", "short-leg"]);
  assert.deepEqual(fixture.sleeps, [1, 2]);
});

test("transient Bybit execution evidence converges inside one Start and automatically continues", async () => {
  const fixture = setup(
    [outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "100")],
    {
      reconcileErrors: [transientReconcileError("EXECUTION_LIST"), transientReconcileError("EXECUTION_EVIDENCE_COMPARE")],
      reconciliationOutcomes: [outcome("CONFIRMED", "100")],
    },
    baseInstance("bybit", "bybit"),
  );
  const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg", "short-leg"]);
  assert.equal(fixture.executor.reconcileCalls.length, 3);
  assert.deepEqual(fixture.sleeps, [1, 2]);
  assert.deepEqual(result.reconcileAttempts.map(({ retryDecision, category }) => [retryDecision, category]), [
    ["RETRY", "EXECUTION_EVIDENCE_PENDING"],
    ["RETRY", "EXECUTION_EVIDENCE_PENDING"],
    ["COMPLETE", null],
  ]);
  assert.equal(fixture.outcomeAudits[0]?.reconcileAttempts.length, 3);
});

test("invalid Bybit execution evidence stops immediately and never dispatches the second leg", async () => {
  const fixture = setup(
    [outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "100")],
    { reconcileErrors: [nonRetryableReconcileError("PROVIDER_RESPONSE_INVALID")] },
    baseInstance("bybit", "bybit"),
  );
  const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "STOPPED_FIRST_LEG_UNKNOWN");
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg"]);
  assert.equal(fixture.executor.reconcileCalls.length, 1);
  assert.equal(result.reconcileAttempts[0]?.retryDecision, "STOP");
});

test("Bybit transient evidence exhaustion stops bounded without a second-leg mutation", async () => {
  const fixture = setup(
    [outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "100")],
    {
      finalizationMaxAttempts: 3,
      reconcileErrors: [
        transientReconcileError("EXECUTION_LIST"),
        transientReconcileError("EXECUTION_EVIDENCE_COMPARE"),
        transientReconcileError("EXECUTION_EVIDENCE_COMPARE"),
      ],
    },
    baseInstance("bybit", "bybit"),
  );
  const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "STOPPED_FIRST_LEG_UNKNOWN");
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg"]);
  assert.equal(fixture.executor.reconcileCalls.length, 3);
  assert.equal(result.reconcileAttempts.at(-1)?.retryDecision, "STOP");
});

test("Bybit identity and auth reconcile failures never retry", async (context) => {
  for (const category of ["IDENTITY_MISMATCH", "AUTH_OR_PERMISSION_FAILED"] as const) {
    await context.test(category, async () => {
      const fixture = setup(
        [outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "100")],
        { reconcileErrors: [nonRetryableReconcileError(category)] },
        baseInstance("bybit", "bybit"),
      );
      const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
      assert.equal(result.status, "STOPPED_FIRST_LEG_UNKNOWN");
      assert.equal(fixture.executor.reconcileCalls.length, 1);
      assert.deepEqual(fixture.executor.mutationLegs, ["long-leg"]);
    });
  }
});

test("an online second-leg pending acknowledgement is finalized before Start returns", async () => {
  const fixture = setup(
    [outcome("CONFIRMED", "100"), outcome("PENDING_CONFIRMATION", "0")],
    { reconciliationOutcomes: [outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "100")] },
  );
  const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.instanceStatus, "HOLDING");
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg", "short-leg"]);
  assert.equal(fixture.executor.reconcileCalls.length, 2);
  assert.equal(fixture.executor.reconcileCalls[0]?.legId, "short-leg");
  assert.equal(fixture.executor.reconcileCalls[0]?.executionIntentId, `intent-${childCommandId("hedge-start-1", "second")}`);
});

test("second-leg online finalization query failure stops without duplicate mutation", async () => {
  const fixture = setup(
    [outcome("CONFIRMED", "100"), outcome("PENDING_CONFIRMATION", "0")],
    { reconcileError: true },
  );
  const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "STOPPED_SECOND_LEG_UNKNOWN");
  assert.match(result.reason ?? "", /第二腿终态核验暂不可用/u);
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg", "short-leg"]);
  assert.equal(fixture.executor.reconcileCalls.length, 1);
});

test("online finalization stops on partial, failed, unknown, or query error without second-leg mutation", async (context) => {
  const scenarios = [
    ["partial", { reconciliationOutcomes: [outcome("PENDING_CONFIRMATION", "40")] }, "STOPPED_FIRST_LEG_PARTIAL"],
    ["failed", { reconciliationOutcomes: [outcome("FAILED", "0")] }, "STOPPED_FIRST_LEG_FAILED"],
    ["unknown", { reconciliationOutcomes: [outcome("UNKNOWN", "0")] }, "STOPPED_FIRST_LEG_UNKNOWN"],
    ["query error", { reconcileError: true }, "STOPPED_FIRST_LEG_UNKNOWN"],
  ] as const;
  for (const [name, options, expected] of scenarios) {
    await context.test(name, async () => {
      const fixture = setup([outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "100")], options);
      const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request({ hedgeCommandId: `start-${name}` }));
      assert.equal(result.status, expected);
      assert.deepEqual(fixture.executor.mutationLegs, ["long-leg"]);
      assert.equal(result.secondLeg, null);
    });
  }
});

test("online finalization requires the exact persisted execution identity", async () => {
  const fixture = setup(
    [outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "100")],
    { omitFirstExecutionRecordId: true, reconciliationOutcomes: [outcome("CONFIRMED", "100")] },
  );
  const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "STOPPED_FIRST_LEG_UNKNOWN");
  assert.equal(fixture.executor.reconcileCalls.length, 0);
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg"]);
});

test("online finalization exhausts its bounded budget without background work or duplicate mutation", async () => {
  const fixture = setup(
    [outcome("PENDING_CONFIRMATION", "0"), outcome("CONFIRMED", "100")],
    { finalizationMaxAttempts: 3 },
  );
  const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "STOPPED_FIRST_LEG_PENDING");
  assert.equal(fixture.executor.reconcileCalls.length, 3);
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg"]);
  const callsAtReturn = fixture.executor.reconcileCalls.length;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.executor.reconcileCalls.length, callsAtReturn);
});

test("a finalized first leg still runs the existing second-leg safety gate before mutation", async () => {
  const fixture = setup(
    [outcome("PENDING_CONFIRMATION", "0")],
    { reconciliationOutcomes: [outcome("CONFIRMED", "100")], throwSecond: "opening_attribution_unsafe" },
  );
  const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "STOPPED_SAFETY");
  assert.equal(fixture.executor.reconcileCalls.length, 1);
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg"]);
});

test("all venues reuse the same online finalization path for both legs", async (context) => {
  for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
    await context.test(venue, async () => {
      const fixture = setup(
        [outcome("PENDING_CONFIRMATION", "0"), outcome("PENDING_CONFIRMATION", "0")],
        { reconciliationOutcomes: [outcome("CONFIRMED", "100"), outcome("CONFIRMED", "100")] },
        baseInstance(venue, venue),
      );
      const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request({ hedgeCommandId: `delayed-${venue}` }));
      assert.equal(result.status, "COMPLETED");
      assert.equal(fixture.executor.reconcileCalls.length, 2);
      assert.deepEqual(fixture.executor.mutationLegs, ["long-leg", "short-leg"]);
    });
  }
});

test("SPOT_PERPETUAL rejects a Perpetual first leg before execution, including repeated illegal commands", async () => {
  const fixture = setup([outcome("CONFIRMED", "100"), outcome("CONFIRMED", "100")]);
  const illegal = request({ firstLegId: "short-leg" });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => fixture.service.start("user-a", fixture.instance.arbitrageId, illegal),
      (error) => error instanceof ArbitrageHedgeStartError
        && error.category === "invalid_start_confirmation",
    );
  }
  assert.deepEqual(fixture.executor.mutationLegs, []);
  assert.deepEqual(fixture.executor.commandIds, []);
});

test("legal Spot-first orchestration keeps Perpetual second across all supported venues", async (context) => {
  for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
    await context.test(venue, async () => {
      const fixture = setup(
        [outcome("CONFIRMED", "100"), outcome("CONFIRMED", "100")],
        {},
        baseInstance(venue),
      );
      const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request({ hedgeCommandId: `start-${venue}` }));
      assert.equal(result.status, "COMPLETED");
      assert.deepEqual(fixture.executor.mutationLegs, ["long-leg", "short-leg"]);
      assert.equal(fixture.instance.legs.find(({ legId }) => legId === fixture.executor.mutationLegs[1])?.instrumentId.endsWith("-PERP"), true);
    });
  }
});

test("non-SPOT_PERPETUAL strategies retain their existing first-leg choice", async () => {
  const instance = baseInstance();
  const perpetualPair: ArbitrageInstance = {
    ...instance,
    strategyType: "PERPETUAL_PERPETUAL",
    legs: [
      { ...instance.legs[0], instrumentId: "BTC-USDT-PERP" },
      instance.legs[1],
    ],
  };
  const fixture = setup([outcome("CONFIRMED", "100"), outcome("CONFIRMED", "100")], {}, perpetualPair);
  assert.equal((await fixture.service.start("user-a", fixture.instance.arbitrageId, request())).status, "COMPLETED");
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg", "short-leg"]);
});

test("first-leg non-full outcomes stop with zero second-leg mutation", async (context) => {
  const scenarios = [
    ["pending", outcome("PENDING_CONFIRMATION", "0"), "STOPPED_FIRST_LEG_PENDING"],
    ["unknown", outcome("UNKNOWN", "0"), "STOPPED_FIRST_LEG_UNKNOWN"],
    ["failed zero", outcome("FAILED", "0"), "STOPPED_FIRST_LEG_FAILED"],
    ["failed partial", outcome("FAILED", "40"), "STOPPED_FIRST_LEG_PARTIAL"],
    ["fake confirmed partial", outcome("CONFIRMED", "40"), "STOPPED_FIRST_LEG_PARTIAL"],
  ] as const;
  for (const [name, first, expected] of scenarios) {
    await context.test(name, async () => {
      const fixture = setup([first, outcome("CONFIRMED", "100")]);
      const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request({ hedgeCommandId: `start-${name}` }));
      assert.equal(result.status, expected);
      assert.deepEqual(fixture.executor.mutationLegs, ["long-leg"]);
      assert.equal(result.secondLeg, null);
    });
  }
});

test("second-leg non-full outcomes stop without retry or compensation", async (context) => {
  const scenarios = [
    [outcome("PENDING_CONFIRMATION", "0"), "STOPPED_SECOND_LEG_PENDING"],
    [outcome("UNKNOWN", "0"), "STOPPED_SECOND_LEG_UNKNOWN"],
    [outcome("FAILED", "0"), "STOPPED_SECOND_LEG_FAILED"],
    [outcome("FAILED", "40"), "STOPPED_SECOND_LEG_PARTIAL"],
    [outcome("CONFIRMED", "40"), "STOPPED_SECOND_LEG_PARTIAL"],
  ] as const;
  for (const [second, expected] of scenarios) {
    await context.test(expected, async () => {
      const fixture = setup([outcome("CONFIRMED", "100"), second]);
      const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request({ hedgeCommandId: expected }));
      assert.equal(result.status, expected);
      assert.deepEqual(fixture.executor.mutationLegs, ["long-leg", "short-leg"]);
    });
  }
});

test("second-leg safety failure returns STOPPED_SAFETY without a second mutation", async () => {
  const fixture = setup([outcome("CONFIRMED", "100")], { throwSecond: "opening_attribution_unsafe" });
  const result = await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "STOPPED_SAFETY");
  assert.deepEqual(fixture.executor.mutationLegs, ["long-leg"]);
  assert.match(result.reason ?? "", /safety blocked/u);
});

test("same hedge command replays stable child commands without duplicate mutation", async () => {
  const fixture = setup([outcome("CONFIRMED", "100"), outcome("CONFIRMED", "100")]);
  assert.equal((await fixture.service.start("user-a", fixture.instance.arbitrageId, request())).status, "COMPLETED");
  assert.equal((await fixture.service.start("user-a", fixture.instance.arbitrageId, request())).status, "COMPLETED");
  assert.equal(fixture.executor.mutationLegs.length, 2);
  assert.deepEqual(fixture.executor.commandIds.slice(0, 2), fixture.executor.commandIds.slice(2));
});

test("same hedgeCommandId with changed payload conflicts through the child fingerprint", async () => {
  const fixture = setup([outcome("CONFIRMED", "100"), outcome("CONFIRMED", "100")]);
  await fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  await assert.rejects(
    () => fixture.service.start("user-a", fixture.instance.arbitrageId, request({ opportunityId: "different" })),
    (error) => error instanceof ArbitrageExecutionCommandError && error.category === "idempotency_conflict",
  );
  assert.equal(fixture.executor.mutationLegs.length, 2);
});

test("concurrent starts share only an identical request and reject a different command", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = setup([outcome("CONFIRMED", "100"), outcome("CONFIRMED", "100")], { firstGate: gate });
  const first = fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  const duplicate = fixture.service.start("user-a", fixture.instance.arbitrageId, request());
  await assert.rejects(
    () => fixture.service.start("user-a", fixture.instance.arbitrageId, request({ hedgeCommandId: "different-command" })),
    (error) => error instanceof ArbitrageHedgeStartError && error.category === "idempotency_conflict",
  );
  release();
  const [left, right] = await Promise.all([first, duplicate]);
  assert.strictEqual(left, right);
  assert.equal(fixture.executor.mutationLegs.length, 2);
});

test("a restarted orchestration never auto-continues from an existing full first leg", async () => {
  const fixture = setup([]);
  fixture.executor.seedConfirmed(childCommandId("hedge-start-1", "first"), "long-leg", "100");
  const restarted = new ArbitrageHedgeStartService(fixture.store as never, fixture.executor as never, { clock: clock() });
  const result = await restarted.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "FIRST_LEG_CONFIRMED_REQUIRES_USER_CONTINUE");
  assert.equal(result.secondLeg, null);
  assert.equal(fixture.executor.mutationLegs.length, 0);
});

test("a restarted orchestration never resumes online finalization for an existing pending first leg", async () => {
  const fixture = setup([]);
  fixture.executor.seedPending(childCommandId("hedge-start-1", "first"), "long-leg");
  const restarted = new ArbitrageHedgeStartService(fixture.store as never, fixture.executor as never, {
    clock: clock(),
    sleep: async () => undefined,
    firstLegFinalizationBudgetMs: 100,
    firstLegFinalizationInitialPollMs: 1,
    firstLegFinalizationMaxPollMs: 4,
    firstLegFinalizationMaxAttempts: 4,
  });
  const result = await restarted.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "STOPPED_FIRST_LEG_PENDING");
  assert.equal(fixture.executor.reconcileCalls.length, 0);
  assert.equal(fixture.executor.mutationLegs.length, 0);
});

test("an idempotent pending second leg never restores a prior online continuation intent", async () => {
  const fixture = setup([]);
  fixture.executor.seedConfirmed(childCommandId("hedge-start-1", "first"), "long-leg", "100");
  fixture.executor.seedPending(childCommandId("hedge-start-1", "second"), "short-leg");
  const restarted = new ArbitrageHedgeStartService(fixture.store as never, fixture.executor as never, {
    clock: clock(),
    sleep: async () => undefined,
    firstLegFinalizationBudgetMs: 100,
    firstLegFinalizationInitialPollMs: 1,
    firstLegFinalizationMaxPollMs: 4,
    firstLegFinalizationMaxAttempts: 4,
  });
  const result = await restarted.start("user-a", fixture.instance.arbitrageId, request());
  assert.equal(result.status, "STOPPED_SECOND_LEG_PENDING");
  assert.equal(fixture.executor.reconcileCalls.length, 0);
  assert.equal(fixture.executor.mutationLegs.length, 0);
});

function setup(outcomes: Outcome[], options: Readonly<{
  throwSecond?: ArbitrageExecutionCommandError["category"];
  firstGate?: Promise<void>;
  reconciliationOutcomes?: readonly Outcome[];
  reconcileError?: boolean;
  reconcileErrors?: readonly ArbitrageExecutionCommandError[];
  finalizationMaxAttempts?: number;
  omitFirstExecutionRecordId?: boolean;
}> = {}, initialInstance: ArbitrageInstance = baseInstance()) {
  const state = { instance: initialInstance };
  const outcomeAudits: any[] = [];
  const auditCommands = new Set<string>();
  const store = {
    get: (userId: string, arbitrageId: string) =>
      userId === state.instance.userId && arbitrageId === state.instance.arbitrageId ? state.instance : null,
    recordCommandOutcome: (_userId: string, audit: any) => {
      if (!auditCommands.has(audit.commandId)) {
        auditCommands.add(audit.commandId);
        outcomeAudits.push(audit);
      }
      return audit;
    },
  };
  const executor = new FakeExecutor(state, outcomes, options);
  const sleeps: number[] = [];
  const service = new ArbitrageHedgeStartService(store as never, executor as never, {
    clock: clock(),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    firstLegFinalizationBudgetMs: 100,
    firstLegFinalizationInitialPollMs: 1,
    firstLegFinalizationMaxPollMs: 4,
    firstLegFinalizationMaxAttempts: options.finalizationMaxAttempts ?? 4,
  });
  return { service, store, executor, sleeps, outcomeAudits, get instance() { return state.instance; } };
}

type Outcome = Readonly<{ status: "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED" | "UNKNOWN"; confirmedQuantity: string }>;
function outcome(status: Outcome["status"], confirmedQuantity: string): Outcome { return { status, confirmedQuantity }; }

class FakeExecutor {
  readonly mutationLegs: string[] = [];
  readonly commandIds: string[] = [];
  readonly reconcileCalls: Array<{ arbitrageId: string; legId: string; executionIntentId?: string }> = [];
  private readonly byCommand = new Map<string, ArbitrageLegExecutionConfirmation>();
  private readonly reconciliationOutcomes: Outcome[];

  constructor(private readonly state: { instance: ArbitrageInstance }, private readonly outcomes: Outcome[], private readonly options: Readonly<{
    throwSecond?: ArbitrageExecutionCommandError["category"];
    firstGate?: Promise<void>;
    reconciliationOutcomes?: readonly Outcome[];
    reconcileError?: boolean;
    reconcileErrors?: readonly ArbitrageExecutionCommandError[];
    omitFirstExecutionRecordId?: boolean;
  }>) {
    this.reconciliationOutcomes = [...(options.reconciliationOutcomes ?? [])];
    this.reconcileErrors = [...(options.reconcileErrors ?? [])];
  }

  private readonly reconcileErrors: ArbitrageExecutionCommandError[];

  async executeLeg(_userId: string, input: unknown): Promise<ArbitrageLegExecutionConfirmation> {
    const request = input as { legId: string; commandId: string; opportunityId: string };
    this.commandIds.push(request.commandId);
    const replay = this.byCommand.get(request.commandId);
    if (replay) {
      if (request.opportunityId !== "opportunity-1") throw new ArbitrageExecutionCommandError("idempotency_conflict", "changed payload");
      return { ...replay, instance: this.state.instance, idempotentReplay: true };
    }
    if (request.legId === "short-leg" && this.options.throwSecond) {
      throw new ArbitrageExecutionCommandError(this.options.throwSecond, "safety blocked");
    }
    if (request.legId === "long-leg" && this.options.firstGate) await this.options.firstGate;
    const next = this.outcomes.shift();
    if (!next) throw new Error("missing fake outcome");
    this.mutationLegs.push(request.legId);
    return this.record(request.commandId, request.legId, next);
  }

  async reconcileLeg(_userId: string, input: unknown): Promise<ArbitrageLegExecutionConfirmation> {
    const request = input as { arbitrageId: string; legId: string; executionIntentId?: string };
    this.reconcileCalls.push(request);
    if (this.options.reconcileError) throw new Error("provider query unavailable");
    const reconcileError = this.reconcileErrors.shift();
    if (reconcileError) throw reconcileError;
    const reference = this.state.instance.executionReferences.find((candidate) =>
      candidate.legId === request.legId && candidate.executionIntentId === request.executionIntentId);
    if (!reference) throw new Error("missing fake execution reference");
    const next = this.reconciliationOutcomes.shift();
    if (!next) return confirmationFromFakeReference(this.state.instance, reference, true);
    const updatedReference = { ...reference, status: next.status, confirmedQuantity: next.confirmedQuantity,
      updatedAt: reference.updatedAt + 1 };
    const legs = this.state.instance.legs.map((leg) => leg.legId === request.legId
      ? { ...leg, confirmedOpenedQuantity: next.confirmedQuantity } : leg) as unknown as ArbitrageInstance["legs"];
    this.state.instance = {
      ...this.state.instance,
      legs,
      executionReferences: this.state.instance.executionReferences.map((candidate) =>
        candidate.executionIntentId === reference.executionIntentId ? updatedReference : candidate),
      status: legs.every((leg) => leg.confirmedOpenedQuantity === "100") ? "HOLDING"
        : legs.some((leg) => leg.confirmedOpenedQuantity !== "0") ? "RESIDUAL" : "OPENING",
      updatedAt: this.state.instance.updatedAt + 1,
    };
    return confirmationFromFakeReference(this.state.instance, updatedReference, false);
  }

  seedConfirmed(commandId: string, legId: string, quantity: string) {
    this.record(commandId, legId, outcome("CONFIRMED", quantity));
    this.mutationLegs.length = 0;
    this.commandIds.length = 0;
  }

  seedPending(commandId: string, legId: string) {
    this.record(commandId, legId, outcome("PENDING_CONFIRMATION", "0"));
    this.mutationLegs.length = 0;
    this.commandIds.length = 0;
  }

  private record(commandId: string, legId: string, next: Outcome) {
    const intentId = `intent-${commandId}`;
    const reference = { arbitrageId: this.state.instance.arbitrageId, legId, phase: "OPENING" as const,
      quantityEffect: "INCREASE" as const, executionIntentId: intentId,
      executionRecordId: legId === "long-leg" && this.options.omitFirstExecutionRecordId ? null : `record-${commandId}`,
      requestedQuantity: "100", confirmedQuantity: next.confirmedQuantity, status: next.status, createdAt: 10, updatedAt: 11 };
    const legs = this.state.instance.legs.map((leg) => leg.legId === legId
      ? { ...leg, confirmedOpenedQuantity: next.confirmedQuantity } : leg) as unknown as ArbitrageInstance["legs"];
    this.state.instance = { ...this.state.instance, legs,
      executionReferences: [...this.state.instance.executionReferences, reference],
      status: legs.every((leg) => leg.confirmedOpenedQuantity === "100") ? "HOLDING"
        : legs.some((leg) => leg.confirmedOpenedQuantity !== "0") ? "RESIDUAL" : "OPENING",
      updatedAt: this.state.instance.updatedAt + 1 };
    const confirmation: ArbitrageLegExecutionConfirmation = { instance: this.state.instance,
      executionRecord: { executionId: reference.executionRecordId, intentId, status: next.status,
        plannedQuantity: "100", confirmedQuantity: next.confirmedQuantity, verifiedAt: reference.updatedAt },
      idempotentReplay: false, secondLegAllowed: next.status === "CONFIRMED" && next.confirmedQuantity === "100" };
    this.byCommand.set(commandId, confirmation);
    return confirmation;
  }
}

function transientReconcileError(substage: "EXECUTION_LIST" | "EXECUTION_EVIDENCE_COMPARE") {
  return new ArbitrageExecutionCommandError(
    "execution_state_unknown",
    "execution evidence pending",
    undefined,
    Object.freeze({ venue: "bybit", substage, category: "EXECUTION_EVIDENCE_PENDING", providerCode: null, retryable: true }),
  );
}

function nonRetryableReconcileError(category: string) {
  return new ArbitrageExecutionCommandError(
    "execution_state_unknown",
    "reconcile failed",
    undefined,
    Object.freeze({ venue: "bybit", substage: "EXECUTION_EVIDENCE_COMPARE", category, providerCode: null, retryable: false }),
  );
}

function confirmationFromFakeReference(
  instance: ArbitrageInstance,
  reference: ArbitrageInstance["executionReferences"][number],
  idempotentReplay: boolean,
): ArbitrageLegExecutionConfirmation {
  return {
    instance,
    executionRecord: {
      executionId: reference.executionRecordId,
      intentId: reference.executionIntentId,
      status: reference.status === "CLAIMED" || reference.status === "LINKED" ? "CREATED" : reference.status,
      plannedQuantity: reference.requestedQuantity,
      confirmedQuantity: reference.confirmedQuantity,
      verifiedAt: reference.updatedAt,
    },
    idempotentReplay,
    secondLegAllowed: reference.status === "CONFIRMED" && reference.confirmedQuantity === reference.requestedQuantity,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return { hedgeCommandId: "hedge-start-1", firstLegId: "long-leg", confirmationId: "confirmation-1",
    opportunityId: "opportunity-1", horizonDays: 90, quantityInput: { mode: "ASSET_QUANTITY", quantity: "100" },
    executionMode: "EXECUTION_PRIORITY", confirmed: true, ...overrides };
}

function baseInstance(
  perpetualVenue: "binance" | "okx" | "bybit" | "bitget" = "binance",
  spotVenue: "binance" | "okx" | "bybit" | "bitget" = "binance",
): ArbitrageInstance {
  return { arbitrageId: "arbitrage-1", userId: "user-a", strategyType: "SPOT_PERPETUAL", sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0", status: "OPENING", createdAt: 1, openedAt: null, updatedAt: 1, closedAt: null,
    legs: [
      { legId: "long-leg", role: "LONG", venue: spotVenue, accountId: `account-${spotVenue}`, instrumentId: "BTC-USDT-SPOT",
        plannedQuantity: "100", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" },
      { legId: "short-leg", role: "SHORT", venue: perpetualVenue, accountId: `account-${perpetualVenue}`, instrumentId: "BTC-USDT-PERP",
        plannedQuantity: "100", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" },
    ], executionReferences: [], pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null,
      feesCosts: null, cumulativeNetPnl: null, updatedAt: null } };
}

function childCommandId(hedgeCommandId: string, phase: "first" | "second") {
  return `hedge-start-${createHash("sha256").update(`${hedgeCommandId}\0${phase}`).digest("hex")}`;
}
function clock() { let now = 100; return () => now++; }
