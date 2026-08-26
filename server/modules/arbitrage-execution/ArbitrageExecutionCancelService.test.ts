import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import { SqliteExecutionRecordStore } from "../cex/ExecutionRecordStore";
import type { ExecutionVenue } from "../cex/ExecutionIntent";
import { ManualReconciliationRequiredError } from "../cex/ManualReconciliationRequiredError";
import {
  ArbitrageExecutionCancelError,
  ArbitrageExecutionCancelService,
} from "./ArbitrageExecutionCancelService";
import {
  FormalExecutionRuntimeRegistry,
  formalExecutionRuntime,
} from "./FormalExecutionRuntimeRegistry";

const now = 1_900_000_000_000;

for (const instrumentId of ["BTC-USDT-SPOT", "BTC-USDT-PERP"] as const) {
  test(`known active ${instrumentId.endsWith("SPOT") ? "Spot" : "perpetual"} order cancels then reuses reconciliation`, async () => {
    const fixture = setup({ instrumentId });
    const result = await fixture.service.cancelKnownOrder("user-a", request());
    assert.deepEqual(fixture.cancelCalls, [{ userId: "user-a", executionId: "execution-1" }]);
    assert.deepEqual(fixture.reconcileCalls, [{
      userId: "user-a", arbitrageId: "arbitrage-1", legId: "long-leg", executionIntentId: "intent-1",
    }, {
      userId: "user-a", arbitrageId: "arbitrage-1", legId: "long-leg", executionIntentId: "intent-1",
    }]);
    assert.equal(result.executionRecord.status, "FAILED");
    assert.equal(result.executionRecord.confirmedQuantity, "0.123456789012345678");
    assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "0.123456789012345678");
  });
}

for (const venue of ["binance", "okx", "bybit", "bitget"] as const) {
  test(`${venue} cancel ACK is followed by authoritative original-order reconciliation`, async () => {
    const fixture = setup({ venue });
    const result = await fixture.service.cancelKnownOrder("user-a", request());

    assert.equal(fixture.cancelCalls.length, 1);
    assert.equal(fixture.reconcileCalls.length, 2);
    assert.equal(result.executionRecord.status, "FAILED");
    assert.equal(result.executionRecord.confirmedQuantity, "0.123456789012345678");
  });

  test(`${venue} cancel/fill finalization matrix preserves authoritative cumulative quantity`, async (t) => {
    for (const scenario of [
      { name: "before fill", initial: "0", final: "0", status: "FAILED" as const },
      { name: "partial 40", initial: "0", final: "0.4", status: "FAILED" as const },
      { name: "race 40 to 70", initial: "0.4", final: "0.7", status: "FAILED" as const },
      { name: "full fill wins", initial: "0.4", final: "1", status: "CONFIRMED" as const },
      { name: "ACK but still live", initial: "0.4", final: "0.4", status: "PENDING_CONFIRMATION" as const },
      { name: "query unknown", initial: "0.4", final: "0.4", status: "UNKNOWN" as const },
    ]) {
      await t.test(scenario.name, async () => {
        const fixture = setup({
          venue,
          initialConfirmedQuantity: scenario.initial,
          confirmedQuantity: scenario.final,
          reconcileStatus: scenario.status,
        });
        const result = await fixture.service.cancelKnownOrder("user-a", request());
        assert.equal(result.executionRecord.status, scenario.status);
        assert.equal(result.executionRecord.confirmedQuantity, scenario.final);
        assert.equal(result.instance.legs[0].confirmedOpenedQuantity, scenario.final);
        assert.equal(fixture.cancelCalls.length, 1);
        assert.equal(fixture.reconcileCalls.length, 2);
      });
    }
  });
}

test("canceled-with-partial keeps authoritative Decimal quantity through reconciliation", async () => {
  const fixture = setup();
  const result = await fixture.service.cancelKnownOrder("user-a", request());
  assert.equal(result.executionRecord.confirmedQuantity, "0.123456789012345678");
  assert.equal(result.instance.executionReferences[0]?.confirmedQuantity, "0.123456789012345678");
  assert.equal(result.secondLegAllowed, false);
});

test("terminal, repeated, and concurrent cancellation are idempotent", async () => {
  const fixture = setup({ delay: true });
  const [left, right] = await Promise.all([
    fixture.service.cancelKnownOrder("user-a", request()),
    fixture.service.cancelKnownOrder("user-a", request()),
  ]);
  assert.equal(fixture.cancelCalls.length, 1);
  assert.equal(fixture.reconcileCalls.length, 2);
  assert.equal(left.executionRecord.confirmedQuantity, right.executionRecord.confirmedQuantity);

  const replay = await fixture.service.cancelKnownOrder("user-a", request());
  assert.equal(replay.executionRecord.confirmedQuantity, "0.123456789012345678");
  assert.equal(fixture.cancelCalls.length, 1);
  assert.equal(fixture.reconcileCalls.length, 3);
});

