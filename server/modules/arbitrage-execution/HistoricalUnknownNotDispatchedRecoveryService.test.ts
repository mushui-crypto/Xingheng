import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { createExecutionOrderReferenceAssociation, SqliteExecutionOrderReferenceStore } from "../cex/ExecutionOrderReferenceStore";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { SqliteExecutionRecordStore } from "../cex/ExecutionRecordStore";
import type { HistoricalExecutionEvidence } from "./HistoricalExecutionEvidence";
import {
  HistoricalUnknownNotDispatchedRecoveryService,
  HistoricalUnknownRecoveryError,
} from "./HistoricalUnknownNotDispatchedRecoveryService";

const now = 1_800_000_000_000;

test("complete proof terminalizes an historical UNKNOWN without a synthetic second reference", async (t) => {
  const fixture = setup(t);
  const result = await fixture.service.recover("user-a", request());

  assert.equal(result.instance.status, "FAILED");
  assert.equal(result.instance.executionReferences.length, 1);
  assert.equal(result.instance.executionReferences[0]?.status, "FAILED");
  assert.equal(result.instance.executionReferences[0]?.confirmedQuantity, "0");
  assert.equal(fixture.records.loadForUser("user-a", "record-1")?.status, "FAILED");
  assert.equal(fixture.providerMutations, 0);
});

test("recovery resumes after the record was persisted FAILED before instance attribution", async (t) => {
  const fixture = setup(t);
  const record = fixture.records.loadForUser("user-a", "record-1");
  assert.ok(record);
  fixture.records.update({ ...record, status: "FAILED", updatedAt: now + 3 });

  const result = await fixture.service.recover("user-a", request());

  assert.equal(result.instance.status, "FAILED");
  assert.equal(result.instance.executionReferences[0]?.status, "FAILED");
  assert.equal(result.instance.executionReferences[0]?.confirmedQuantity, "0");
  assert.equal(fixture.providerMutations, 0);
});

test("executionAttemptId rejects historical UNKNOWN recovery", async (t) => {
  const fixture = setup(t, { executionAttemptId: "attempt-1" });
  await rejected(fixture);
});

test("remoteOrderId or recovery anchor rejects historical UNKNOWN recovery", async (t) => {
  await t.test("remote order", async (child) => {
    const fixture = setup(child, { executionAttemptId: "attempt-1", remoteOrderId: "order-1" });
    await rejected(fixture);
  });
  await t.test("recovery anchor", async (child) => {
    const fixture = setup(child);
    fixture.orderReferences.create(createExecutionOrderReferenceAssociation({
      executionId: "record-1", userId: "user-a", venue: "bybit",
      referencePayload: JSON.stringify({ kind: "recovery" }), createdAt: now + 1, updatedAt: now + 1,
    }));
    await rejected(fixture);
  });
});

test("managed exposure rejects historical UNKNOWN recovery", async (t) => {
  const fixture = setup(t, { confirmedQuantity: "0.1" });
  await rejected(fixture);
});

test("uncertain or conflicting Provider facts preserve UNKNOWN", async (t) => {
  await t.test("exact order evidence is unknown", async (child) => {
    const fixture = setup(child, { evidence: evidence({ exactOrderEvidence: "UNKNOWN" }) });
    await rejected(fixture);
  });
  await t.test("exact order is present", async (child) => {
    const fixture = setup(child, { evidence: evidence({ exactOrderEvidence: "PRESENT" }) });
    await rejected(fixture);
  });
  await t.test("an active order is present", async (child) => {
    const fixture = setup(child, { evidence: evidence({ activeOrderEvidence: "PRESENT" }) });
    await rejected(fixture);
  });
});

test("a second-leg execution reference rejects historical UNKNOWN recovery", async (t) => {
  const fixture = setup(t);
  fixture.instances.claimExecutionReference("user-a", "arbitrage-1", {
    legId: "perp-leg", phase: "OPENING", quantityEffect: "INCREASE",
    executionIntentId: "intent-2", requestedQuantity: "94", createdAt: now + 3,
  });
  await rejected(fixture);
});

test("authenticated ownership and unsupported client identity fail closed", async (t) => {
  const fixture = setup(t);
  await assert.rejects(() => fixture.service.recover("user-b", request()), (error) => (
    error instanceof HistoricalUnknownRecoveryError
      && error.category === "historical_recovery_instance_not_found"
  ));
  assert.throws(() => fixture.service.recover("user-a", {
    ...request(), providerOrderId: "untrusted",
  }), /不能包含 Provider identity/u);
});

