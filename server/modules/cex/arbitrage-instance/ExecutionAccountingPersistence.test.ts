import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutionRecord } from "../ExecutionRecord";
import { SqliteExecutionRecordStore } from "../ExecutionRecordStore";
import { ArbitrageInstanceStore } from "./ArbitrageInstanceStore";
import { deriveRealizedAccounting } from "./ExecutionAccountingFact";

test("authoritative full fill appends once and replay stays idempotent", () => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "open-long", recordId: "record-long", orderId: "order-long", requested: "10" });
    const update = {
      executionIntentId: "open-long", status: "CONFIRMED" as const, confirmedQuantity: "10", updatedAt: 4,
      accountingEvidence: evidence("order-long", "10", "100", "0.02", 4),
    };
    const first = instances.applyExecutionResult("user", "arb", update);
    const replay = instances.applyExecutionResult("user", "arb", {
      ...update, updatedAt: 5, accountingEvidence: evidence("order-long", "10", "100", "0.02", 5),
    });
    assert.equal(first.legs[0].confirmedOpenedQuantity, "10");
    assert.equal(replay.legs[0].confirmedOpenedQuantity, "10");
    const [fact] = instances.listExecutionAccountingFacts("user", "arb");
    assert.equal(instances.listExecutionAccountingFacts("user", "arb").length, 1);
    assert.equal(fact?.confirmedAt, 4);
  });
});

test("terminal partial fill appends its authoritative quantity", () => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "partial-long", recordId: "record-partial", orderId: "order-partial", requested: "10" });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "partial-long", status: "FAILED", confirmedQuantity: "4", updatedAt: 4,
      accountingEvidence: evidence("order-partial", "4", "101", "-0.01", 4),
    });
    const [fact] = instances.listExecutionAccountingFacts("user", "arb");
    assert.equal(fact?.terminalExecutionStatus, "FAILED");
    assert.equal(fact?.filledQuantity, "4");
    assert.equal(fact?.tradingFeeNetCostUsdt, "-0.01");
  });
});

test("terminal partial and FAILED status upgrade to the corrected authoritative full fill", () => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "open-long", recordId: "record-long", orderId: "order-long", requested: "100" });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "FAILED", confirmedQuantity: "40", updatedAt: 4,
      accountingEvidence: evidence("order-long", "40", "100", "0.02", 4),
    });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "100", updatedAt: 5,
      accountingEvidence: evidence("order-long", "100", "101", "0.05", 5),
    });
    const [fact] = instances.listExecutionAccountingFacts("user", "arb");
    assert.equal(fact?.filledQuantity, "100");
    assert.equal(fact?.terminalExecutionStatus, "CONFIRMED");
    assert.equal(fact?.averageFillPrice, "101");
    assert.equal(fact?.tradingFeeNetCostUsdt, "0.05");
  });
});

test("late price evidence enriches a fact without creating a second row", () => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "open-long", recordId: "record-long", orderId: "order-long", requested: "10" });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 4,
      accountingEvidence: evidence("order-long", "10", null, "0.02", 4),
    });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 5,
      accountingEvidence: evidence("order-long", "10", "100", "0.02", 5),
    });
    const [fact] = instances.listExecutionAccountingFacts("user", "arb");
    assert.equal(instances.listExecutionAccountingFacts("user", "arb").length, 1);
    assert.equal(fact?.averageFillPrice, "100");
    assert.equal(fact?.priceCompleteness, "COMPLETE");
  });
});

test("late fee evidence enriches a fact without using a current market conversion", () => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "open-long", recordId: "record-long", orderId: "order-long", requested: "10" });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 4,
      accountingEvidence: evidence("order-long", "10", "100", null, 4),
    });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 5,
      accountingEvidence: evidence("order-long", "10", "100", "-0.01", 5),
    });
    const [fact] = instances.listExecutionAccountingFacts("user", "arb");
    assert.equal(fact?.tradingFeeNetCostUsdt, "-0.01");
    assert.equal(fact?.feeCompleteness, "COMPLETE");
  });
});

test("base-asset fee persists its historical USDT equivalent from the same authoritative fill", () => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "open-long", recordId: "record-long", orderId: "order-long", requested: "10" });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 4,
      accountingEvidence: {
        providerOrderId: "order-long", filledQuantity: "10", averageFillPrice: "0.08745",
        feeAmountProvider: "0.0686", feeAsset: "DOGE", tradingFeeNetCostUsdt: null,
        confirmedAt: 4, completeness: "INCOMPLETE",
      },
    });
    const [fact] = instances.listExecutionAccountingFacts("user", "arb");
    assert.equal(fact?.tradingFeeNetCostUsdt, "0.00599907");
    assert.equal(fact?.feeCompleteness, "COMPLETE");
    assert.equal(fact?.completeness, "COMPLETE");
  });
});

