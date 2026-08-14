import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ExecutionRecord } from "./ExecutionRecord";
import { SqliteExecutionRecordStore } from "./ExecutionRecordStore";

test("persists and updates a complete execution record round trip", () => {
  withStore(({ store }) => {
    const created = record();
    store.create(created);
    assert.deepEqual(store.loadForUser("user-a", "execution-1"), created);

    const submitted = record({
      executionAttemptId: "attempt-1",
      remoteOrderId: "remote-order-1",
      status: "PENDING_CONFIRMATION",
      updatedAt: 1_800_000_000_100,
    });
    store.update(submitted);

    assert.deepEqual(store.findByExecutionId("user-a", "execution-1"), submitted);
  });
});

test("scopes reads and updates by userId", () => {
  withStore(({ store }) => {
    store.create(record());

    assert.equal(store.loadForUser("user-b", "execution-1"), null);
    assert.equal(store.findByExecutionId("user-b", "execution-1"), null);
    assert.throws(
      () => store.update(record({ userId: "user-b", status: "FAILED", updatedAt: 1_800_000_000_100 })),
      /not found for the authenticated user/u,
    );
    assert.equal(store.loadForUser("user-a", "execution-1")?.status, "CREATED");
  });
});

test("restores an execution record after the store is restarted", () => {
  withDatabase(({ dbPath }) => {
    const first = new SqliteExecutionRecordStore({ dbPath });
    first.create(record({
      executionAttemptId: "attempt-1",
      remoteOrderId: "remote-order-1",
      status: "PENDING_CONFIRMATION",
      updatedAt: 1_800_000_000_100,
    }));
    first.close();

    const second = new SqliteExecutionRecordStore({ dbPath });
    try {
      assert.deepEqual(second.loadForUser("user-a", "execution-1"), record({
        executionAttemptId: "attempt-1",
        remoteOrderId: "remote-order-1",
        status: "PENDING_CONFIRMATION",
        updatedAt: 1_800_000_000_100,
      }));
    } finally {
      second.close();
    }
  });
});

test("finds every persisted recovery candidate by intentId after restart", () => {
  withDatabase(({ dbPath }) => {
    const first = new SqliteExecutionRecordStore({ dbPath });
    first.create(record({ executionId: "execution-b", userId: "user-b" }));
    first.create(record({ executionId: "execution-a" }));
    first.close();

    const second = new SqliteExecutionRecordStore({ dbPath });
    try {
      assert.deepEqual(
        second.findByIntentId("intent-1").map(({ executionId, userId }) => ({ executionId, userId })),
        [
          { executionId: "execution-a", userId: "user-a" },
          { executionId: "execution-b", userId: "user-b" },
        ],
      );
      assert.deepEqual(second.findByIntentId("missing-intent"), []);
    } finally {
      second.close();
    }
  });
});

test("persists UNKNOWN and CONFIRMED states", () => {
  withStore(({ store }) => {
    store.create(record({ status: "UNKNOWN" }));
    assert.equal(store.loadForUser("user-a", "execution-1")?.status, "UNKNOWN");

    store.update(record({ status: "CONFIRMED", updatedAt: 1_800_000_000_100 }));
    assert.equal(store.loadForUser("user-a", "execution-1")?.status, "CONFIRMED");
  });
});

test("stores only the approved execution record fields", () => {
  withStore(({ dbPath }) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = db.prepare("PRAGMA table_info(execution_records)").all() as Array<{ name: string }>;
      assert.deepEqual(columns.map(({ name }) => name), [
        "executionId",
        "userId",
        "venue",
        "accountId",
        "intentId",
        "executionAttemptId",
        "instrumentId",
        "state",
        "remoteOrderId",
        "createdAt",
        "updatedAt",
      ]);
    } finally {
      db.close();
    }
  });
});

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return Object.freeze({
    executionId: "execution-1",
    intentId: "intent-1",
    userId: "user-a",
    venue: "binance",
    accountId: "account-a",
    instrumentId: "XAUT-USDT-PERP",
    status: "CREATED",
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    ...overrides,
  });
}

function withStore(operation: (fixture: {
  store: SqliteExecutionRecordStore;
  dbPath: string;
}) => void) {
  withDatabase(({ dbPath }) => {
    const store = new SqliteExecutionRecordStore({ dbPath });
    try {
      operation({ store, dbPath });
    } finally {
      store.close();
    }
  });
}

function withDatabase(operation: (fixture: { dbPath: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), "execution-record-store-"));
  try {
    operation({ dbPath: join(root, "execution-records.sqlite") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