function setup(t: test.TestContext, options: Readonly<{
  executionAttemptId?: string;
  remoteOrderId?: string;
  confirmedQuantity?: string;
  evidence?: HistoricalExecutionEvidence;
}> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "historical-unknown-recovery-"));
  const dbPath = join(directory, "trading.sqlite");
  const instances = new ArbitrageInstanceStore({ dbPath });
  const records = new SqliteExecutionRecordStore({ dbPath });
  const orderReferences = new SqliteExecutionOrderReferenceStore({ dbPath });
  t.after(() => {
    orderReferences.close();
    records.close();
    instances.close();
    rmSync(directory, { recursive: true, force: true });
  });
  instances.create({
    arbitrageId: "arbitrage-1", userId: "user-a", strategyType: "SPOT_PERPETUAL",
    sourcePlanId: "plan-1", maxResidualBaseQuantity: "0.1", createdAt: now,
    legs: [
      { legId: "spot-leg", role: "LONG", venue: "bybit", accountId: "bybit:account-a", instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "94" },
      { legId: "perp-leg", role: "SHORT", venue: "bybit", accountId: "bybit:account-a", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "94" },
    ],
  });
  instances.claimExecutionReference("user-a", "arbitrage-1", {
    legId: "spot-leg", phase: "OPENING", quantityEffect: "INCREASE",
    executionIntentId: "intent-1", requestedQuantity: "94", createdAt: now + 1,
  });
  instances.linkExecutionRecord("user-a", "arbitrage-1", "intent-1", "record-1", now + 1);
  instances.applyExecutionResult("user-a", "arbitrage-1", {
    executionIntentId: "intent-1", status: "UNKNOWN",
    confirmedQuantity: options.confirmedQuantity ?? "0", updatedAt: now + 2,
  });
  records.create(createExecutionRecord({
    executionId: "record-1", intentId: "intent-1", userId: "user-a", venue: "bybit",
    accountId: "bybit:account-a", instrumentId: "DOGE-USDT-SPOT", status: "UNKNOWN",
    ...(options.executionAttemptId === undefined ? {} : { executionAttemptId: options.executionAttemptId }),
    ...(options.remoteOrderId === undefined ? {} : { remoteOrderId: options.remoteOrderId }),
    createdAt: now + 1, updatedAt: now + 2,
  }));
  let providerMutations = 0;
  const service = new HistoricalUnknownNotDispatchedRecoveryService(
    instances,
    records,
    orderReferences,
    {
      verify: async () => ({
        arbitrageId: "arbitrage-1", checkedAt: now + 3,
        legs: [
          verification("spot-leg"),
          verification("perp-leg"),
        ],
      }),
    } as never,
    { verify: async () => options.evidence ?? evidence() },
    () => now + 4,
  );
  return { instances, records, orderReferences, service, get providerMutations() { return providerMutations; } };
}

function verification(legId: string) {
  return {
    arbitrageId: "arbitrage-1", legId, expectedManagedQuantity: "0", actualQuantity: "0",
    actualSignedNetQuantity: "0", availableQuantity: legId === "spot-leg" ? "0.005" : null,
    verificationStatus: "MATCHED", reason: null, checkedAt: now + 3,
  } as const;
}

function evidence(overrides: Partial<HistoricalExecutionEvidence> = {}): HistoricalExecutionEvidence {
  return Object.freeze({
    recoveryAnchorRequiredBeforeMutation: true,
    exactOrderEvidence: "ABSENT",
    activeOrderEvidence: "NONE",
    checkedAt: now + 3,
    ...overrides,
  });
}

function request() {
  return { arbitrageId: "arbitrage-1", legId: "spot-leg", confirmed: true } as const;
}

async function rejected(fixture: ReturnType<typeof setup>) {
  await assert.rejects(() => fixture.service.recover("user-a", request()), (error) => (
    error instanceof HistoricalUnknownRecoveryError
      && error.category === "historical_recovery_proof_incomplete"
  ));
  assert.equal(fixture.instances.get("user-a", "arbitrage-1")?.status === "FAILED", false);
  assert.equal(fixture.records.loadForUser("user-a", "record-1")?.status, "UNKNOWN");
}