test("cancel timeout still queries the original order and preserves its terminal partial fill", async () => {
  const fixture = setup({ cancelError: new Error("provider timeout") });

  const result = await fixture.service.cancelKnownOrder("user-a", request());

  assert.equal(fixture.cancelCalls.length, 1);
  assert.equal(fixture.reconcileCalls.length, 2);
  assert.equal(result.executionRecord.status, "FAILED");
  assert.equal(result.executionRecord.confirmedQuantity, "0.123456789012345678");
});

test("cancel timeout plus unavailable order query remains unresolved and fails closed", async () => {
  const fixture = setup({
    cancelError: new Error("provider timeout"),
    postReconcileError: new Error("query unavailable"),
  });

  await assert.rejects(
    () => fixture.service.cancelKnownOrder("user-a", request()),
    (error: unknown) => error instanceof ArbitrageExecutionCancelError
      && error.category === "execution_state_unknown",
  );

  assert.equal(fixture.current().executionReferences[0]?.status, "PENDING_CONFIRMATION");
  assert.equal(fixture.cancelCalls.length, 1);
  assert.equal(fixture.reconcileCalls.length, 2);
});

test("cancel ACK followed by a live order keeps both opening and closing gates unresolved", async () => {
  for (const phase of ["OPENING", "CLOSING"] as const) {
    const fixture = setup({ reconcileStatus: "PENDING_CONFIRMATION", phase });
    const result = await fixture.service.cancelKnownOrder("user-a", request());

    assert.equal(result.executionRecord.status, "PENDING_CONFIRMATION", phase);
    assert.equal(result.instance.executionReferences[0]?.status, "PENDING_CONFIRMATION", phase);
    assert.equal(fixture.cancelCalls.length, 1, phase);
    assert.equal(fixture.reconcileCalls.length, 2, phase);
  }
});

test("authoritative full fill wins over cancel and enables only the fully confirmed first leg", async () => {
  const fixture = setup({ reconcileStatus: "CONFIRMED", confirmedQuantity: "1" });

  const result = await fixture.service.cancelKnownOrder("user-a", request());

  assert.equal(result.executionRecord.status, "CONFIRMED");
  assert.equal(result.executionRecord.confirmedQuantity, "1");
  assert.equal(result.secondLegAllowed, true);
});

test("unknown reference, wrong user, and request-controlled provider identity fail closed", async () => {
  const fixture = setup();
  await assert.rejects(
    () => fixture.service.cancelKnownOrder("user-b", request()),
    (error) => error instanceof ArbitrageExecutionCancelError && error.category === "arbitrage_instance_not_found",
  );
  await assert.rejects(
    () => fixture.service.cancelKnownOrder("user-a", { ...request(), executionIntentId: "unknown-intent" }),
    (error) => error instanceof ArbitrageExecutionCancelError
      && error.category === "arbitrage_execution_reference_not_found",
  );
  for (const field of ["providerOrderId", "providerSymbol", "accountId", "userId"]) {
    await assert.rejects(
      () => fixture.service.cancelKnownOrder("user-a", { ...request(), [field]: "untrusted" }),
      /不允许的字段/u,
    );
  }
  assert.equal(fixture.cancelCalls.length, 0);
});

test("account, venue, instrument, and record identity mismatches reject before cancel", async () => {
  for (const override of [
    { accountId: "account-b" },
    { venue: "okx" as const },
    { instrumentId: "ETH-USDT-SPOT" },
    { intentId: "other-intent" },
  ]) {
    const fixture = setup({ record: override });
    await assert.rejects(
      () => fixture.service.cancelKnownOrder("user-a", request()),
      (error) => error instanceof ArbitrageExecutionCancelError && error.category === "cancel_identity_conflict",
    );
    assert.equal(fixture.cancelCalls.length, 0);
  }
});

test("missing local record and multiple unresolved references fail closed", async () => {
  const missing = setup({ missingRecord: true });
  await assert.rejects(
    () => missing.service.cancelKnownOrder("user-a", request()),
    (error) => error instanceof ArbitrageExecutionCancelError && error.category === "cancel_identity_conflict",
  );

  const multiple = setup({ multipleUnresolved: true });
  await assert.rejects(
    () => multiple.service.cancelKnownOrder("user-a", request()),
    (error) => error instanceof ArbitrageExecutionCancelError && error.category === "cancel_state_unavailable",
  );
  assert.equal(missing.cancelCalls.length + multiple.cancelCalls.length, 0);
});

