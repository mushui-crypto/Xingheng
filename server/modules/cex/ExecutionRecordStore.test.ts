import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ExecutionRecord } from "./ExecutionRecord";
import { ExecutionRecordVersionConflictError, SqliteExecutionRecordStore } from "./ExecutionRecordStore";

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
    store.update(submitted, created);

    assert.deepEqual(store.findByExecutionId("user-a", "execution-1"), submitted);
  });
});

test("scopes reads and updates by userId", () => {
  withStore(({ store }) => {
    store.create(record());

    assert.equal(store.loadForUser("user-b", "execution-1"), null);
    assert.equal(store.findByExecutionId("user-b", "execution-1"), null);
    assert.throws(
      () => store.update(
        record({ userId: "user-b", status: "FAILED", updatedAt: 1_800_000_000_100 }),
        record({ userId: "user-b" }),
      ),
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

    const unknown = record({ status: "UNKNOWN" });
    store.update(record({ status: "CONFIRMED", updatedAt: 1_800_000_000_100 }), unknown);
    assert.equal(store.loadForUser("user-a", "execution-1")?.status, "CONFIRMED");
  });
});

for (const staleStatus of ["UNKNOWN", "FAILED", "PENDING_CONFIRMATION"] as const) {
  test(`a stale ${staleStatus} writer cannot overwrite a confirmed record`, () => {
    withDatabase(({ dbPath }) => {
      const first = new SqliteExecutionRecordStore({ dbPath });
      const second = new SqliteExecutionRecordStore({ dbPath });
      try {
        const pending = record({ status: "PENDING_CONFIRMATION" });
        first.create(pending);
        const writerA = first.loadForUser("user-a", "execution-1");
        const writerB = second.loadForUser("user-a", "execution-1");
        assert.ok(writerA);
        assert.ok(writerB);

        first.update(record({ status: "CONFIRMED", updatedAt: 1_800_000_000_100 }), writerA);
        assert.throws(
          () => second.update(record({ status: staleStatus, updatedAt: 1_800_000_000_200 }), writerB),
          (error: unknown) => error instanceof ExecutionRecordVersionConflictError
            && error.currentRecord.status === "CONFIRMED",
        );
        assert.equal(first.loadForUser("user-a", "execution-1")?.status, "CONFIRMED");
      } finally {
        first.close();
        second.close();
      }
    });
  });
}

test("an UNKNOWN observation based on the current version can advance to CONFIRMED", () => {
  withStore(({ store }) => {
    const pending = record({ status: "PENDING_CONFIRMATION" });
    store.create(pending);
    const unknown = record({ status: "UNKNOWN", updatedAt: 1_800_000_000_100 });
    store.update(unknown, pending);
    const persistedUnknown = store.loadForUser("user-a", "execution-1");
    assert.ok(persistedUnknown);

    const confirmed = record({ status: "CONFIRMED", updatedAt: 1_800_000_000_200 });
    store.update(confirmed, persistedUnknown);
    assert.equal(store.loadForUser("user-a", "execution-1")?.status, "CONFIRMED");
  });
});

test("the final record survives restart after a stale writer conflict", () => {
  withDatabase(({ dbPath }) => {
    const first = new SqliteExecutionRecordStore({ dbPath });
    const pending = record({ status: "PENDING_CONFIRMATION" });
    first.create(pending);
    first.update(record({ status: "CONFIRMED", updatedAt: 1_800_000_000_100 }), pending);
    assert.throws(
      () => first.update(record({ status: "UNKNOWN", updatedAt: 1_800_000_000_200 }), pending),
      ExecutionRecordVersionConflictError,
    );
    first.close();

    const restarted = new SqliteExecutionRecordStore({ dbPath });
    try {
      assert.equal(restarted.loadForUser("user-a", "execution-1")?.status, "CONFIRMED");
    } finally {
      restarted.close();
    }
  });
});

test("a real SQLITE_BUSY before dispatch persists no record and permits no Provider mutation", () => {
  withDatabase(({ dbPath }) => {
    const bootstrap = new SqliteExecutionRecordStore({ dbPath });
    bootstrap.close();
    const lock = new DatabaseSync(dbPath);
    const store = new SqliteExecutionRecordStore({ dbPath });
    let providerMutations = 0;
    try {
      lock.exec("BEGIN IMMEDIATE");
      assert.throws(() => store.create(record()), /database is locked/u);
      assert.equal(providerMutations, 0);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
      store.close();
    }

    const restarted = new SqliteExecutionRecordStore({ dbPath });
    try {
      assert.equal(restarted.loadForUser("user-a", "execution-1"), null);
      assert.equal(providerMutations, 0);
    } finally {
      restarted.close();
    }
  });
});

test("a post-query SQLITE_BUSY keeps the persisted recovery state and a restart can retry monotonically", () => {
  withDatabase(({ dbPath }) => {
    const first = new SqliteExecutionRecordStore({ dbPath });
    const pending = record({
      executionAttemptId: "attempt-recovery",
      remoteOrderId: "provider-order-1",
      status: "PENDING_CONFIRMATION",
    });
    first.create(pending);
    const lock = new DatabaseSync(dbPath);
    let providerQueries = 1;
    let providerMutations = 1;
    try {
      lock.exec("BEGIN IMMEDIATE");
      assert.throws(
        () => first.update(record({
          executionAttemptId: "attempt-recovery",
          remoteOrderId: "provider-order-1",
          status: "CONFIRMED",
          updatedAt: 1_800_000_000_100,
        }), pending),
        /database is locked/u,
      );
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
      first.close();
    }

    const restarted = new SqliteExecutionRecordStore({ dbPath });
    try {
      const unresolved = restarted.loadForUser("user-a", "execution-1");
      assert.equal(unresolved?.status, "PENDING_CONFIRMATION");
      assert.equal(unresolved?.executionAttemptId, "attempt-recovery");
      assert.equal(unresolved?.remoteOrderId, "provider-order-1");
      providerQueries += 1;
      assert.ok(unresolved);
      restarted.update(record({
        executionAttemptId: "attempt-recovery",
        remoteOrderId: "provider-order-1",
        status: "CONFIRMED",
        updatedAt: 1_800_000_000_200,
      }), unresolved);
      assert.equal(restarted.loadForUser("user-a", "execution-1")?.status, "CONFIRMED");
      assert.equal(providerQueries, 2);
      assert.equal(providerMutations, 1);
    } finally {
      restarted.close();
    }
  });
});

test("a stale writer still cannot overwrite CONFIRMED after a transient SQLITE_BUSY and reload", () => {
  withDatabase(({ dbPath }) => {
    const writerA = new SqliteExecutionRecordStore({ dbPath });
    const writerB = new SqliteExecutionRecordStore({ dbPath });
    const pending = record({ status: "PENDING_CONFIRMATION" });
    writerA.create(pending);
    const stale = writerB.loadForUser("user-a", "execution-1");
    assert.ok(stale);
    const lock = new DatabaseSync(dbPath);
    try {
      lock.exec("BEGIN IMMEDIATE");
      assert.throws(
        () => writerA.update(record({ status: "UNKNOWN", updatedAt: 1_800_000_000_050 }), pending),
        /database is locked/u,
      );
      lock.exec("ROLLBACK");
      writerA.update(record({ status: "CONFIRMED", updatedAt: 1_800_000_000_100 }), pending);
      assert.throws(
        () => writerB.update(record({ status: "FAILED", updatedAt: 1_800_000_000_200 }), stale),
        ExecutionRecordVersionConflictError,
      );
      assert.equal(writerB.loadForUser("user-a", "execution-1")?.status, "CONFIRMED");
    } finally {
      if (lock.isOpen) {
        try { lock.exec("ROLLBACK"); } catch { /* transaction already ended */ }
        lock.close();
      }
      writerA.close();
      writerB.close();
    }
  });
});

test("conditional execution-record migration is restart-safe and preserves legacy facts", () => {
  withDatabase(({ dbPath }) => {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE execution_records (
      executionId TEXT PRIMARY KEY, userId TEXT NOT NULL, venue TEXT NOT NULL,
      accountId TEXT NOT NULL, intentId TEXT NOT NULL, executionAttemptId TEXT,
      instrumentId TEXT NOT NULL, state TEXT NOT NULL, remoteOrderId TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    )`);
    legacy.prepare(`INSERT INTO execution_records (
      executionId, userId, venue, accountId, intentId, executionAttemptId,
      instrumentId, state, remoteOrderId, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "legacy-execution", "user-a", "binance", "account-a", "intent-legacy", null,
      "XAUT-USDT-PERP", "UNKNOWN", "remote-legacy", 1_700_000_000_000, 1_700_000_000_100,
    );
    legacy.close();

    const migrated = new SqliteExecutionRecordStore({ dbPath });
    assert.equal(migrated.loadForUser("user-a", "legacy-execution")?.status, "UNKNOWN");
    migrated.close();
    const restarted = new SqliteExecutionRecordStore({ dbPath });
    try {
      const fact = restarted.loadForUser("user-a", "legacy-execution");
      assert.equal(fact?.status, "UNKNOWN");
      assert.equal(fact?.remoteOrderId, "remote-legacy");
      assert.equal(fact?.failureCategory, undefined);
    } finally {
      restarted.close();
    }
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
        "failureCategory",
        "failureCode",
        "failureMessage",
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