test("a weaker replay cannot downgrade a complete fact", () => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "open-long", recordId: "record-long", orderId: "order-long", requested: "10" });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 4,
      accountingEvidence: evidence("order-long", "10", "100", "0.02", 4),
    });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 5,
      accountingEvidence: evidence("order-long", "10", null, null, 5),
    });
    const [fact] = instances.listExecutionAccountingFacts("user", "arb");
    assert.equal(fact?.averageFillPrice, "100");
    assert.equal(fact?.tradingFeeNetCostUsdt, "0.02");
    assert.equal(fact?.completeness, "COMPLETE");
  });
});

test("a downward quantity replay preserves the fact and marks it for review", () => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "open-long", recordId: "record-long", orderId: "order-long", requested: "100" });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "100", updatedAt: 4,
      accountingEvidence: evidence("order-long", "100", "100", "0.02", 4),
    });
    assert.throws(() => instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "40", updatedAt: 5,
      accountingEvidence: evidence("order-long", "40", "100", "0.01", 5),
    }), /cannot move backwards/u);
    const [fact] = instances.listExecutionAccountingFacts("user", "arb");
    assert.equal(fact?.filledQuantity, "100");
    assert.equal(fact?.averageFillPrice, "100");
    assert.equal(fact?.tradingFeeNetCostUsdt, "0.02");
    assert.equal(fact?.integrityStatus, "NEEDS_CHECK");
    assert.equal(fact?.completeness, "INCOMPLETE");
  });
});

test("Management Release never creates an execution accounting fact", () => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "open-long", recordId: "record-long", orderId: "order-long", requested: "10" });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 4,
      accountingEvidence: evidence("order-long", "10", "100", "0.02", 4),
    });
    const before = instances.listExecutionAccountingFacts("user", "arb");
    instances.releaseLegManagement("user", "arb", {
      releaseId: "release-long", commandId: "release-command-long", operationType: "MANAGEMENT_RELEASE",
      businessPayloadFingerprint: "release-fingerprint-long", arbitrageId: "arb", legId: "long",
      releasedQuantity: "10", reason: "USER_CONFIRMED_STOP_MANAGEMENT", source: "AUTHENTICATED_API",
      requestedByUserId: "user", requestedAt: 5, confirmedAt: 7,
      venue: "okx", accountId: "account", instrumentId: "DOGE-USDT-PERP", positionMode: "ONE_WAY",
      actualQuantity: "10", actualSignedNetQuantity: "10", actualLongQuantity: "10", actualShortQuantity: "0",
      availableQuantity: null, realityCheckedAt: 6,
    });
    const after = instances.listExecutionAccountingFacts("user", "arb");
    assert.equal(before.length, 1);
    assert.deepEqual(after, before);
  });
});

test("accounting append failure does not roll back the authoritative execution projection", (t) => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "open-long", recordId: "record-long", orderId: "order-long", requested: "10" });
    t.mock.method(console, "error", () => undefined);
    const projected = instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 4,
      accountingEvidence: evidence("wrong-order", "10", "100", "0.02", 4),
    });
    assert.equal(projected.legs[0].confirmedOpenedQuantity, "10");
    assert.equal(projected.executionReferences[0]?.status, "CONFIRMED");
    assert.deepEqual(instances.listExecutionAccountingFacts("user", "arb"), []);
  });
});

test("a failed accounting append reads incomplete and a later replay recovers it", (t) => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "open-long", recordId: "record-long", orderId: "order-long", requested: "10" });
    prepareReference(instances, records, {
      intentId: "open-short", recordId: "record-short", orderId: "order-short", requested: "10", legId: "short", at: 4,
    });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-short", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 6,
      accountingEvidence: evidence("order-short", "10", "110", "0.02", 6),
    });
    t.mock.method(console, "error", () => undefined);
    const projected = instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 7,
      accountingEvidence: evidence("wrong-order", "10", "100", "0.02", 7),
    });
    const incomplete = accounting(projected, instances);
    assert.equal(incomplete.realizedSpreadProfitCompleteness, "INCOMPLETE");
    assert.equal(incomplete.tradingFeeCompleteness, "INCOMPLETE");

    const recovered = instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "10", updatedAt: 8,
      accountingEvidence: evidence("order-long", "10", "100", "0.02", 8),
    });
    const complete = accounting(recovered, instances);
    assert.equal(complete.realizedSpreadProfit, "0");
    assert.equal(complete.realizedSpreadProfitCompleteness, "COMPLETE");
    assert.equal(complete.tradingFeeNetCostUsdt, "0.04");
    assert.equal(complete.tradingFeeCompleteness, "COMPLETE");
  });
});

