import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import { SqliteExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { activeManagedQuantity } from "../cex/arbitrage-instance/ArbitrageInstance";
import { ArbitrageRecoveryAuditStore } from "./ArbitrageRecoveryAuditStore";
import { ArbitrageRecoveryAnomalyDetector } from "./ArbitrageRecoveryAnomalyDetector";
import {
  ArbitrageRecoveryOperatorError,
  ArbitrageRecoveryOperatorService,
} from "./ArbitrageRecoveryOperatorService";

test("legacy partial-CONFIRMED repairs to authoritative full CONFIRMED with atomic audit", async (t) => {
  const fixture = legacyFixture(t, { status: "CONFIRMED", confirmedQuantity: "100" });
  const result = await fixture.service.repairLegacyPartialConfirmed("user-a", repairRequest("repair-full"));
  assert.equal(result.reference.status, "CONFIRMED");
  assert.equal(result.reference.confirmedQuantity, "100");
  assert.equal(result.instance.status, "FAILED");
  assert.equal(result.providerMutationCount, 0);
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "100");
  assert.deepEqual(fixture.audits.listForUser("user-a").map(({ action, oldStatus, oldQuantity, newStatus, newQuantity }) => ({
    action, oldStatus, oldQuantity, newStatus, newQuantity,
  })), [{
    action: "LEGACY_HISTORICAL_REPAIR",
    oldStatus: "CONFIRMED",
    oldQuantity: "40",
    newStatus: "CONFIRMED",
    newQuantity: "100",
  }]);
  assert.equal(fixture.runtimeCalls.count, 1);
});

test("legacy partial-CONFIRMED repairs to authoritative FAILED partial without reopening lifecycle", async (t) => {
  const fixture = legacyFixture(t, { status: "FAILED", confirmedQuantity: "70" });
  const result = await fixture.service.repairLegacyPartialConfirmed("user-a", repairRequest("repair-partial"));
  assert.equal(result.reference.status, "FAILED");
  assert.equal(result.reference.confirmedQuantity, "70");
  assert.equal(result.instance.status, "FAILED");
  assert.equal(result.instance.closedAt, null);
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "70");
});

test("legacy recovery without authoritative terminal evidence changes nothing", async (t) => {
  const fixture = legacyFixture(t, { status: "UNKNOWN", confirmedQuantity: null });
  await assert.rejects(
    fixture.service.repairLegacyPartialConfirmed("user-a", repairRequest("repair-unknown")),
    (error: unknown) => error instanceof ArbitrageRecoveryOperatorError
      && error.category === "manual_review_required",
  );
  const persisted = fixture.instances.get("user-a", "arbitrage-1")!;
  assert.equal(persisted.executionReferences[0]!.status, "CONFIRMED");
  assert.equal(persisted.executionReferences[0]!.confirmedQuantity, "40");
  assert.deepEqual(fixture.audits.listForUser("user-a"), []);
});

test("normal historical transition still rejects CONFIRMED to FAILED", (t) => {
  const fixture = legacyFixture(t, { status: "FAILED", confirmedQuantity: "40" });
  assert.throws(() => fixture.instances.applyHistoricalExecutionCorrection("user-a", "arbitrage-1", {
    executionIntentId: "intent-spot",
    status: "FAILED",
    confirmedQuantity: "40",
    updatedAt: 200,
  }), /Terminal execution status cannot be changed/u);
});

test("existing terminal historical reconcile records audit only when facts change", (t) => {
  const fixture = baseFixture(t);
  seedConfirmedOpening(fixture, true);
  fixture.raw.prepare("UPDATE arbitrage_instances SET status = 'FAILED', updatedAt = 100").run();
  fixture.raw.prepare("UPDATE arbitrage_execution_references SET status = 'FAILED', confirmedQuantity = '40', updatedAt = 100").run();
  fixture.raw.prepare("UPDATE arbitrage_instance_legs SET confirmedOpenedQuantity = '40' WHERE legId = 'long-leg'").run();
  fixture.instances.applyHistoricalExecutionCorrection("user-a", "arbitrage-1", {
    executionIntentId: "intent-spot",
    status: "CONFIRMED",
    confirmedQuantity: "100",
    updatedAt: 150,
  }, {
    recoveryId: "historical-reconcile-1",
    actorId: "user-a",
    checkedAt: 150,
  });
  const audit = fixture.audits.listForUser("user-a")[0]!;
  assert.equal(audit.action, "HISTORICAL_RECONCILE");
  assert.equal(audit.oldStatus, "FAILED");
  assert.equal(audit.oldQuantity, "40");
  assert.equal(audit.newStatus, "CONFIRMED");
  assert.equal(audit.newQuantity, "100");
});

