import assert from "node:assert/strict";
import test from "node:test";
import type { UnresolvedExecutionRecoveryCandidate } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { LocalNotDispatchedEvidenceEvaluator } from "./LocalNotDispatchedEvidenceEvaluator";

test("CLAIMED without any durable ExecutionRecord is proven locally before dispatch", async () => {
  const result = await new LocalNotDispatchedEvidenceEvaluator(
    { findByIntentId: () => [] },
    () => 123,
  ).evaluate(candidate());

  assert.deepEqual(result, {
    result: "PROVEN_NOT_DISPATCHED",
    source: "LOCAL_PRE_DISPATCH_PROOF",
    reason: "LOCAL_NO_EXECUTION_RECORD",
    checkedAt: 123,
  });
});

test("an ExecutionRecord or lookup failure never proves NOT_DISPATCHED", async () => {
  const exists = await new LocalNotDispatchedEvidenceEvaluator({
    findByIntentId: () => [{ executionId: "record-1" }] as never,
  }).evaluate(candidate());
  const unavailable = await new LocalNotDispatchedEvidenceEvaluator({
    findByIntentId: () => { throw new Error("SQLite unavailable"); },
  }).evaluate(candidate());

  assert.equal(exists.result, "DISPATCH_POSSIBLE");
  assert.equal(exists.reason, "LOCAL_EXECUTION_RECORD_EXISTS");
  assert.equal(unavailable.result, "INSUFFICIENT_EVIDENCE");
  assert.equal(unavailable.reason, "LOCAL_EXECUTION_RECORD_LOOKUP_UNAVAILABLE");
});

test("LINKED or non-null record identity cannot use the local no-record proof", async () => {
  let lookups = 0;
  const evaluator = new LocalNotDispatchedEvidenceEvaluator({
    findByIntentId: () => { lookups += 1; return []; },
  });

  assert.equal((await evaluator.evaluate(candidate({ status: "LINKED", executionRecordId: "record-1" }))).result,
    "DISPATCH_POSSIBLE");
  assert.equal(lookups, 0);
});

function candidate(
  overrides: Partial<UnresolvedExecutionRecoveryCandidate> = {},
): UnresolvedExecutionRecoveryCandidate {
  return Object.freeze({
    userId: "user-a",
    arbitrageId: "arbitrage-1",
    legId: "long-leg",
    executionIntentId: "intent-1",
    executionRecordId: null,
    status: "CLAIMED",
    phase: "OPENING",
    quantityEffect: "INCREASE",
    requestedQuantity: "100",
    confirmedQuantity: "0",
    venue: "binance",
    accountId: "binance:account-a",
    instrumentId: "DOGE-USDT-PERP",
    role: "LONG",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}
