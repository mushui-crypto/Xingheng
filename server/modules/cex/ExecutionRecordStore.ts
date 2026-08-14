import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createExecutionRecord, type ExecutionRecord } from "./ExecutionRecord";

export interface ExecutionRecordStore {
  create(record: ExecutionRecord): Promise<void> | void;
  update(record: ExecutionRecord): Promise<void> | void;
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
      instrumentId, state, remoteOrderId, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      normalized.executionId,
      normalized.userId,
      normalized.venue,
      normalized.accountId,
      normalized.intentId,
      normalized.executionAttemptId ?? null,
      normalized.instrumentId,
      normalized.status,
      normalized.remoteOrderId ?? null,
      normalized.createdAt,
      normalized.updatedAt,
    );
  }

  update(record: ExecutionRecord) {
    const normalized = createExecutionRecord(record);
    const existing = this.findRow(normalized.userId, normalized.executionId);
    if (!existing) throw new Error("ExecutionRecord was not found for the authenticated user.");
    assertImmutableIdentity(existing, normalized);
    if (normalized.updatedAt < existing.updatedAt) {
      throw new Error("ExecutionRecord updatedAt cannot move backwards.");
    }

    const result = this.db.prepare(`UPDATE execution_records
      SET executionAttemptId = ?, state = ?, remoteOrderId = ?, updatedAt = ?
      WHERE userId = ? AND executionId = ? AND updatedAt = ?`).run(
      normalized.executionAttemptId ?? null,
      normalized.status,
      normalized.remoteOrderId ?? null,
      normalized.updatedAt,
      normalized.userId,
      normalized.executionId,
      existing.updatedAt,
    );
    if (result.changes !== 1) {
      throw new Error("ExecutionRecord update conflicted with another writer.");
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
      instrumentId, state, remoteOrderId, createdAt, updatedAt
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
      instrumentId, state, remoteOrderId, createdAt, updatedAt
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
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    ) STRICT;`);
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function assertImmutableIdentity(row: ExecutionRecordRow, record: ExecutionRecord) {
  if (
    row.intentId !== record.intentId
    || row.venue !== record.venue
    || row.accountId !== record.accountId
    || row.instrumentId !== record.instrumentId
    || row.createdAt !== record.createdAt
  ) {
    throw new Error("ExecutionRecord immutable identity cannot be changed.");
  }
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
