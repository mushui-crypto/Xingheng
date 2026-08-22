import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { SqliteExecutionOrderReferenceStore } from "../cex/ExecutionOrderReferenceStore";
import { SqliteExecutionRecordStore } from "../cex/ExecutionRecordStore";
import {
  createBybitExecutionOrderReference,
  createBybitExecutionOrderRecoveryReference,
  InMemoryBybitExecutionOrderReferenceStore,
  PersistentBybitExecutionOrderReferenceStore,
} from "./BybitExecutionOrderReferenceStore";

const complete = {
  executionId: "execution-bybit-1", intentId: "intent-bybit-1", userId: "user-a", accountId: "bybit:account-a",
  instrumentId: "DOGE-USDT-PERP", category: "linear" as const, symbol: "DOGEUSDT", orderId: "101",
  orderLinkId: "sxby-reference-1", expectedProviderQuantity: "100", expectedSide: "Buy" as const,
  positionIdx: 0 as const, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
};

test("Bybit recovery reference upgrades to the exact provider order identity without a second source", async () => {
  const store = new InMemoryBybitExecutionOrderReferenceStore();
  const { orderId: _orderId, ...recoveryInput } = complete;
  const recovery = createBybitExecutionOrderRecoveryReference(recoveryInput);
  store.createRecovery(recovery);
  const loadedRecovery = await store.loadRecoveryForUser("user-a", complete.executionId);
  assert.equal(loadedRecovery?.orderLinkId, "sxby-reference-1");
  store.create(createBybitExecutionOrderReference(complete));
  assert.equal(await store.loadRecoveryForUser("user-a", complete.executionId), null);
  assert.equal((await store.loadForUser("user-a", complete.executionId))?.orderId, "101");
});

test("Bybit persistent reference payload is venue-opaque and survives SQLite restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stellax-bybit-reference-"));
  const dbPath = join(directory, "trading.sqlite");
  const records = new SqliteExecutionRecordStore({ dbPath });
  const generic = new SqliteExecutionOrderReferenceStore({ dbPath });
  try {
    records.create(createExecutionRecord({
      executionId: complete.executionId,
      intentId: complete.intentId,
      userId: complete.userId,
      venue: "bybit",
      accountId: complete.accountId,
      instrumentId: complete.instrumentId,
      status: "CREATED",
      remoteOrderId: undefined,
      executionAttemptId: undefined,
      createdAt: complete.createdAt,
      updatedAt: complete.updatedAt,
    }));
    const references = new PersistentBybitExecutionOrderReferenceStore(generic);
    await references.create(createBybitExecutionOrderReference(complete));
    const loaded = await references.loadForUser("user-a", complete.executionId);
    assert.equal(loaded?.symbol, "DOGEUSDT");
    assert.equal(loaded?.positionIdx, 0);
  } finally {
    generic.close();
    records.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bybit HEDGE recovery persists the resolved bucket and rejects a mismatched bucket", () => {
  const store = new InMemoryBybitExecutionOrderReferenceStore();
  const { orderId: _orderId, ...recoveryBase } = complete;
  const reference = createBybitExecutionOrderRecoveryReference({
    ...recoveryBase,
    positionMode: "HEDGE",
    positionDirection: "SHORT",
    positionIdx: 2,
  });
  store.createRecovery(reference);
  assert.equal(store.loadRecoveryForUser("user-a", "execution-bybit-1")?.positionIdx, 2);
  assert.throws(() => createBybitExecutionOrderRecoveryReference({
    ...recoveryBase,
    positionMode: "HEDGE",
    positionDirection: "SHORT",
    positionIdx: 1,
  }), /bucket does not match/u);
});
