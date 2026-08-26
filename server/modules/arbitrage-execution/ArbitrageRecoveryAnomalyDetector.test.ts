import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BinanceOrderStore } from "../binance/BinanceOrderStore";
import { SqliteExecutionOrderReferenceStore } from "../cex/ExecutionOrderReferenceStore";
import { SqliteExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { ArbitrageRecoveryAnomalyDetector } from "./ArbitrageRecoveryAnomalyDetector";

test("production store schema supports an empty SAFE scan", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-r43-schema-"));
  const dbPath = join(directory, "trading.sqlite");
  const records = new SqliteExecutionRecordStore({ dbPath });
  const venueReferences = new SqliteExecutionOrderReferenceStore({ dbPath });
  const instances = new ArbitrageInstanceStore({ dbPath });
  const binance = new BinanceOrderStore(dbPath);
  t.after(() => {
    binance.close();
    instances.close();
    venueReferences.close();
    records.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(new ArbitrageRecoveryAnomalyDetector({ dbPath }).scan().classification, "SAFE");
});

test("normal record/reference, venue reference, full quantity, and Spot evidence are SAFE", (t) => {
  const fixture = createFixture(t);
  const result = fixture.detector.scan();
  assert.equal(result.classification, "SAFE");
  assert.deepEqual(result.anomalies, []);
});

test("detects broken linkage, identity mismatch, duplicate intent records, and explicit arbitrage orphan", (t) => {
  const broken = createFixture(t);
  broken.db.prepare("UPDATE arbitrage_execution_references SET executionRecordId = 'missing-record'").run();
  assertCode(broken.detector, "BROKEN_EXECUTION_REFERENCE_LINK", "DATA_INTEGRITY_ERROR");

  const mismatch = createFixture(t);
  mismatch.db.prepare("UPDATE execution_records SET accountId = 'other-account'").run();
  assertCode(mismatch.detector, "EXECUTION_RECORD_IDENTITY_MISMATCH", "DATA_INTEGRITY_ERROR");

  const duplicate = createFixture(t);
  insertExecution(duplicate.db, { executionId: "execution-duplicate", intentId: "intent-spot" });
  assertCode(duplicate.detector, "DUPLICATE_EXECUTION_INTENT_RECORDS", "MANUAL_REVIEW_REQUIRED");

  const orphan = createFixture(t);
  insertExecution(orphan.db, { executionId: "execution-orphan", intentId: "intent-orphan" });
  orphan.db.prepare(`INSERT INTO arbitrage_command_idempotency
    (commandId, operationType, requestedByUserId, arbitrageId, legId, referenceId)
    VALUES ('command-orphan', 'EXECUTION_OPEN', 'user-a', 'arbitrage-1', 'long-leg', 'intent-orphan')`).run();
  assertCode(orphan.detector, "ORPHAN_ARBITRAGE_EXECUTION_RECORD", "MANUAL_REVIEW_REQUIRED");

  const claimed = createFixture(t);
  claimed.db.prepare("UPDATE arbitrage_execution_references SET status = 'CLAIMED', executionRecordId = NULL").run();
  assertCode(claimed.detector, "CLAIMED_EXECUTION_RECORD_LINK_MISSING", "RECOVERABLE");
});

test("does not misclassify an unmatched non-arbitrage ExecutionRecord as orphan", (t) => {
  const fixture = createFixture(t);
  insertExecution(fixture.db, { executionId: "execution-generic", intentId: "intent-generic" });
  assert.equal(codes(fixture.detector).includes("ORPHAN_ARBITRAGE_EXECUTION_RECORD"), false);
});

test("detects orphan and identity-conflicting venue order references", (t) => {
  const orphan = createFixture(t);
  orphan.db.prepare(`INSERT INTO execution_order_references
    (executionId, userId, venue, referencePayload)
    VALUES ('missing', 'user-a', 'okx', '{}')`).run();
  assertCode(orphan.detector, "ORPHAN_VENUE_ORDER_REFERENCE", "DATA_INTEGRITY_ERROR");

  const mismatch = createFixture(t);
  mismatch.db.prepare(`UPDATE execution_order_references SET referencePayload =
    '{"intentId":"other","accountId":"account-a","instrumentId":"BTC-USDT-SPOT","instId":"BTC-USDT","ordId":"order-1","clOrdId":"client-1"}'`).run();
  assertCode(mismatch.detector, "VENUE_ORDER_REFERENCE_IDENTITY_MISMATCH", "DATA_INTEGRITY_ERROR");
});

test("detects Binance execution reservation orphan without treating unrelated reservations as formal execution", (t) => {
  const fixture = createFixture(t);
  fixture.db.prepare("INSERT INTO binance_personal_orders (idempotencyKey) VALUES ('execution-intent:orphan')").run();
  fixture.db.prepare("INSERT INTO binance_personal_orders (idempotencyKey) VALUES ('manual-order')").run();
  const found = fixture.detector.scan().anomalies.filter(({ code }) => code === "ORPHAN_BINANCE_ORDER_REFERENCE");
  assert.equal(found.length, 1);
});

test("locks CONFIRMED full-quantity invariant with exact decimal comparison", (t) => {
  const full = createFixture(t);
  full.db.prepare("UPDATE arbitrage_execution_references SET requestedQuantity = '100.00', confirmedQuantity = '100'").run();
  assert.equal(codes(full.detector).includes("LEGACY_PARTIAL_CONFIRMED"), false);

  const partial = createFixture(t);
  partial.db.prepare("UPDATE arbitrage_execution_references SET confirmedQuantity = '40'").run();
  assertCode(partial.detector, "LEGACY_PARTIAL_CONFIRMED", "MANUAL_REVIEW_REQUIRED");

  const ceiling = createFixture(t);
  ceiling.db.prepare("UPDATE arbitrage_execution_references SET confirmedQuantity = '120'").run();
  assertCode(ceiling.detector, "INVALID_CONFIRMED_CEILING", "DATA_INTEGRITY_ERROR");
});

test("FAILED partial is a legal historical fact and is not reported", (t) => {
  const fixture = createFixture(t);
  insertExecution(fixture.db, {
    executionId: "execution-failed",
    intentId: "intent-failed",
    state: "FAILED",
    instrumentId: "BTC-USDT-PERP",
  });
  fixture.db.prepare(`INSERT INTO arbitrage_execution_references VALUES
    ('arbitrage-1', 'short-leg', 'CLOSING', 'DECREASE', 'intent-failed',
     'execution-failed', '100', '40', 'FAILED')`).run();
  const result = fixture.detector.scan();
  assert.equal(result.anomalies.some(({ executionIntentId }) => executionIntentId === "intent-failed"), false);
});

test("classifies terminal cross-store conflicts conservatively", (t) => {
  const recoverable = createFixture(t);
  recoverable.db.prepare("UPDATE execution_records SET state = 'UNKNOWN'").run();
  assertCode(recoverable.detector, "EXECUTION_RECORD_REFERENCE_STATUS_CONFLICT", "RECOVERABLE");

  const manual = createFixture(t);
  manual.db.prepare("UPDATE execution_records SET state = 'FAILED'").run();
  assertCode(manual.detector, "EXECUTION_RECORD_REFERENCE_STATUS_CONFLICT", "MANUAL_REVIEW_REQUIRED");
});

test("detects missing, identity-conflicting, and quantity-conflicting Spot attribution", (t) => {
  const missing = createFixture(t);
  missing.db.prepare("DELETE FROM arbitrage_spot_opening_attribution_evidence").run();
  assertCode(missing.detector, "MISSING_SPOT_ATTRIBUTION_EVIDENCE", "RECOVERABLE");

  const identity = createFixture(t);
  identity.db.prepare("UPDATE arbitrage_spot_opening_attribution_evidence SET executionRecordId = 'other-record'").run();
  assertCode(identity.detector, "SPOT_ATTRIBUTION_IDENTITY_CONFLICT", "DATA_INTEGRITY_ERROR");

  const quantity = createFixture(t);
  quantity.db.prepare("UPDATE arbitrage_spot_opening_attribution_evidence SET attributableBaseQuantity = '120'").run();
  assertCode(quantity.detector, "SPOT_ATTRIBUTION_QUANTITY_CONFLICT", "MANUAL_REVIEW_REQUIRED");

  const duplicate = createFixture(t);
  duplicate.db.prepare(`INSERT INTO arbitrage_spot_opening_attribution_evidence VALUES
    ('arbitrage-1', 'long-leg', 'intent-spot', 'execution-spot', '99.8',
     'PROVIDER_ORDER_FILLS', 3, 'okx', 'account-a', 'BTC-USDT-SPOT')`).run();
  assertCode(duplicate.detector, "DUPLICATE_SPOT_ATTRIBUTION_EVIDENCE", "MANUAL_REVIEW_REQUIRED");
});

test("partial-CONFIRMED Spot evidence remains anomalous", (t) => {
  const fixture = createFixture(t);
  fixture.db.prepare("UPDATE arbitrage_execution_references SET confirmedQuantity = '40'").run();
  const found = codes(fixture.detector);
  assert.equal(found.includes("LEGACY_PARTIAL_CONFIRMED"), true);
  assert.equal(found.includes("SPOT_ATTRIBUTION_QUANTITY_CONFLICT"), true);
});

test("Management Release ignores later historical quantity corrections but validates immutable identity", (t) => {
  const valid = createFixture(t);
  insertRelease(valid.db);
  valid.db.prepare("UPDATE arbitrage_instances SET status = 'CLOSED'").run();
  valid.db.prepare("UPDATE arbitrage_instance_legs SET confirmedOpenedQuantity = '140' WHERE legId = 'long-leg'").run();
  assert.equal(codes(valid.detector).includes("MANAGEMENT_RELEASE_IDENTITY_CONFLICT"), false);
  assert.equal(codes(valid.detector).includes("TERMINAL_INSTANCE_UNRESOLVED_EXECUTION"), false);

  const invalid = createFixture(t);
  insertRelease(invalid.db);
  invalid.db.prepare("UPDATE arbitrage_leg_management_releases SET accountId = 'other-account'").run();
  assertCode(invalid.detector, "MANAGEMENT_RELEASE_IDENTITY_CONFLICT", "DATA_INTEGRITY_ERROR");
});

test("terminal lifecycle with an unresolved execution is reported without reopening lifecycle", (t) => {
  const fixture = createFixture(t);
  fixture.db.prepare("UPDATE arbitrage_instances SET status = 'CLOSED'").run();
  fixture.db.prepare("UPDATE arbitrage_execution_references SET status = 'UNKNOWN'").run();
  fixture.db.prepare("UPDATE execution_records SET state = 'UNKNOWN'").run();
  assertCode(fixture.detector, "TERMINAL_INSTANCE_UNRESOLVED_EXECUTION", "MANUAL_REVIEW_REQUIRED");
  assert.equal(fixture.db.prepare("SELECT status FROM arbitrage_instances").get()!.status, "CLOSED");
});

test("scan is read-only, has no Provider capability, and repeated results are stable", (t) => {
  const fixture = createFixture(t);
  const before = snapshot(fixture.db);
  const first = fixture.detector.scan();
  const second = fixture.detector.scan();
  assert.deepEqual(second, first);
  assert.deepEqual(snapshot(fixture.db), before);
  assert.equal(Object.keys(fixture.detector).includes("provider"), false);
});

test("startup runs the non-blocking local detector only after normal recovery", () => {
  const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
  assert.match(source, /arbitrageStartupRecovery\.runOnce\(startupRecoveryCandidates\)\.then\(\(\) => \{/u);
  assert.match(source, /arbitrageRecoveryAnomalyDetector\.scan\(\)/u);
  assert.match(source, /local scan unavailable; server remains online/u);
});

function createFixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-r43-"));
  const dbPath = join(directory, "trading.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  db.prepare(`INSERT INTO arbitrage_instances VALUES
    ('arbitrage-1', 'user-a', 'HOLDING')`).run();
  db.prepare(`INSERT INTO arbitrage_instance_legs VALUES
    ('arbitrage-1', 'long-leg', 'LONG', 'okx', 'account-a', 'BTC-USDT-SPOT', '100', '100', '0'),
    ('arbitrage-1', 'short-leg', 'SHORT', 'okx', 'account-a', 'BTC-USDT-PERP', '100', '100', '0')`).run();
  insertExecution(db, { executionId: "execution-spot", intentId: "intent-spot" });
  db.prepare(`INSERT INTO arbitrage_execution_references VALUES
    ('arbitrage-1', 'long-leg', 'OPENING', 'INCREASE', 'intent-spot',
     'execution-spot', '100', '100', 'CONFIRMED')`).run();
  db.prepare(`INSERT INTO execution_order_references VALUES
    ('execution-spot', 'user-a', 'okx',
     '{"intentId":"intent-spot","accountId":"account-a","instrumentId":"BTC-USDT-SPOT","instId":"BTC-USDT","ordId":"order-1","clOrdId":"client-1"}')`).run();
  db.prepare(`INSERT INTO arbitrage_spot_opening_attribution_evidence VALUES
    ('arbitrage-1', 'long-leg', 'intent-spot', 'execution-spot', '99.9',
     'PROVIDER_ORDER_FILLS', 2, 'okx', 'account-a', 'BTC-USDT-SPOT')`).run();
  const detector = new ArbitrageRecoveryAnomalyDetector({ dbPath });
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, detector };
}

function insertExecution(
  db: DatabaseSync,
  input: Readonly<{ executionId: string; intentId: string; state?: string; instrumentId?: string }>,
) {
  db.prepare(`INSERT INTO execution_records
    (executionId, intentId, userId, venue, accountId, instrumentId, state, remoteOrderId)
    VALUES (?, ?, 'user-a', 'okx', 'account-a', ?, ?, 'order-1')`).run(
      input.executionId,
      input.intentId,
      input.instrumentId ?? "BTC-USDT-SPOT",
      input.state ?? "CONFIRMED",
    );
}

function insertRelease(db: DatabaseSync) {
  db.prepare(`INSERT INTO arbitrage_leg_management_releases VALUES
    ('release-1', 'arbitrage-1', 'long-leg', '100', 'USER_CONFIRMED_STOP_MANAGEMENT',
     'AUTHENTICATED_API', 'user-a', 10, 11, 'okx', 'account-a', 'BTC-USDT-SPOT',
     'ONE_WAY', '0', '0', '0', '0', '0', 10)`).run();
}

function assertCode(
  detector: ArbitrageRecoveryAnomalyDetector,
  code: string,
  classification: string,
) {
  const found = detector.scan().anomalies.find((item) => item.code === code);
  assert.ok(found, `expected anomaly ${code}`);
  assert.equal(found.classification, classification);
}

function codes(detector: ArbitrageRecoveryAnomalyDetector) {
  return detector.scan().anomalies.map(({ code }) => code);
}

function snapshot(db: DatabaseSync) {
  return JSON.stringify({
    records: db.prepare("SELECT * FROM execution_records ORDER BY executionId").all(),
    references: db.prepare("SELECT * FROM arbitrage_execution_references ORDER BY executionIntentId").all(),
    evidence: db.prepare("SELECT * FROM arbitrage_spot_opening_attribution_evidence ORDER BY executionIntentId").all(),
    releases: db.prepare("SELECT * FROM arbitrage_leg_management_releases ORDER BY releaseId").all(),
  });
}

const schema = `
  CREATE TABLE arbitrage_instances (arbitrageId TEXT, userId TEXT, status TEXT);
  CREATE TABLE arbitrage_instance_legs (
    arbitrageId TEXT, legId TEXT, role TEXT, venue TEXT, accountId TEXT, instrumentId TEXT,
    plannedQuantity TEXT, confirmedOpenedQuantity TEXT, confirmedClosedQuantity TEXT
  );
  CREATE TABLE arbitrage_execution_references (
    arbitrageId TEXT, legId TEXT, phase TEXT, quantityEffect TEXT, executionIntentId TEXT,
    executionRecordId TEXT, requestedQuantity TEXT, confirmedQuantity TEXT, status TEXT
  );
  CREATE TABLE execution_records (
    executionId TEXT, intentId TEXT, userId TEXT, venue TEXT, accountId TEXT, instrumentId TEXT,
    state TEXT, remoteOrderId TEXT
  );
  CREATE TABLE execution_order_references (
    executionId TEXT, userId TEXT, venue TEXT, referencePayload TEXT
  );
  CREATE TABLE binance_personal_orders (idempotencyKey TEXT, providerOrderId TEXT);
  CREATE TABLE arbitrage_command_idempotency (
    commandId TEXT, operationType TEXT, requestedByUserId TEXT, arbitrageId TEXT, legId TEXT, referenceId TEXT
  );
  CREATE TABLE arbitrage_spot_opening_attribution_evidence (
    arbitrageId TEXT, legId TEXT, executionIntentId TEXT, executionRecordId TEXT,
    attributableBaseQuantity TEXT, source TEXT, confirmedAt INTEGER, venue TEXT,
    accountId TEXT, instrumentId TEXT
  );
  CREATE TABLE arbitrage_leg_management_releases (
    releaseId TEXT, arbitrageId TEXT, legId TEXT, releasedQuantity TEXT, reason TEXT, source TEXT,
    requestedByUserId TEXT, requestedAt INTEGER, confirmedAt INTEGER, venue TEXT, accountId TEXT,
    instrumentId TEXT, positionMode TEXT, actualQuantity TEXT, actualSignedNetQuantity TEXT,
    actualLongQuantity TEXT, actualShortQuantity TEXT, availableQuantity TEXT, realityCheckedAt INTEGER
  );
`;