test("formal cancel preserves manual reconciliation metadata", async () => {
  const fixture = setup({
    cancelError: new ManualReconciliationRequiredError(
      "intent:intent-1",
      "Stored Binance provider orderId is invalid.",
    ),
  });

  await assert.rejects(
    () => fixture.service.cancelKnownOrder("user-a", request()),
    (error: unknown) => error instanceof ArbitrageExecutionCancelError
      && error.category === "manual_reconciliation_required"
      && error.manualReconciliation?.manualReconciliationRequired === true
      && error.manualReconciliation.idempotencyKey === "intent:intent-1"
      && error.manualReconciliation.reason === "Stored Binance provider orderId is invalid.",
  );
  assert.equal(fixture.reconcileCalls.length, 1);
});

test("authoritative terminal state prevents cancel before mutation", async () => {
  for (const status of ["CONFIRMED", "FAILED"] as const) {
    const fixture = setup({
      preReconcileStatus: status,
      preConfirmedQuantity: status === "CONFIRMED" ? "1" : "0.4",
    });
    const result = await fixture.service.cancelKnownOrder("user-a", request());
    assert.equal(result.executionRecord.status, status);
    assert.equal(fixture.cancelCalls.length, 0);
    assert.equal(fixture.reconcileCalls.length, 1);
  }
});

test("authoritative UNKNOWN fails closed before cancel", async () => {
  const fixture = setup({ preReconcileStatus: "UNKNOWN", preConfirmedQuantity: "0.4" });
  await assert.rejects(
    () => fixture.service.cancelKnownOrder("user-a", request()),
    (error: unknown) => error instanceof ArbitrageExecutionCancelError
      && error.category === "execution_state_unknown",
  );
  assert.equal(fixture.cancelCalls.length, 0);
  assert.equal(fixture.reconcileCalls.length, 1);
});

test("authoritative reconcile persistence failure fails closed before cancel", async () => {
  const fixture = setup({ preReconcileError: new Error("SQLITE_BUSY") });
  await assert.rejects(
    () => fixture.service.cancelKnownOrder("user-a", request()),
    (error: unknown) => error instanceof ArbitrageExecutionCancelError
      && error.category === "execution_state_unknown",
  );
  assert.equal(fixture.cancelCalls.length, 0);
  assert.equal(fixture.reconcileCalls.length, 1);
  assert.equal(fixture.current().executionReferences[0]?.status, "PENDING_CONFIRMATION");
});