test("legacy repair never crosses an existing Management Release responsibility cutoff", async (t) => {
  const fixture = legacyFixture(t, { status: "CONFIRMED", confirmedQuantity: "100" });
  fixture.raw.prepare(`INSERT INTO arbitrage_leg_management_releases (
    releaseId, arbitrageId, legId, releasedQuantity, reason, source, requestedByUserId,
    requestedAt, confirmedAt, venue, accountId, instrumentId, positionMode,
    actualQuantity, actualSignedNetQuantity, actualLongQuantity, actualShortQuantity,
    availableQuantity, realityCheckedAt
  ) VALUES ('release-1', 'arbitrage-1', 'long-leg', '40',
    'USER_CONFIRMED_STOP_MANAGEMENT', 'AUTHENTICATED_API', 'user-a', 101, 102,
    'okx', 'account-a', 'BTC-USDT-SPOT', 'ONE_WAY', '0', '0', '0', '0', '0', 101)`).run();
  const result = await fixture.service.repairLegacyPartialConfirmed("user-a", repairRequest("repair-released"));
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "100");
  assert.equal(activeManagedQuantity(result.instance, result.instance.legs[0]), "0");
  assert.equal(result.instance.status, "FAILED");
});

test("Spot missing attribution backfills authoritative fills once and writes audit", async (t) => {
  const fixture = spotFixture(t);
  const result = await fixture.service.backfillSpotAttribution("user-a", repairRequest("spot-backfill"));
  assert.equal(result.evidence.attributableBaseQuantity, "99.8");
  assert.equal(result.providerMutationCount, 0);
  assert.equal(fixture.spotCalls.count, 1);
  assert.equal(fixture.instances.get("user-a", "arbitrage-1")!.status, "FAILED");
  assert.equal(fixture.instances.get("user-a", "arbitrage-1")!.legs[0].confirmedOpenedQuantity, "100");
  assert.equal(fixture.audits.listForUser("user-a")[0]!.action, "SPOT_ATTRIBUTION_BACKFILL");
});

test("existing Spot evidence is never overwritten and explicit confirmation is mandatory", async (t) => {
  const fixture = spotFixture(t);
  await fixture.service.backfillSpotAttribution("user-a", repairRequest("spot-first"));
  await assert.rejects(
    fixture.service.backfillSpotAttribution("user-a", repairRequest("spot-second")),
    (error: unknown) => error instanceof ArbitrageRecoveryOperatorError
      && error.category === "recovery_conflict",
  );
  assert.equal(fixture.instances.readSpotOpeningAttributionEvidence("user-a", "arbitrage-1", "long-leg")[0]!
    .attributableBaseQuantity, "99.8");
  await assert.rejects(
    fixture.service.backfillSpotAttribution("user-a", { ...repairRequest("missing-confirm"), confirmed: false }),
    (error: unknown) => error instanceof ArbitrageRecoveryOperatorError
      && error.category === "invalid_recovery_request",
  );
});

test("summary and anomaly reads are owner-scoped and contain no raw Provider payload", (t) => {
  const fixture = legacyFixture(t, { status: "UNKNOWN", confirmedQuantity: null });
  const summary = fixture.service.readSummary("user-a");
  assert.equal(summary.anomaly.anomalies.some(({ arbitrageId }) => arbitrageId === "arbitrage-1"), true);
  assert.equal(summary.recoverableCount >= 0, true);
  assert.doesNotMatch(JSON.stringify(summary), /rawProviderPayload|apiSecret|credential/u);
  assert.deepEqual(fixture.service.readAnomalies("user-b"), []);
  assert.equal(fixture.service.readAnomalies("user-a", {
    classification: "MANUAL_REVIEW_REQUIRED",
    executionIntentId: "intent-spot",
  }).length, 1);
});

test("LOCAL_PRE_DISPATCH FAILED0 persists audit in the same store transaction", (t) => {
  const fixture = baseFixture(t);
  fixture.instances.claimExecutionReference("user-a", "arbitrage-1", {
    legId: "long-leg",
    phase: "OPENING",
    quantityEffect: "INCREASE",
    executionIntentId: "intent-claimed",
    requestedQuantity: "100",
    createdAt: 10,
  });
  const result = fixture.instances.terminalizeClaimedReferenceWithLocalNotDispatchedProof(
    "user-a",
    "arbitrage-1",
    "intent-claimed",
    20,
  );
  assert.equal(result.executionReferences[0]!.status, "FAILED");
  const audit = fixture.audits.listForUser("user-a")[0]!;
  assert.equal(audit.source, "SYSTEM_RECOVERY");
  assert.equal(audit.action, "LOCAL_NOT_DISPATCHED_TERMINALIZATION");
  assert.equal(audit.newQuantity, "0");
});

function legacyFixture(
  t: test.TestContext,
  provider: Readonly<{ status: ExecutionRecord["status"]; confirmedQuantity: string | null }>,
) {
  const fixture = baseFixture(t);
  seedConfirmedOpening(fixture, true);
  fixture.raw.prepare("UPDATE arbitrage_instances SET status = 'FAILED', updatedAt = 100").run();
  fixture.raw.prepare(`UPDATE arbitrage_execution_references
    SET confirmedQuantity = '40', updatedAt = 100`).run();
  fixture.raw.prepare(`UPDATE arbitrage_instance_legs
    SET confirmedOpenedQuantity = '40' WHERE legId = 'long-leg'`).run();
  const runtimeCalls = { count: 0 };
  const observed = executionRecord(provider.status, 150);
  const service = operatorService(fixture, {
    runtime: async () => {
      runtimeCalls.count += 1;
      return { executionRecord: observed, confirmedQuantity: provider.confirmedQuantity };
    },
  });
  return { ...fixture, service, runtimeCalls };
}

