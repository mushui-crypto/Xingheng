import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ExecutionRecord } from "./ExecutionRecord";
import {
  SqliteExecutionOrderReferenceStore,
  type ExecutionOrderReferenceAssociation,
} from "./ExecutionOrderReferenceStore";
import { SqliteExecutionRecordStore } from "./ExecutionRecordStore";

const now = 1_800_000_000_000;

test("persists and scopes a venue-neutral execution order reference association", () => {
  withStores(({ records, references }) => {
    records.create(executionRecord());
    references.create(association());

    assert.deepEqual(references.loadForUser("user-a", "execution-okx-1", "okx"), association());
    assert.equal(references.loadForUser("user-b", "execution-okx-1", "okx"), null);
    assert.equal(references.loadForUser("user-a", "execution-okx-1", "binance"), null);
  });
});

test("fails closed when the association does not match an existing ExecutionRecord", () => {
  withStores(({ records, references }) => {
    assert.throws(() => references.create(association()), /ExecutionRecord was not found/u);
    records.create(executionRecord());
    assert.throws(
      () => references.create(association({ userId: "user-b" })),
      /identity does not match/u,
    );
    assert.throws(
      () => references.create(association({ venue: "binance" })),
      /identity does not match/u,
    );
  });
});

test("stores independent opaque references for every supported venue", () => {
  withStores(({ records, references }) => {
    for (const [venue, suffix] of [
      ["binance", "binance"],
      ["okx", "okx"],
      ["bybit", "bybit"],
      ["bitget", "bitget"],
    ] as const) {
      const executionId = `execution-${suffix}`;
      const referencePayload = `opaque-${suffix}-reference`;
      records.create(executionRecord({
        executionId,
        intentId: `intent-${suffix}`,
        venue,
        accountId: `${venue}:account-user-a`,
        remoteOrderId: `${suffix}-order-1`,
      }));
      references.create(association({ executionId, venue, referencePayload }));

      assert.equal(
        references.loadForUser("user-a", executionId, venue)?.referencePayload,
        referencePayload,
      );
    }
  });
});

test("atomically replaces only the opaque payload for an existing association", () => {
  withStores(({ records, references }) => {
    records.create(executionRecord());
    references.create(association({ referencePayload: "opaque-recovery-reference" }));

    references.replace(association({
      referencePayload: "opaque-complete-reference",
      updatedAt: now + 1,
    }));

    assert.deepEqual(
      references.loadForUser("user-a", "execution-okx-1", "okx"),
      association({ referencePayload: "opaque-complete-reference", updatedAt: now + 1 }),
    );
  });
});

test("reference replacement fails closed for missing or mismatched association identity", () => {
  withStores(({ records, references }) => {
    records.create(executionRecord());
    assert.throws(
      () => references.replace(association()),
      /not found for replacement/u,
    );
    references.create(association());
    assert.throws(
      () => references.replace(association({ userId: "user-b" })),
      /identity does not match/u,
    );
  });
});

test("the common table contains only association and opaque payload columns", () => {
  withStores(({ dbPath }) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = db.prepare("PRAGMA table_info(execution_order_references)").all() as Array<{ name: string }>;
      assert.deepEqual(columns.map(({ name }) => name), [
        "executionId",
        "userId",
        "venue",
        "referencePayload",
        "createdAt",
        "updatedAt",
      ]);
    } finally {
      db.close();
    }
  });
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

function association(
  overrides: Partial<ExecutionOrderReferenceAssociation> = {},
): ExecutionOrderReferenceAssociation {
  return Object.freeze({
    executionId: "execution-okx-1",
    userId: "user-a",
    venue: "okx",
    referencePayload: "opaque-venue-reference",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function withStores(operation: (fixture: {
  dbPath: string;
  records: SqliteExecutionRecordStore;
  references: SqliteExecutionOrderReferenceStore;
}) => void) {
  const root = mkdtempSync(join(tmpdir(), "execution-order-reference-store-"));
  const dbPath = join(root, "trading.sqlite");
  const records = new SqliteExecutionRecordStore({ dbPath });
  const references = new SqliteExecutionOrderReferenceStore({ dbPath });
  try {
    operation({ dbPath, records, references });
  } finally {
    references.close();
    records.close();
    rmSync(root, { recursive: true, force: true });
  }
}