test("real SQLITE_BUSY after authoritative CONFIRMED keeps recovery identity and prevents queued cancel across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "cancel-pre-reconcile-busy-"));
  const dbPath = join(root, "execution-records.sqlite");
  const records = new SqliteExecutionRecordStore({ dbPath });
  const pending = Object.freeze({
    executionId: "execution-1", intentId: "intent-1", userId: "user-a", venue: "binance" as const,
    accountId: "account-a", instrumentId: "BTC-USDT-SPOT", status: "PENDING_CONFIRMATION" as const,
    executionAttemptId: "attempt-1", remoteOrderId: "provider-order-1", createdAt: now, updatedAt: now,
  });
  records.create(pending);
  const lock = new DatabaseSync(dbPath);
  const currentInstance = instance("BTC-USDT-SPOT", "binance", [executionReference()]);
  let cancelMutations = 0;
  const runtime = {
    async execute() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async cancel() {
      cancelMutations += 1;
      throw new Error("cancel must not run");
    },
  };
  const reconciler = {
    async reconcileLeg() {
      const persisted = records.loadForUser("user-a", "execution-1");
      assert.ok(persisted);
      records.update(Object.freeze({ ...persisted, status: "CONFIRMED", updatedAt: now + 1 }), persisted);
      throw new Error("unreachable");
    },
  };
  const service = new ArbitrageExecutionCancelService(
    { get: () => currentInstance },
    records,
    new FormalExecutionRuntimeRegistry().register(formalExecutionRuntime("binance", runtime)),
    reconciler,
  );
  try {
    lock.exec("BEGIN IMMEDIATE");
    await assert.rejects(
      () => service.cancelKnownOrder("user-a", request()),
      (error: unknown) => error instanceof ArbitrageExecutionCancelError
        && error.category === "execution_state_unknown",
    );
    assert.equal(cancelMutations, 0);
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
    records.close();
  }

  const restarted = new SqliteExecutionRecordStore({ dbPath });
  try {
    const unresolved = restarted.loadForUser("user-a", "execution-1");
    assert.equal(unresolved?.status, "PENDING_CONFIRMATION");
    assert.equal(unresolved?.executionAttemptId, "attempt-1");
    assert.equal(unresolved?.remoteOrderId, "provider-order-1");
    const restartService = new ArbitrageExecutionCancelService(
      { get: () => currentInstance },
      restarted,
      new FormalExecutionRuntimeRegistry().register(formalExecutionRuntime("binance", runtime)),
      {
        async reconcileLeg() {
          const persisted = restarted.loadForUser("user-a", "execution-1");
          assert.ok(persisted);
          restarted.update(Object.freeze({ ...persisted, status: "CONFIRMED", updatedAt: now + 2 }), persisted);
          return confirmation(Object.freeze({
            ...currentInstance,
            executionReferences: Object.freeze([{ ...currentInstance.executionReferences[0]!, status: "CONFIRMED" as const,
              confirmedQuantity: "1", updatedAt: now + 2 }]),
          }), { ...currentInstance.executionReferences[0]!, status: "CONFIRMED" as const,
            confirmedQuantity: "1", updatedAt: now + 2 }, false);
        },
      },
    );
    const recovered = await restartService.cancelKnownOrder("user-a", request());
    assert.equal(recovered.executionRecord.status, "CONFIRMED");
    assert.equal(cancelMutations, 0);
  } finally {
    restarted.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated terminal pre-cancel observations never create a cancel mutation", async () => {
  const fixture = setup({ preReconcileStatus: "CONFIRMED", preConfirmedQuantity: "1" });
  const first = await fixture.service.cancelKnownOrder("user-a", request());
  const replay = await fixture.service.cancelKnownOrder("user-a", request());
  assert.equal(first.executionRecord.status, "CONFIRMED");
  assert.equal(replay.executionRecord.status, "CONFIRMED");
  assert.equal(fixture.cancelCalls.length, 0);
});

function setup(options: Readonly<{
  venue?: ExecutionVenue;
  instrumentId?: "BTC-USDT-SPOT" | "BTC-USDT-PERP";
  phase?: "OPENING" | "CLOSING";
  delay?: boolean;
  missingRecord?: boolean;
  multipleUnresolved?: boolean;
  record?: Partial<ExecutionRecord>;
  cancelError?: Error;
  reconcileError?: Error;
  preReconcileError?: Error;
  postReconcileError?: Error;
  reconcileStatus?: "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN";
  preReconcileStatus?: "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN";
  confirmedQuantity?: string;
  preConfirmedQuantity?: string;
  initialConfirmedQuantity?: string;
}> = {}) {
  const venue = options.venue ?? "binance";
  const instrumentId = options.instrumentId ?? "BTC-USDT-SPOT";
  const reference = executionReference(options.phase, options.initialConfirmedQuantity);
  let current = instance(instrumentId, venue, options.multipleUnresolved
    ? [reference, { ...reference, executionIntentId: "intent-2", executionRecordId: "execution-2" }]
    : [reference]);
  const record: ExecutionRecord = Object.freeze({
    executionId: "execution-1",
    intentId: "intent-1",
    userId: "user-a",
    venue,
    accountId: "account-a",
    instrumentId,
    status: "PENDING_CONFIRMATION",
    createdAt: now,
    updatedAt: now,
    ...options.record,
  });
  const cancelCalls: Array<{ userId: string; executionId: string }> = [];
  const reconcileCalls: Array<{ userId: string; arbitrageId: string; legId: string; executionIntentId?: string }> = [];
  const runtime = {
    async execute() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async cancel(userId: string, executionId: string) {
      cancelCalls.push({ userId, executionId });
      if (options.cancelError) throw options.cancelError;
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, 5));
      return { executionRecord: { ...record, status: "FAILED" }, observation: { state: "CANCELLED", observedAt: now + 1 } } as any;
    },
  };
  const runtimes = new FormalExecutionRuntimeRegistry()
    .register(formalExecutionRuntime(venue, runtime));
  const reconciler = {
    async reconcileLeg(userId: string, input: unknown) {
      const request = input as { arbitrageId: string; legId: string; executionIntentId?: string };
      reconcileCalls.push({ userId, ...request });
      const reconciliationNumber = reconcileCalls.length;
      if (reconciliationNumber === 1 && options.preReconcileError) throw options.preReconcileError;
      if (reconciliationNumber > 1 && options.postReconcileError) throw options.postReconcileError;
      if (options.reconcileError) throw options.reconcileError;
      const preCancel = reconciliationNumber === 1;
      const status = preCancel
        ? options.preReconcileStatus ?? "PENDING_CONFIRMATION"
        : options.reconcileStatus ?? "FAILED";
      const confirmedQuantity = preCancel
        ? options.preConfirmedQuantity ?? options.initialConfirmedQuantity ?? "0"
        : options.confirmedQuantity ?? "0.123456789012345678";
      const updatedReference = {
        ...current.executionReferences[0]!,
        status,
        confirmedQuantity,
        updatedAt: now + 2,
      };
      current = Object.freeze({
        ...current,
        legs: Object.freeze([
          Object.freeze({
            ...current.legs[0],
            ...(updatedReference.quantityEffect === "INCREASE"
              ? { confirmedOpenedQuantity: confirmedQuantity }
              : { confirmedClosedQuantity: confirmedQuantity }),
          }),
          current.legs[1],
        ]) as unknown as ArbitrageInstance["legs"],
        executionReferences: Object.freeze([updatedReference]),
        updatedAt: now + 2,
      });
      return confirmation(current, updatedReference, false);
    },
  };
  const service = new ArbitrageExecutionCancelService(
    { get: (userId) => userId === "user-a" ? current : null },
    { loadForUser: (userId, executionId) => !options.missingRecord && userId === "user-a" && executionId === "execution-1" ? record : null },
    runtimes,
    reconciler as any,
  );
  return { service, cancelCalls, reconcileCalls, current: () => current };
}