test("historical correction synchronizes quantity, status, price, and fee into the same fact", () => {
  withFixture(({ instances, records }) => {
    prepareReference(instances, records, { intentId: "open-long", recordId: "record-long", orderId: "order-long", requested: "100" });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "open-long", status: "FAILED", confirmedQuantity: "40", updatedAt: 4,
      accountingEvidence: evidence("order-long", "40", "100", null, 4),
    });
    prepareReference(instances, records, {
      intentId: "close-long", recordId: "record-close", orderId: "order-close", requested: "40",
      phase: "CLOSING", quantityEffect: "DECREASE", at: 5,
    });
    instances.applyExecutionResult("user", "arb", {
      executionIntentId: "close-long", status: "CONFIRMED", confirmedQuantity: "40", updatedAt: 7,
      accountingEvidence: evidence("order-close", "40", "102", "0.01", 7),
    });
    assert.equal(instances.get("user", "arb")?.status, "CLOSED");
    instances.applyHistoricalExecutionCorrection("user", "arb", {
      executionIntentId: "open-long", status: "CONFIRMED", confirmedQuantity: "100", updatedAt: 8,
      accountingEvidence: evidence("order-long", "100", "101", "0.05", 8),
    });
    const fact = instances.listExecutionAccountingFacts("user", "arb")
      .find((candidate) => candidate.executionIntentId === "open-long");
    assert.equal(fact?.filledQuantity, "100");
    assert.equal(fact?.terminalExecutionStatus, "CONFIRMED");
    assert.equal(fact?.averageFillPrice, "101");
    assert.equal(fact?.tradingFeeNetCostUsdt, "0.05");
    assert.equal(instances.listExecutionAccountingFacts("user", "arb").length, 2);
  });
});

function withFixture(operation: (fixture: {
  instances: ArbitrageInstanceStore;
  records: SqliteExecutionRecordStore;
}) => void) {
  const directory = mkdtempSync(join(tmpdir(), "execution-accounting-"));
  const dbPath = join(directory, "trading.sqlite");
  const records = new SqliteExecutionRecordStore({ dbPath });
  const instances = new ArbitrageInstanceStore({ dbPath });
  try {
    instances.create({
      arbitrageId: "arb", userId: "user", strategyType: "PERPETUAL_PERPETUAL",
      maxResidualBaseQuantity: "0", createdAt: 1,
      legs: [
        { legId: "long", role: "LONG", venue: "okx", accountId: "account", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "10" },
        { legId: "short", role: "SHORT", venue: "bybit", accountId: "account-2", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "10" },
      ],
    });
    operation({ instances, records });
  } finally {
    instances.close();
    records.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function prepareReference(
  instances: ArbitrageInstanceStore,
  records: SqliteExecutionRecordStore,
  input: {
    intentId: string; recordId: string; orderId: string; requested: string;
    legId?: "long" | "short"; phase?: "OPENING" | "CLOSING"; quantityEffect?: "INCREASE" | "DECREASE";
    at?: number;
  },
) {
  const legId = input.legId ?? "long";
  const phase = input.phase ?? "OPENING";
  const quantityEffect = input.quantityEffect ?? (phase === "OPENING" ? "INCREASE" : "DECREASE");
  const at = input.at ?? 2;
  instances.claimExecutionReference("user", "arb", {
    legId, phase, quantityEffect, executionIntentId: input.intentId,
    requestedQuantity: input.requested, createdAt: at,
  });
  records.create(createExecutionRecord({
    executionId: input.recordId, intentId: input.intentId, executionAttemptId: input.intentId,
    userId: "user", venue: legId === "long" ? "okx" : "bybit",
    accountId: legId === "long" ? "account" : "account-2", instrumentId: "DOGE-USDT-PERP",
    status: "CONFIRMED", remoteOrderId: input.orderId, createdAt: at, updatedAt: at + 1,
  }));
  instances.linkExecutionRecord("user", "arb", input.intentId, input.recordId, at + 1);
}

function evidence(orderId: string, quantity: string, price: string | null, fee: string | null, confirmedAt: number) {
  return {
    providerOrderId: orderId, filledQuantity: quantity, averageFillPrice: price,
    feeAmountProvider: fee, feeAsset: fee === null ? null : "USDT", tradingFeeNetCostUsdt: fee,
    confirmedAt, completeness: price !== null && fee !== null ? "COMPLETE" as const : "INCOMPLETE" as const,
  };
}

function accounting(instance: NonNullable<ReturnType<ArbitrageInstanceStore["get"]>>, store: ArbitrageInstanceStore) {
  return deriveRealizedAccounting(instance, store.listExecutionAccountingFacts("user", "arb"));
}
