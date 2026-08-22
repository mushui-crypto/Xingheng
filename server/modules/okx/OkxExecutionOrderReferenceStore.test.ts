import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import { SqliteExecutionOrderReferenceStore } from "../cex/ExecutionOrderReferenceStore";
import { SqliteExecutionRecordStore } from "../cex/ExecutionRecordStore";
import {
  InMemoryOkxExecutionOrderReferenceStore,
  PersistentOkxExecutionOrderReferenceStore,
  createOkxExecutionOrderRecoveryReference,
  type OkxExecutionOrderReference,
  type OkxExecutionOrderRecoveryReference,
} from "./OkxExecutionOrderReferenceStore";

const now = 1_800_000_000_000;

test("persists and restores the complete OKX order reference after service restart", async () => {
  await withDatabase(async ({ dbPath }) => {
    const records = new SqliteExecutionRecordStore({ dbPath });
    records.create(executionRecord());
    records.close();

    const firstPersistence = new SqliteExecutionOrderReferenceStore({ dbPath });
    const first = new PersistentOkxExecutionOrderReferenceStore(firstPersistence);
    await first.create(orderReference());
    assert.deepEqual(await first.loadForUser("user-a", "execution-okx-1"), orderReference());
    firstPersistence.close();

    const restartedPersistence = new SqliteExecutionOrderReferenceStore({ dbPath });
    try {
      const restarted = new PersistentOkxExecutionOrderReferenceStore(restartedPersistence);
      assert.deepEqual(
        await restarted.loadForUser("user-a", "execution-okx-1"),
        orderReference(),
      );
      assert.equal(await restarted.loadForUser("user-b", "execution-okx-1"), null);
    } finally {
      restartedPersistence.close();
    }
  });
});