function request() {
  return { arbitrageId: "arbitrage-1", legId: "long-leg", executionIntentId: "intent-1", confirmed: true };
}

function executionReference(
  phase: "OPENING" | "CLOSING" = "OPENING",
  confirmedQuantity = "0",
) {
  return Object.freeze({
    arbitrageId: "arbitrage-1",
    legId: "long-leg",
    phase,
    quantityEffect: phase === "OPENING" ? "INCREASE" as const : "DECREASE" as const,
    executionIntentId: "intent-1",
    executionRecordId: "execution-1",
    requestedQuantity: "1",
    confirmedQuantity,
    status: "PENDING_CONFIRMATION" as const,
    createdAt: now,
    updatedAt: now,
  });
}

function instance(
  instrumentId: string,
  venue: ExecutionVenue,
  executionReferences: ArbitrageInstance["executionReferences"],
): ArbitrageInstance {
  const initial = executionReferences[0]?.confirmedQuantity ?? "0";
  const quantityEffect = executionReferences[0]?.quantityEffect ?? "INCREASE";
  return Object.freeze({
    arbitrageId: "arbitrage-1",
    userId: "user-a",
    strategyType: "SPOT_PERPETUAL",
    sourcePlanId: "source-1",
    maxResidualBaseQuantity: "0",
    status: "OPENING",
    createdAt: now,
    openedAt: null,
    updatedAt: now,
    closedAt: null,
    legs: Object.freeze([
      Object.freeze({
        legId: "long-leg", role: "LONG", venue, accountId: "account-a", instrumentId, plannedQuantity: "1",
        confirmedOpenedQuantity: quantityEffect === "INCREASE" ? initial : "1",
        confirmedClosedQuantity: quantityEffect === "DECREASE" ? initial : "0",
      }),
      Object.freeze({ legId: "short-leg", role: "SHORT", venue, accountId: "account-a", instrumentId: "BTC-USDT-PERP", plannedQuantity: "1", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" }),
    ]) as unknown as ArbitrageInstance["legs"],
    executionReferences: Object.freeze(executionReferences),
    pnl: Object.freeze({ asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null }),
  });
}

function confirmation(
  value: ArbitrageInstance,
  reference: ArbitrageInstance["executionReferences"][number],
  idempotentReplay: boolean,
) {
  return Object.freeze({
    instance: value,
    executionRecord: Object.freeze({
      executionId: reference.executionRecordId,
      intentId: reference.executionIntentId,
      status: reference.status === "CLAIMED" || reference.status === "LINKED" ? "CREATED" as const : reference.status,
      plannedQuantity: reference.requestedQuantity,
      confirmedQuantity: reference.confirmedQuantity,
      verifiedAt: reference.updatedAt,
    }),
    idempotentReplay,
    secondLegAllowed: value.executionReferences.length === 1
      && reference.status === "CONFIRMED"
      && reference.confirmedQuantity === reference.requestedQuantity,
  });
}
