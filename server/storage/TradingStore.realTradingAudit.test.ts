import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TradingStore } from "./TradingStore";

test("real-trading audit schema stores only non-replayable metadata and retains 180 days by default", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-audit-"));
  const dbPath = join(directory, "test.sqlite");
  const store = new TradingStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = Date.now();
  store.saveRealTradingAudit(record("old", now - 181 * 86_400_000));
  store.saveRealTradingAudit(record("current", now));
  store.purgeExpiredRealTradingAudit(now);
  assert.deepEqual(store.listRealTradingAudit().map((item) => item.requestId), ["current"]);

  const db = new DatabaseSync(dbPath);
  const columns = db.prepare("PRAGMA table_info(real_trading_exchange_audit)").all() as Array<{ name: string }>;
  db.close();
  const names = columns.map((column) => column.name);
  assert.equal(names.includes("signature"), false);
  assert.equal(names.includes("nonce"), false);
  assert.equal(names.includes("payload"), false);
  assert.equal(names.includes("privateKey"), false);
  assert.equal(names.includes("mnemonic"), false);
  assert.equal(names.includes("errorCategory"), true);

  const idempotencyDb = new DatabaseSync(dbPath);
  const idempotencyColumns = idempotencyDb
    .prepare("PRAGMA table_info(real_trading_order_idempotency)").all() as Array<{ name: string }>;
  idempotencyDb.close();
  const idempotencyNames = idempotencyColumns.map((column) => column.name);
  assert.equal(idempotencyNames.includes("cloid"), true);
  assert.equal(idempotencyNames.includes("reconcileAttemptCount"), true);
  assert.equal(idempotencyNames.includes("lastReconcileAttemptAt"), true);
  assert.equal(idempotencyNames.includes("lastReconcileError"), true);
  assert.equal(idempotencyNames.includes("signature"), false);
  assert.equal(idempotencyNames.includes("payload"), false);

  store.upsertRealTradingAgentBinding({
    userId: "USR-test",
    masterAddress: "0x1111111111111111111111111111111111111111",
    agentAddress: "0x2222222222222222222222222222222222222222",
    approvedAt: now,
    updatedAt: now,
  });
  assert.equal(
    store.findRealTradingAgentBinding("USR-test", "0x1111111111111111111111111111111111111111")?.agentAddress,
    "0x2222222222222222222222222222222222222222",
  );
  assert.equal(store.findRealTradingAgentBinding("USR-other", "0x1111111111111111111111111111111111111111"), undefined);

  const baseReservation = {
    requestId: "request-a",
    userId: "USR-test",
    network: "hyperliquid-testnet" as const,
    masterAddress: "0x1111111111111111111111111111111111111111",
    clientOrderIds: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    actionType: "order" as const,
    requestFingerprint: "fingerprint-a",
    submittedAt: now,
  };
  assert.equal(store.reserveRealTradingOrderRequest(baseReservation).kind, "reserved");
  store.saveRealTradingAudit(record("request-a", now + 1));
  store.completeRealTradingOrderRequest("request-a", "accepted", JSON.stringify({ requestId: "request-a", outcome: "accepted" }), now + 1);
  assert.equal(store.findRealTradingAudit("USR-test", { requestId: "request-a" })?.requestId, "request-a");
  assert.equal(
    store.findRealTradingAudit("USR-test", { cloid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })?.requestId,
    "request-a",
  );
  assert.equal(store.findRealTradingAudit("USR-other", { requestId: "request-a" }), undefined);
  const changed = store.reserveRealTradingOrderRequest({
    ...baseReservation,
    requestId: "request-b",
    requestFingerprint: "fingerprint-changed",
  });
  assert.equal(changed.kind, "existing");
  if (changed.kind === "existing") assert.equal(changed.requestId, "conflict");

  const pendingReservation = {
    ...baseReservation,
    requestId: "request-pending",
    clientOrderIds: ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    requestFingerprint: "fingerprint-pending",
    submittedAt: now + 2,
  };
  assert.equal(store.reserveRealTradingOrderRequest(pendingReservation).kind, "reserved");
  store.completeRealTradingOrderRequest("request-pending", "pending_reconciliation", JSON.stringify({ requestId: "request-pending" }), now + 3);
  store.saveRealTradingAudit({ ...record("request-pending", now + 3), outcome: "pending_reconciliation", errorCategory: "provider_transport_unknown" });
  assert.equal(store.listPendingRealTradingReconciliations()[0]?.requestId, "request-pending");
  store.recordRealTradingReconciliationAttempt("request-pending", now + 4, "ECONNRESET [path]");
  assert.equal(store.listPendingRealTradingReconciliations()[0]?.reconcileAttemptCount, 1);
  store.saveRealTradingAudit({
    ...record("request-manual", now + 4),
    actionType: "cancel",
    clientOrderIds: [],
    outcome: "pending_reconciliation",
    errorCategory: "provider_transport_unknown",
  });
  const userReconciliation = store.listUserRealTradingReconciliationRecords("USR-test");
  assert.equal(userReconciliation.find((item) => item.requestId === "request-pending")?.autoRecoverable, true);
  assert.equal(userReconciliation.find((item) => item.requestId === "request-manual")?.manualReview, true);
  store.updateRealTradingAuditReconciliation("request-pending", "accepted", {
    errorCategory: null,
    providerStatus: "reconciled_order_status",
    httpStatus: 200,
    message: "reconciled",
    completedAt: now + 5,
  });
  store.completeRealTradingOrderRequest("request-pending", "accepted", JSON.stringify({ requestId: "request-pending", outcome: "accepted" }), now + 5);
  const operations = store.getRealTradingOperationsSummary(now + 6);
  assert.equal(operations.pendingCount, 1);
  assert.equal(operations.manualReviewPendingCount, 1);
  assert.equal(operations.recentCounts.some((item) => item.outcome === "accepted"), true);
});

test("pending reconciliation listing limits by complete request instead of cloid row", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-audit-limit-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = Date.now();
  store.reserveRealTradingOrderRequest({
    requestId: "request-multi",
    userId: "USR-test",
    network: "hyperliquid-testnet",
    masterAddress: "0x1111111111111111111111111111111111111111",
    clientOrderIds: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    actionType: "order",
    requestFingerprint: "fingerprint-multi",
    submittedAt: now,
  });
  store.completeRealTradingOrderRequest("request-multi", "pending_reconciliation", JSON.stringify({ requestId: "request-multi" }), now);
  const pending = store.listPendingRealTradingReconciliations(1);
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map((item) => item.requestId), ["request-multi", "request-multi"]);
});

function record(requestId: string, completedAt: number) {
  return {
    requestId,
    userId: "USR-test",
    network: "hyperliquid-testnet" as const,
    masterAddress: "0x1111111111111111111111111111111111111111",
    actionType: "order",
    clientOrderIds: ["0x11111111111111111111111111111111"],
    outcome: "accepted" as const,
    errorCategory: null,
    providerStatus: "ok",
    httpStatus: 200,
    message: null,
    submittedAt: completedAt - 1,
    completedAt,
  };
}
