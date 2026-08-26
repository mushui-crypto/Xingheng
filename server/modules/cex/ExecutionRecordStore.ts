import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createExecutionRecord, type ExecutionRecord } from "./ExecutionRecord";

export interface ExecutionRecordStore {
  create(record: ExecutionRecord): Promise<void> | void;
  update(record: ExecutionRecord, expectedPersistedRecord: ExecutionRecord): Promise<void> | void;
  loadForUser(
    userId: string,
    executionId: string,
  ): Promise<ExecutionRecord | null> | ExecutionRecord | null;
}

export interface ExecutionRecordRecoveryStore {
  findByIntentId(intentId: string): Promise<readonly ExecutionRecord[]> | readonly ExecutionRecord[];
}

type ExecutionRecordRow = Readonly<{
  executionId: string;
  userId: string;
  venue: string;
  accountId: string;
  intentId: string;
  executionAttemptId: string | null;
  instrumentId: string;
  state: string;
  remoteOrderId: string | null;
  failureCategory: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export class SqliteExecutionRecordStore implements ExecutionRecordStore {
  private readonly db: DatabaseSync;

  constructor(options: Readonly<{ dbPath?: string }> = {}) {
    const dbPath = options.dbPath
      ?? process.env.TRADING_DB_PATH
      ?? resolve(process.cwd(), "server/data/trading.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  create(record: ExecutionRecord) {
    const normalized = createExecutionRecord(record);
    this.db.prepare(`INSERT INTO execution_records (
      executionId, userId, venue, accountId, intentId, executionAttemptId,
      instrumentId, state, remoteOrderId, failureCategory, failureCode, failureMessage, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      normalized.executionId,
      normalized.userId,
      normalized.venue,
      normalized.accountId,
      normalized.intentId,
      normalized.executionAttemptId ?? null,
      normalized.instrumentId,
      normalized.status,
      normalized.remoteOrderId ?? null,
      normalized.failureCategory ?? null,
      normalized.failureCode ?? null,
      normalized.failureMessage ?? null,
      normalized.createdAt,
      normalized.updatedAt,
    );
  }

  update(record: ExecutionRecord, expectedPersistedRecord: ExecutionRecord) {
    const normalized = createExecutionRecord(record);
    const expected = createExecutionRecord(expectedPersistedRecord);
    assertSameRecordIdentity(expected, normalized);
    if (normalized.updatedAt < expected.updatedAt) {
      throw new Error("ExecutionRecord updatedAt cannot move backwards.");
    }

    const result = this.db.prepare(`UPDATE execution_records
      SET executionAttemptId = ?, state = ?, remoteOrderId = ?, failureCategory = ?, failureCode = ?, failureMessage = ?, updatedAt = ?
      WHERE userId = ? AND executionId = ?
        AND executionAttemptId IS ? AND state = ? AND remoteOrderId IS ?
        AND failureCategory IS ? AND failureCode IS ? AND failureMessage IS ?
        AND createdAt = ? AND updatedAt = ?`).run(
      normalized.executionAttemptId ?? null,
      normalized.status,
      normalized.remoteOrderId ?? null,
      normalized.failureCategory ?? null,
      normalized.failureCode ?? null,
      normalized.failureMessage ?? null,
      normalized.updatedAt,
      normalized.userId,
      normalized.executionId,
      expected.executionAttemptId ?? null,
      expected.status,
      expected.remoteOrderId ?? null,
      expected.failureCategory ?? null,
      expected.failureCode ?? null,
      expected.failureMessage ?? null,
      expected.createdAt,
      expected.updatedAt,
    );
    if (result.changes !== 1) {
      const current = this.findRow(normalized.userId, normalized.executionId);
      if (!current) {
        throw new Error("ExecutionRecord was not found for the authenticated user.");
      }
      throw new ExecutionRecordVersionConflictError(normalized.executionId, recordFromRow(current));
    }
  }

  loadForUser(userId: string, executionId: string) {
    return this.findByExecutionId(userId, executionId);
  }

  findByExecutionId(userId: string, executionId: string): ExecutionRecord | null {
    const row = this.findRow(
      identifier(userId, "userId"),
      identifier(executionId, "executionId"),
    );
    return row ? recordFromRow(row) : null;
  }

  findByIntentId(intentId: string): readonly ExecutionRecord[] {
    const rows = this.db.prepare(`SELECT
      executionId, userId, venue, accountId, intentId, executionAttemptId,
      instrumentId, state, remoteOrderId, failureCategory, failureCode, failureMessage, createdAt, updatedAt
      FROM execution_records
      WHERE intentId = ?
      ORDER BY executionId ASC`).all(identifier(intentId, "intentId")) as unknown as ExecutionRecordRow[];
    return Object.freeze(rows.map(recordFromRow));
  }

  close() {
    this.db.close();
  }

  private findRow(userId: string, executionId: string) {
    return this.db.prepare(`SELECT
      executionId, userId, venue, accountId, intentId, executionAttemptId,
      instrumentId, state, remoteOrderId, failureCategory, failureCode, failureMessage, createdAt, updatedAt
      FROM execution_records
      WHERE userId = ? AND executionId = ?`).get(userId, executionId) as unknown as ExecutionRecordRow | undefined;
  }

  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS execution_records (
      executionId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      venue TEXT NOT NULL CHECK (venue IN ('binance', 'okx', 'bybit', 'bitget')),
      accountId TEXT NOT NULL,
      intentId TEXT NOT NULL,
      executionAttemptId TEXT,
      instrumentId TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'CREATED', 'SUBMITTED', 'PENDING_CONFIRMATION', 'CONFIRMED', 'FAILED', 'UNKNOWN'
      )),
      remoteOrderId TEXT,
      failureCategory TEXT,
      failureCode TEXT,
      failureMessage TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    ) STRICT;`);
    const columns = new Set((this.db.prepare("PRAGMA table_info(execution_records)").all() as Array<{ name: string }>).map((column) => column.name));
    for (const column of ["failureCategory", "failureCode", "failureMessage"] as const) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE execution_records ADD COLUMN ${column} TEXT`);
    }
  }
}

function recordFromRow(row: ExecutionRecordRow) {
  return createExecutionRecord({
    executionId: row.executionId,
    intentId: row.intentId,
    ...(row.executionAttemptId === null ? {} : { executionAttemptId: row.executionAttemptId }),
    userId: row.userId,
    venue: row.venue,
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    status: row.state,
    ...(row.remoteOrderId === null ? {} : { remoteOrderId: row.remoteOrderId }),
    ...(row.failureCategory === null ? {} : { failureCategory: row.failureCategory }),
    ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
    ...(row.failureMessage === null ? {} : { failureMessage: row.failureMessage }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function assertSameRecordIdentity(expected: ExecutionRecord, record: ExecutionRecord) {
  if (
    expected.executionId !== record.executionId
    || expected.intentId !== record.intentId
    || expected.userId !== record.userId
    || expected.venue !== record.venue
    || expected.accountId !== record.accountId
    || expected.instrumentId !== record.instrumentId
    || expected.createdAt !== record.createdAt
  ) {
    throw new Error("ExecutionRecord immutable identity cannot be changed.");
  }
}

export class ExecutionRecordVersionConflictError extends Error {
  constructor(
    readonly executionId: string,
    readonly currentRecord: ExecutionRecord,
  ) {
    super(`ExecutionRecord ${executionId} update is based on a stale persisted record.`);
  }
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