test("OKX provider fields remain outside the common order-reference source", () => {
  const commonSource = readFileSync(
    new URL("../cex/ExecutionOrderReferenceStore.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(commonSource, /\bordId\b|\bclOrdId\b|\binstId\b|\bsz\b/u);
});

test("accepts an OKX Spot order reference without changing common persistence fields", () => {
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  const spot = orderReference({
    instrumentId: "DOGE-USDT-SPOT",
    instId: "DOGE-USDT",
    expectedProviderQuantity: "100",
    expectedSide: "buy",
  });
  references.create(spot);
  assert.deepEqual(references.loadForUser("user-a", "execution-okx-1"), spot);
});

test("persists a clOrdId recovery anchor across restart and upgrades it atomically", async () => {
  await withDatabase(async ({ dbPath }) => {
    const records = new SqliteExecutionRecordStore({ dbPath });
    records.create(executionRecord());
    records.close();

    const firstPersistence = new SqliteExecutionOrderReferenceStore({ dbPath });
    const first = new PersistentOkxExecutionOrderReferenceStore(firstPersistence);
    await first.createRecovery(recoveryReference());
    firstPersistence.close();

    const recoveryPersistence = new SqliteExecutionOrderReferenceStore({ dbPath });
    const recovering = new PersistentOkxExecutionOrderReferenceStore(recoveryPersistence);
    assert.equal(await recovering.loadForUser("user-a", "execution-okx-1"), null);
    assert.deepEqual(
      await recovering.loadRecoveryForUser("user-a", "execution-okx-1"),
      recoveryReference(),
    );
    await recovering.create(orderReference({ updatedAt: now + 1 }));
    recoveryPersistence.close();

    const completedPersistence = new SqliteExecutionOrderReferenceStore({ dbPath });
    try {
      const completed = new PersistentOkxExecutionOrderReferenceStore(completedPersistence);
      assert.deepEqual(
        await completed.loadForUser("user-a", "execution-okx-1"),
        orderReference({ updatedAt: now + 1 }),
      );
      assert.equal(await completed.loadRecoveryForUser("user-a", "execution-okx-1"), null);
    } finally {
      completedPersistence.close();
    }
  });
});

test("persists the Spot recovery anchor through process restart", async () => {
  await withDatabase(async ({ dbPath }) => {
    const records = new SqliteExecutionRecordStore({ dbPath });
    records.create(executionRecord({ instrumentId: "DOGE-USDT-SPOT" }));
    records.close();

    const recoveryPersistence = new SqliteExecutionOrderReferenceStore({ dbPath });
    const recoveryStore = new PersistentOkxExecutionOrderReferenceStore(recoveryPersistence);
    const recovery = recoveryReference({
      instrumentId: "DOGE-USDT-SPOT",
      instId: "DOGE-USDT",
      expectedProviderQuantity: "100",
      expectedSide: "buy",
    });
    await recoveryStore.createRecovery(recovery);
    recoveryPersistence.close();

    const upgradePersistence = new SqliteExecutionOrderReferenceStore({ dbPath });
    const upgradeStore = new PersistentOkxExecutionOrderReferenceStore(upgradePersistence);
    assert.deepEqual(await upgradeStore.loadRecoveryForUser("user-a", "execution-okx-1"), recovery);
    const complete = orderReference({
      instrumentId: "DOGE-USDT-SPOT",
      instId: "DOGE-USDT",
      expectedProviderQuantity: "100",
      expectedSide: "buy",
      updatedAt: now + 1,
    });
    await upgradeStore.create(complete);
    upgradePersistence.close();

    const restartedPersistence = new SqliteExecutionOrderReferenceStore({ dbPath });
    try {
      const restarted = new PersistentOkxExecutionOrderReferenceStore(restartedPersistence);
      assert.deepEqual(await restarted.loadForUser("user-a", "execution-okx-1"), complete);
      assert.equal(await restarted.loadRecoveryForUser("user-a", "execution-okx-1"), null);
    } finally {
      restartedPersistence.close();
    }
  });
});

test("refuses to upgrade a recovery anchor with mismatched OKX identity", () => {
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  references.createRecovery(recoveryReference());

  assert.throws(
    () => references.create(orderReference({ clOrdId: "sxokxwrong00000000000000000001" })),
    /does not match/u,
  );
  assert.deepEqual(
    references.loadRecoveryForUser("user-a", "execution-okx-1"),
    recoveryReference(),
  );
});

test("OKX HEDGE recovery persists posSide and direction", () => {
  const store = new InMemoryOkxExecutionOrderReferenceStore();
  const recovery = recoveryReference({ expectedProviderQuantity: "10", expectedSide: "buy", positionMode: "HEDGE", positionDirection: "LONG", posSide: "long" });
  store.createRecovery(recovery);
  const loaded = store.loadRecoveryForUser("user-a", recovery.executionId);
  assert.equal(loaded?.positionMode, "HEDGE");
  assert.equal(loaded?.posSide, "long");
  assert.throws(() => createOkxExecutionOrderRecoveryReference({ ...recovery, posSide: "short" }), /bucket/u);
});

function executionRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return Object.freeze({
    executionId: "execution-okx-1",
    intentId: "intent-okx-1",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    status: "PENDING_CONFIRMATION",
    remoteOrderId: "8001",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function orderReference(overrides: Partial<OkxExecutionOrderReference> = {}): OkxExecutionOrderReference {
  return Object.freeze({
    executionId: "execution-okx-1",
    intentId: "intent-okx-1",
    userId: "user-a",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    instId: "DOGE-USDT-SWAP",
    ordId: "8001",
    clOrdId: "sxokxrestart000000000000000001",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function recoveryReference(overrides: Partial<OkxExecutionOrderReference> = {}): OkxExecutionOrderRecoveryReference {
  const { ordId: _ordId, ...recovery } = orderReference(overrides);
  return recovery;
}

async function withDatabase(operation: (fixture: { dbPath: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "okx-order-reference-store-"));
  try {
    await operation({ dbPath: join(root, "trading.sqlite") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
