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

function setup(outcomes: Outcome[], options: Readonly<{
  throwSecond?: ArbitrageExecutionCommandError["category"];
  firstGate?: Promise<void>;
}> = {}, initialInstance: ArbitrageInstance = baseInstance()) {
  const state = { instance: initialInstance };
  const store = { get: (userId: string, arbitrageId: string) =>
    userId === state.instance.userId && arbitrageId === state.instance.arbitrageId ? state.instance : null };
  const executor = new FakeExecutor(state, outcomes, options);
  const service = new ArbitrageHedgeStartService(store as never, executor as never, { clock: clock() });
  return { service, store, executor, get instance() { return state.instance; } };
}

type Outcome = Readonly<{ status: "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED" | "UNKNOWN"; confirmedQuantity: string }>;
function outcome(status: Outcome["status"], confirmedQuantity: string): Outcome { return { status, confirmedQuantity }; }

class FakeExecutor {
  readonly mutationLegs: string[] = [];
  readonly commandIds: string[] = [];
  private readonly byCommand = new Map<string, ArbitrageLegExecutionConfirmation>();

  constructor(private readonly state: { instance: ArbitrageInstance }, private readonly outcomes: Outcome[], private readonly options: Readonly<{
    throwSecond?: ArbitrageExecutionCommandError["category"];
    firstGate?: Promise<void>;
  }>) {}

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

  seedConfirmed(commandId: string, legId: string, quantity: string) {
    this.record(commandId, legId, outcome("CONFIRMED", quantity));
    this.mutationLegs.length = 0;
    this.commandIds.length = 0;
  }

  private record(commandId: string, legId: string, next: Outcome) {
    const intentId = `intent-${commandId}`;
    const reference = { arbitrageId: this.state.instance.arbitrageId, legId, phase: "OPENING" as const,
      quantityEffect: "INCREASE" as const, executionIntentId: intentId, executionRecordId: `record-${commandId}`,
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

function request(overrides: Record<string, unknown> = {}) {
  return { hedgeCommandId: "hedge-start-1", firstLegId: "long-leg", confirmationId: "confirmation-1",
    opportunityId: "opportunity-1", horizonDays: 90, quantityInput: { mode: "ASSET_QUANTITY", quantity: "100" },
    executionMode: "EXECUTION_PRIORITY", confirmed: true, ...overrides };
}

function baseInstance(perpetualVenue: "binance" | "okx" | "bybit" | "bitget" = "binance"): ArbitrageInstance {
  return { arbitrageId: "arbitrage-1", userId: "user-a", strategyType: "SPOT_PERPETUAL", sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0", status: "OPENING", createdAt: 1, openedAt: null, updatedAt: 1, closedAt: null,
    legs: [
      { legId: "long-leg", role: "LONG", venue: "binance", accountId: "account-1", instrumentId: "BTC-USDT-SPOT",
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
