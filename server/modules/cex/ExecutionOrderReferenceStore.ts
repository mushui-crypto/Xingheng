import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExecutionVenue } from "./ExecutionIntent";

export type ExecutionOrderReferenceAssociation = Readonly<{
  executionId: string;
  userId: string;
  venue: ExecutionVenue;
  /** Venue-owned opaque payload. Common execution code must not parse it. */
  referencePayload: string;
  createdAt: number;
  updatedAt: number;
}>;

export interface ExecutionOrderReferenceStore {
  create(association: ExecutionOrderReferenceAssociation): Promise<void> | void;
  replace(association: ExecutionOrderReferenceAssociation): Promise<void> | void;
  loadForUser(
    userId: string,
    executionId: string,
    venue: ExecutionVenue,
  ): Promise<ExecutionOrderReferenceAssociation | null> | ExecutionOrderReferenceAssociation | null;
}

type AssociationRow = Readonly<{
  executionId: string;
  userId: string;
  venue: string;
  referencePayload: string;
  createdAt: number;
  updatedAt: number;
}>;

export class SqliteExecutionOrderReferenceStore implements ExecutionOrderReferenceStore {
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

  create(input: ExecutionOrderReferenceAssociation) {
    const association = createExecutionOrderReferenceAssociation(input);
    this.assertExecutionAssociation(association);
    this.db.prepare(`INSERT INTO execution_order_references (
      executionId, userId, venue, referencePayload, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(
      association.executionId,
      association.userId,
      association.venue,
      association.referencePayload,
      association.createdAt,
      association.updatedAt,
    );
  }

  replace(input: ExecutionOrderReferenceAssociation) {
    const association = createExecutionOrderReferenceAssociation(input);
    this.assertExecutionAssociation(association);
    const result = this.db.prepare(`UPDATE execution_order_references SET
      referencePayload = ?, createdAt = ?, updatedAt = ?
      WHERE executionId = ? AND userId = ? AND venue = ?`).run(
      association.referencePayload,
      association.createdAt,
      association.updatedAt,
      association.executionId,
      association.userId,
      association.venue,
    );
    if (result.changes !== 1) {
      throw new Error("Execution order reference association was not found for replacement.");
    }
  }

  loadForUser(userId: string, executionId: string, venue: ExecutionVenue) {
    const row = this.db.prepare(`SELECT
      executionId, userId, venue, referencePayload, createdAt, updatedAt
      FROM execution_order_references
      WHERE userId = ? AND executionId = ? AND venue = ?`).get(
      identifier(userId, "userId"),
      identifier(executionId, "executionId"),
      executionVenue(venue),
    ) as unknown as AssociationRow | undefined;
    return row ? associationFromRow(row) : null;
  }

  close() {
    this.db.close();
  }

  private assertExecutionAssociation(association: ExecutionOrderReferenceAssociation) {
    const record = this.db.prepare(`SELECT userId, venue
      FROM execution_records
      WHERE executionId = ?`).get(association.executionId) as unknown as {
        userId: string;
        venue: string;
      } | undefined;
    if (!record) throw new Error("ExecutionRecord was not found for the order reference.");
    if (record.userId !== association.userId || record.venue !== association.venue) {
      throw new Error("Execution order reference identity does not match its ExecutionRecord.");
    }
  }

  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS execution_order_references (
      executionId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      venue TEXT NOT NULL CHECK (venue IN ('binance', 'okx', 'bybit', 'bitget')),
      referencePayload TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      FOREIGN KEY (executionId) REFERENCES execution_records(executionId)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS execution_order_references_user_venue
      ON execution_order_references(userId, venue, executionId);`);
  }
}

export function createExecutionOrderReferenceAssociation(
  input: unknown,
): ExecutionOrderReferenceAssociation {
  const value = object(input, "ExecutionOrderReferenceAssociation");
  exactKeys(value, [
    "executionId",
    "userId",
    "venue",
    "referencePayload",
    "createdAt",
    "updatedAt",
  ], "ExecutionOrderReferenceAssociation");
  const createdAt = timestamp(value.createdAt, "createdAt");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("updatedAt must be at or after createdAt.");
  return Object.freeze({
    executionId: identifier(value.executionId, "executionId"),
    userId: identifier(value.userId, "userId"),
    venue: executionVenue(value.venue),
    referencePayload: referencePayload(value.referencePayload),
    createdAt,
    updatedAt,
  });
}

function associationFromRow(row: AssociationRow) {
  return createExecutionOrderReferenceAssociation(row);
}

function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`${name} contains unsupported field: ${unknown}.`);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function executionVenue(value: unknown): ExecutionVenue {
  if (value !== "binance" && value !== "okx" && value !== "bybit" && value !== "bitget") {
    throw new Error("venue is invalid.");
  }
  return value;
}

function referencePayload(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 8_192) {
    throw new Error("referencePayload is invalid.");
  }
  return value;
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}