function spotFixture(t: test.TestContext) {
  const fixture = baseFixture(t);
  seedConfirmedOpening(fixture, true);
  fixture.raw.prepare("UPDATE arbitrage_instances SET status = 'FAILED', updatedAt = 100").run();
  const spotCalls = { count: 0 };
  const service = operatorService(fixture, {
    spot: async () => {
      spotCalls.count += 1;
      return "99.8";
    },
  });
  return { ...fixture, service, spotCalls };
}

function baseFixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-r44-"));
  const dbPath = join(directory, "trading.sqlite");
  const records = new SqliteExecutionRecordStore({ dbPath });
  const instances = new ArbitrageInstanceStore({ dbPath });
  const audits = new ArbitrageRecoveryAuditStore({ dbPath });
  const detector = new ArbitrageRecoveryAnomalyDetector({ dbPath });
  const raw = new DatabaseSync(dbPath);
  instances.create({
    arbitrageId: "arbitrage-1",
    userId: "user-a",
    strategyType: "SPOT_PERPETUAL",
    maxResidualBaseQuantity: "0.1",
    createdAt: 1,
    legs: [
      { legId: "long-leg", role: "LONG", venue: "okx", accountId: "account-a", instrumentId: "BTC-USDT-SPOT", plannedQuantity: "100" },
      { legId: "short-leg", role: "SHORT", venue: "okx", accountId: "account-a", instrumentId: "BTC-USDT-PERP", plannedQuantity: "100" },
    ],
  });
  t.after(() => {
    raw.close();
    audits.close();
    instances.close();
    records.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { dbPath, records, instances, audits, detector, raw };
}

function seedConfirmedOpening(fixture: ReturnType<typeof baseFixture>, withRemoteOrder: boolean) {
  fixture.instances.claimExecutionReference("user-a", "arbitrage-1", {
    legId: "long-leg",
    phase: "OPENING",
    quantityEffect: "INCREASE",
    executionIntentId: "intent-spot",
    requestedQuantity: "100",
    createdAt: 2,
  });
  fixture.records.create(executionRecord("CONFIRMED", 3, withRemoteOrder));
  fixture.instances.linkExecutionRecord("user-a", "arbitrage-1", "intent-spot", "execution-spot", 3);
  fixture.instances.applyExecutionResult("user-a", "arbitrage-1", {
    executionIntentId: "intent-spot",
    status: "CONFIRMED",
    confirmedQuantity: "100",
    updatedAt: 4,
  });
}

function operatorService(
  fixture: ReturnType<typeof baseFixture>,
  options: Readonly<{
    runtime?: () => Promise<{ executionRecord: ExecutionRecord; confirmedQuantity: string | null }>;
    spot?: () => Promise<string>;
  }> = {},
) {
  return new ArbitrageRecoveryOperatorService(
    fixture.instances,
    fixture.detector,
    { readLatestSummary: () => null },
    fixture.records,
    { resolve: () => ({
      reconcile: options.runtime ?? (async () => ({
        executionRecord: executionRecord("UNKNOWN", 200),
        confirmedQuantity: null,
      })),
    }) },
    { load: async () => ({
      instrument: {
        instrumentId: "BTC-USDT-SPOT",
        providerSymbol: "BTC-USDT",
        baseAsset: { symbol: "BTC", type: "DIGITAL_ASSET" },
        quoteAsset: "USDT",
        marketType: "spot",
        contractType: "spot",
        quantityUnit: "base",
        status: "trading",
      },
      tradingRules: { quantityStep: "0.0001", minQuantity: "0.0001", priceTick: "0.01", minNotional: "1", precision: {} },
      quote: { bid: "1", ask: "1", fetchedAt: 1 },
    }) },
    { okx: { readAttributableBaseQuantity: options.spot ?? (async () => { throw new Error("unavailable"); }) } },
    fixture.audits,
    () => 200,
  );
}

function executionRecord(status: ExecutionRecord["status"], updatedAt: number, withRemoteOrder = true) {
  return createExecutionRecord({
    executionId: "execution-spot",
    intentId: "intent-spot",
    userId: "user-a",
    venue: "okx",
    accountId: "account-a",
    instrumentId: "BTC-USDT-SPOT",
    status,
    ...(withRemoteOrder ? { remoteOrderId: "order-1" } : {}),
    createdAt: 2,
    updatedAt,
  });
}

function repairRequest(recoveryId: string) {
  return {
    recoveryId,
    arbitrageId: "arbitrage-1",
    legId: "long-leg",
    executionIntentId: "intent-spot",
    confirmed: true,
  };
}
