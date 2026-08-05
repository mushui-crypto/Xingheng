import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BinanceBindingStoreError, TradingStore } from "./TradingStore";

const fingerprint = (uid: string) => createHash("sha256").update(`binance:${uid}`).digest("hex");

test("Binance UID ownership is unique and permanent per user", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-binance-binding-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const first = store.bindBinanceUid("user-a", fingerprint("10001"), 100);
  assert.equal(first.bindingVersion, 1);
  assert.equal(first.status, "active");
  assert.equal(first.uidFingerprint.length, 64);
  assert.deepEqual(store.bindBinanceUid("user-a", fingerprint("10001"), 101), first);

  assert.throws(
    () => store.bindBinanceUid("user-b", fingerprint("10001"), 102),
    (error: unknown) => error instanceof BinanceBindingStoreError && error.category === "binding_uid_conflict",
  );
  assert.throws(
    () => store.bindBinanceUid("user-a", fingerprint("20002"), 103),
    (error: unknown) => error instanceof BinanceBindingStoreError && error.category === "binding_user_conflict",
  );
});

test("Binance binding rejects truncated fingerprints", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-binance-binding-fingerprint-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.throws(() => store.bindBinanceUid("user-a", fingerprint("10001").slice(0, 16)));
});

test("Recovery Unbind is idempotent, versioned, and writes an append-only receipt", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-binance-recovery-"));
  const dbPath = join(directory, "test.sqlite");
  const store = new TradingStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const uidFingerprint = fingerprint("30003");
  const operationId = "11111111-1111-4111-8111-111111111111";
  store.bindBinanceUid("user-a", uidFingerprint, 100);
  assert.deepEqual(store.reserveBinanceRecoveryOperation({ operationId, userId: "user-a", requestDigest: "request-a", now: 101 }), { kind: "reserved" });
  const result = store.completeBinanceRecoveryUnbind({
    operationId, userId: "user-a", requestDigest: "request-a", uidFingerprint, bindingVersion: 1,
    operator: "user-a", approver: "admin@example.com", reason: "provider unavailable",
    providerVerifiedFlat: false, now: 102,
  });
  assert.equal(result.status, "unverified_unbound");
  assert.equal(result.interventionStatus, "manual_intervention");
  assert.equal(result.accountCleared, false);
  assert.equal(result.bindingVersion, 2);
  assert.deepEqual(store.reserveBinanceRecoveryOperation({ operationId, userId: "user-a", requestDigest: "request-a", now: 103 }), { kind: "completed", result });
  assert.throws(
    () => store.reserveBinanceRecoveryOperation({ operationId, userId: "user-a", requestDigest: "request-b", now: 104 }),
    (error: unknown) => error instanceof BinanceBindingStoreError && error.category === "idempotency_conflict",
  );
  const receipt = store.listBinanceRecoveryReceipts("user-a")[0]!;
  assert.equal(receipt.uidFingerprint, uidFingerprint);
  assert.equal(receipt.digest.length, 64);
  assert.doesNotMatch(JSON.stringify(receipt), /api.?key|secret/i);
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  assert.throws(() => db.prepare("UPDATE binance_recovery_receipts SET reason = 'changed'").run());
  assert.throws(() => db.prepare("DELETE FROM binance_recovery_receipts").run());
});

test("a stale bindingVersion cannot unbind a re-established binding", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-binance-stale-unbind-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const uidFingerprint = fingerprint("40004");
  store.bindBinanceUid("user-a", uidFingerprint, 100);
  const firstOperation = "22222222-2222-4222-8222-222222222222";
  store.reserveBinanceRecoveryOperation({ operationId: firstOperation, userId: "user-a", requestDigest: "first" });
  store.completeBinanceRecoveryUnbind({
    operationId: firstOperation, userId: "user-a", requestDigest: "first", uidFingerprint,
    bindingVersion: 1, operator: "user-a", approver: "not_required", reason: "verified", providerVerifiedFlat: true,
  });
  assert.equal(store.bindBinanceUid("user-a", uidFingerprint).bindingVersion, 3);
  const staleOperation = "33333333-3333-4333-8333-333333333333";
  store.reserveBinanceRecoveryOperation({ operationId: staleOperation, userId: "user-a", requestDigest: "stale" });
  assert.throws(
    () => store.completeBinanceRecoveryUnbind({
      operationId: staleOperation, userId: "user-a", requestDigest: "stale", uidFingerprint,
      bindingVersion: 1, operator: "user-a", approver: "not_required", reason: "stale", providerVerifiedFlat: true,
    }),
    (error: unknown) => error instanceof BinanceBindingStoreError && error.category === "binding_version_conflict",
  );
});

test("verified unbind retains ownership and permits only the same UID to be rebound", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-binance-verified-unbind-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const uidFingerprint = fingerprint("50005");
  store.bindBinanceUid("user-a", uidFingerprint, 100);
  const unbound = store.markBinanceVerifiedUnbound("user-a", uidFingerprint, 1, 101);
  assert.equal(unbound.status, "verified_unbound");
  assert.equal(unbound.bindingVersion, 2);
  assert.throws(
    () => store.bindBinanceUid("user-a", fingerprint("different"), 102),
    (error: unknown) => error instanceof BinanceBindingStoreError && error.category === "binding_user_conflict",
  );
  const rebound = store.bindBinanceUid("user-a", uidFingerprint, 103);
  assert.equal(rebound.status, "active");
  assert.equal(rebound.bindingVersion, 3);
});
