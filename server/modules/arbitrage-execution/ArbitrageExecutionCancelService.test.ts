import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
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
    assert.deepEqual(fixture.reconcileCalls, [{ userId: "user-a", arbitrageId: "arbitrage-1", legId: "long-leg" }]);
    assert.equal(result.executionRecord.status, "FAILED");
    assert.equal(result.executionRecord.confirmedQuantity, "0.123456789012345678");
    assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "0.123456789012345678");
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
  assert.equal(fixture.reconcileCalls.length, 1);
  assert.equal(left.executionRecord.confirmedQuantity, right.executionRecord.confirmedQuantity);

  const replay = await fixture.service.cancelKnownOrder("user-a", request());
  assert.equal(replay.idempotentReplay, true);
  assert.equal(fixture.cancelCalls.length, 1);
  assert.equal(fixture.reconcileCalls.length, 1);
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
  assert.equal(fixture.reconcileCalls.length, 0);
});

function setup(options: Readonly<{
  instrumentId?: "BTC-USDT-SPOT" | "BTC-USDT-PERP";
  delay?: boolean;
  missingRecord?: boolean;
  multipleUnresolved?: boolean;
  record?: Partial<ExecutionRecord>;
  cancelError?: Error;
}> = {}) {
  const instrumentId = options.instrumentId ?? "BTC-USDT-SPOT";
  const reference = executionReference();
  let current = instance(instrumentId, options.multipleUnresolved
    ? [reference, { ...reference, executionIntentId: "intent-2", executionRecordId: "execution-2" }]
    : [reference]);
  const record: ExecutionRecord = Object.freeze({
    executionId: "execution-1",
    intentId: "intent-1",
    userId: "user-a",
    venue: "binance",
    accountId: "account-a",
    instrumentId,
    status: "PENDING_CONFIRMATION",
    createdAt: now,
    updatedAt: now,
    ...options.record,
  });
  const cancelCalls: Array<{ userId: string; executionId: string }> = [];
  const reconcileCalls: Array<{ userId: string; arbitrageId: string; legId: string }> = [];
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
    .register(formalExecutionRuntime("binance", runtime));
  const reconciler = {
    async reconcileLeg(userId: string, input: unknown) {
      const request = input as { arbitrageId: string; legId: string };
      reconcileCalls.push({ userId, ...request });
      const updatedReference = {
        ...current.executionReferences[0]!,
        status: "FAILED" as const,
        confirmedQuantity: "0.123456789012345678",
        updatedAt: now + 2,
      };
      current = Object.freeze({
        ...current,
        legs: Object.freeze([
          Object.freeze({ ...current.legs[0], confirmedOpenedQuantity: "0.123456789012345678" }),
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
  return { service, cancelCalls, reconcileCalls };
}

function request() {
  return { arbitrageId: "arbitrage-1", legId: "long-leg", executionIntentId: "intent-1", confirmed: true };
}

function executionReference() {
  return Object.freeze({
    arbitrageId: "arbitrage-1",
    legId: "long-leg",
    phase: "OPENING" as const,
    quantityEffect: "INCREASE" as const,
    executionIntentId: "intent-1",
    executionRecordId: "execution-1",
    requestedQuantity: "1",
    confirmedQuantity: "0",
    status: "PENDING_CONFIRMATION" as const,
    createdAt: now,
    updatedAt: now,
  });
}

function instance(
  instrumentId: string,
  executionReferences: ArbitrageInstance["executionReferences"],
): ArbitrageInstance {
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
      Object.freeze({ legId: "long-leg", role: "LONG", venue: "binance", accountId: "account-a", instrumentId, plannedQuantity: "1", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" }),
      Object.freeze({ legId: "short-leg", role: "SHORT", venue: "binance", accountId: "account-a", instrumentId: "BTC-USDT-PERP", plannedQuantity: "1", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" }),
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
      status: "FAILED" as const,
      plannedQuantity: reference.requestedQuantity,
      confirmedQuantity: reference.confirmedQuantity,
      verifiedAt: reference.updatedAt,
    }),
    idempotentReplay,
    secondLegAllowed: false,
  });
}
