import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CleanupTransactionStore,
  confirmationFor,
} from "./cleanupTransactionStore.mjs";

const REVISION = "a".repeat(40);
const HASH = "b".repeat(64);

test("cleanup receipt is immutable, expiring, one-time claimed and journaled", () => {
  const parent = mkdtempSync(join(tmpdir(), "xingheng-cleanup-store-"));
  try {
    const store = new CleanupTransactionStore(join(parent, "store"), { testMode: true });
    const now = new Date("2026-07-26T00:00:00.000Z");
    const receipt = store.createPrepared({
      revision: REVISION,
      daemon: { digest: HASH },
      targets: ["one", "two", "three"],
      before: { digest: HASH },
      backups: { digest: HASH },
      now,
    });
    assert.equal(store.readJournal(receipt.operationId).phase, "prepared");
    const claimed = store.claim(receipt.operationId, confirmationFor(receipt), now);
    assert.equal(claimed.phase, "claimed");
    assert.equal(
      store.claim(receipt.operationId, confirmationFor(receipt), now).phase,
      "claimed",
    );
    assert.throws(
      () => store.claim(receipt.operationId, "wrong", now),
      /does not bind/u,
    );
    const receiptPath = join(
      parent,
      "store",
      `operation-${receipt.operationId}`,
      "receipt.json",
    );
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).receiptSha256, receipt.receiptSha256);
    assert.equal(statSync(receiptPath).mode & 0o777, 0o400);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("cleanup store rejects expired receipts and mutable transaction paths", () => {
  const parent = mkdtempSync(join(tmpdir(), "xingheng-cleanup-expiry-"));
  try {
    const root = join(parent, "store");
    const store = new CleanupTransactionStore(root, { testMode: true });
    const now = new Date("2026-07-26T00:00:00.000Z");
    const receipt = store.createPrepared({
      revision: REVISION,
      daemon: { digest: HASH },
      targets: ["one", "two", "three"],
      before: { digest: HASH },
      backups: { digest: HASH },
      now,
      ttlMs: 1,
    });
    assert.throws(
      () => store.claim(
        receipt.operationId,
        confirmationFor(receipt),
        new Date(now.getTime() + 2),
      ),
      /expired/u,
    );
    chmodSync(root, 0o755);
    assert.throws(
      () => new CleanupTransactionStore(root, { testMode: true }),
      /directory boundary/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("SIGKILL after immutable claim publication resumes the same frozen operation", () => {
  const parent = mkdtempSync(join(tmpdir(), "xingheng-cleanup-claim-crash-"));
  try {
    const root = join(parent, "store");
    const store = new CleanupTransactionStore(root, { testMode: true });
    const now = new Date("2026-07-26T00:00:00.000Z");
    const receipt = createReceipt(store, now);
    const killed = runClaimPublisherUntilKilled(
      root,
      receipt.operationId,
      confirmationFor(receipt),
      now,
    );
    assert.equal(killed.signal, "SIGKILL");
    assert.equal(store.readJournal(receipt.operationId).phase, "prepared");
    const claimPath = join(root, `operation-${receipt.operationId}`, "claim.json");
    const firstClaim = readFileSync(claimPath);
    const resumed = new CleanupTransactionStore(root, { testMode: true }).claim(
      receipt.operationId,
      confirmationFor(receipt),
      new Date(now.getTime() + 30 * 60 * 1000),
    );
    assert.equal(resumed.phase, "claimed");
    assert.deepEqual(readFileSync(claimPath), firstClaim);

    const driftRoot = join(parent, "drift-store");
    const driftStore = new CleanupTransactionStore(driftRoot, { testMode: true });
    const driftReceipt = createReceipt(driftStore, now);
    assert.equal(
      runClaimPublisherUntilKilled(
        driftRoot,
        driftReceipt.operationId,
        confirmationFor(driftReceipt),
        now,
      ).signal,
      "SIGKILL",
    );
    const driftPath = join(
      driftRoot,
      `operation-${driftReceipt.operationId}`,
      "claim.json",
    );
    const driftClaim = JSON.parse(readFileSync(driftPath, "utf8"));
    chmodSync(driftPath, 0o600);
    writeFileSync(driftPath, `${JSON.stringify({ ...driftClaim, revision: "c".repeat(40) })}\n`);
    chmodSync(driftPath, 0o400);
    assert.throws(
      () => driftStore.claim(
        driftReceipt.operationId,
        confirmationFor(driftReceipt),
        now,
      ),
      /claim identity mismatch/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("SIGKILL after immutable audit publication preserves bytes and rejects evidence drift", () => {
  const parent = mkdtempSync(join(tmpdir(), "xingheng-cleanup-audit-crash-"));
  try {
    for (const scenario of [
      { outcome: "completed", phase: "audit_pending", recovery: false },
      { outcome: "restored", phase: "restoring", recovery: false },
      { outcome: "incident_restore_failed", phase: "restoring", recovery: false },
      { outcome: "restored", phase: "restoring", recovery: true },
    ]) {
      const root = join(parent, `${scenario.outcome}-${scenario.recovery}`);
      const store = new CleanupTransactionStore(root, { testMode: true });
      const now = new Date("2026-07-26T00:00:00.000Z");
      const receipt = createReceipt(store, now);
      const claimed = store.claim(receipt.operationId, confirmationFor(receipt), now);
      const sourceJournal = store.writeJournal(receipt.operationId, {
        ...claimed,
        phase: scenario.phase,
        sequence: claimed.sequence + 1,
        updatedAt: new Date(now.getTime() + 1_000).toISOString(),
      });
      const audit = createAudit(receipt, sourceJournal, scenario.outcome);
      const killed = runAuditPublisherUntilKilled(root, receipt.operationId, audit, scenario.recovery);
      assert.equal(killed.signal, "SIGKILL", JSON.stringify(scenario));
      const auditName = scenario.recovery ? "recovery-audit.json" : "audit.json";
      const auditPath = join(root, `operation-${receipt.operationId}`, auditName);
      const firstBytes = readFileSync(auditPath);
      const retryAudit = {
        ...audit,
        occurredAt: new Date(now.getTime() + 60_000).toISOString(),
      };
      const published = scenario.recovery
        ? store.publishRecoveryAudit(receipt.operationId, retryAudit)
        : store.publishAudit(receipt.operationId, retryAudit);
      assert.equal(published.audit.occurredAt, audit.occurredAt);
      assert.deepEqual(readFileSync(auditPath), firstBytes);
      const publishDrift = scenario.recovery
        ? store.publishRecoveryAudit.bind(store)
        : store.publishAudit.bind(store);
      assert.throws(
        () => publishDrift(receipt.operationId, {
          ...retryAudit,
          after: { digest: "c".repeat(64) },
        }),
        /audit identity mismatch/u,
      );
      const terminalPhase = scenario.outcome === "incident_restore_failed"
        ? "incident_restore_failed"
        : scenario.outcome;
      store.writeJournal(receipt.operationId, {
        ...sourceJournal,
        phase: terminalPhase,
        sequence: sourceJournal.sequence + 1,
        updatedAt: new Date(now.getTime() + 120_000).toISOString(),
        failure: scenario.outcome === "incident_restore_failed"
          ? "fixture restore failed"
          : null,
      });
      assert.equal(store.readJournal(receipt.operationId).phase, terminalPhase);
      const replayed = scenario.recovery
        ? store.publishRecoveryAudit(receipt.operationId, retryAudit)
        : store.publishAudit(receipt.operationId, retryAudit);
      assert.equal(replayed.auditSha256, published.auditSha256);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

function createReceipt(store, now) {
  return store.createPrepared({
    revision: REVISION,
    daemon: { digest: HASH },
    targets: ["one", "two", "three"],
    before: { digest: HASH },
    backups: { digest: HASH },
    now,
  });
}

function createAudit(receipt, sourceJournal, outcome) {
  return {
    schemaVersion: 1,
    operation: "xingheng-real-test-data-reset",
    operationId: receipt.operationId,
    receiptSha256: receipt.receiptSha256,
    occurredAt: sourceJournal.updatedAt,
    project: "xingheng-real-test",
    revision: receipt.revision,
    targets: receipt.targets,
    backups: receipt.backups,
    before: receipt.before,
    sourceJournal,
    outcome,
    after: outcome === "incident_restore_failed" ? null : { digest: HASH },
    productionUnchanged: outcome !== "incident_restore_failed",
    failureCategory: outcome === "completed"
      ? null
      : outcome === "restored"
        ? "cleanup_interrupted_or_failed"
        : "fixture restore failed",
  };
}

function runClaimPublisherUntilKilled(root, operationId, confirmation, now) {
  return runStoreChild(`
    const store = new CleanupTransactionStore(root, { testMode: true });
    store.writeJournal = () => process.kill(process.pid, "SIGKILL");
    store.claim(operationId, confirmation, new Date(payload));
  `, root, operationId, confirmation, now.toISOString());
}

function runAuditPublisherUntilKilled(root, operationId, audit, recovery) {
  return runStoreChild(`
    const store = new CleanupTransactionStore(root, { testMode: true });
    const audit = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    if (${recovery ? "true" : "false"}) store.publishRecoveryAudit(operationId, audit);
    else store.publishAudit(operationId, audit);
    process.kill(process.pid, "SIGKILL");
  `, root, operationId, "", Buffer.from(JSON.stringify(audit)).toString("base64"));
}

function runStoreChild(body, root, operationId, confirmation, payload) {
  const moduleUrl = new URL("./cleanupTransactionStore.mjs", import.meta.url).href;
  return spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import { CleanupTransactionStore } from ${JSON.stringify(moduleUrl)};
      const [root, operationId, confirmation, payload] = process.argv.slice(-4);
      ${body}
    `,
    root,
    operationId,
    confirmation,
    payload,
  ], {
    encoding: "utf8",
    timeout: 10_000,
  });
}
