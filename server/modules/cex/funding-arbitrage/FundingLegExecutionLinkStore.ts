import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type FundingLegExecutionLink = Readonly<{
  executionIntentId: string;
  executionRecordId: string;
}>;

export interface FundingLegExecutionLinkStorePort {
  findForUser(
    userId: string,
    fundingIntentId: string,
    legId: string,
  ): Promise<FundingLegExecutionLink | null> | FundingLegExecutionLink | null;
  claimForUser(
    userId: string,
    fundingIntentId: string,
    legId: string,
    executionIntentId: string,
  ): Promise<boolean> | boolean;
  linkForUser(
    userId: string,
    fundingIntentId: string,
    legId: string,
    link: FundingLegExecutionLink,
  ): Promise<void> | void;
}

type FundingLegExecutionLinkRow = Readonly<{
  userId: string;
  fundingIntentId: string;
  legId: string;
  executionIntentId: string;
  executionRecordId: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export class FundingLegExecutionLinkStore implements FundingLegExecutionLinkStorePort {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: { dbPath?: string; now?: () => number } = {}) {
    const dbPath = options.dbPath
      ?? process.env.TRADING_DB_PATH
      ?? resolve(process.cwd(), "server/data/trading.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.now = options.now ?? Date.now;
    this.migrate();
  }

  findForUser(userId: string, fundingIntentId: string, legId: string): FundingLegExecutionLink | null {
    const row = this.findRow(
      identifier(userId, "userId"),
      identifier(fundingIntentId, "fundingIntentId"),
      identifier(legId, "legId"),
    );
    if (!row?.executionRecordId) return null;
    return Object.freeze({
      executionIntentId: row.executionIntentId,
      executionRecordId: row.executionRecordId,
    });
  }

  claimForUser(
    userId: string,
    fundingIntentId: string,
    legId: string,
    executionIntentId: string,
  ) {
    const now = timestamp(this.now());
    try {
      this.db.prepare(`INSERT INTO funding_leg_execution_links (
        userId, fundingIntentId, legId, executionIntentId, executionRecordId, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, NULL, ?, ?)`).run(
        identifier(userId, "userId"),
        identifier(fundingIntentId, "fundingIntentId"),
        identifier(legId, "legId"),
        identifier(executionIntentId, "executionIntentId"),
        now,
        now,
      );
      return true;
    } catch (error) {
      if (isConstraintError(error)) return false;
      throw error;
    }
  }

  linkForUser(
    userId: string,
    fundingIntentId: string,
    legId: string,
    link: FundingLegExecutionLink,
  ) {
    const normalized = {
      userId: identifier(userId, "userId"),
      fundingIntentId: identifier(fundingIntentId, "fundingIntentId"),
      legId: identifier(legId, "legId"),
      executionIntentId: identifier(link.executionIntentId, "executionIntentId"),
      executionRecordId: identifier(link.executionRecordId, "executionRecordId"),
    };
    const existing = this.findRow(normalized.userId, normalized.fundingIntentId, normalized.legId);
    if (!existing || existing.executionIntentId !== normalized.executionIntentId) {
      throw new Error("Funding leg execution claim does not match the completed execution.");
    }
    if (existing.executionRecordId !== null) {
      if (existing.executionRecordId === normalized.executionRecordId) return;
      throw new Error("Funding leg is already linked to a different execution record.");
    }

    try {
      const result = this.db.prepare(`UPDATE funding_leg_execution_links
        SET executionRecordId = ?, updatedAt = ?
        WHERE userId = ? AND fundingIntentId = ? AND legId = ?
          AND executionIntentId = ? AND executionRecordId IS NULL`).run(
        normalized.executionRecordId,
        timestamp(this.now()),
        normalized.userId,
        normalized.fundingIntentId,
        normalized.legId,
        normalized.executionIntentId,
      );
      if (result.changes !== 1) {
        throw new Error("Funding leg execution link could not be completed.");
      }
    } catch (error) {
      if (isConstraintError(error)) {
        throw new Error("Execution identity is already linked to another funding leg.");
      }
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  private findRow(userId: string, fundingIntentId: string, legId: string) {
    return this.db.prepare(`SELECT * FROM funding_leg_execution_links
      WHERE userId = ? AND fundingIntentId = ? AND legId = ?`).get(
      userId,
      fundingIntentId,
      legId,
    ) as unknown as FundingLegExecutionLinkRow | undefined;
  }

  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS funding_leg_execution_links (
      userId TEXT NOT NULL,
      fundingIntentId TEXT NOT NULL,
      legId TEXT NOT NULL,
      executionIntentId TEXT NOT NULL UNIQUE,
      executionRecordId TEXT UNIQUE,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (userId, fundingIntentId, legId)
    ) STRICT;`);
  }
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function timestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Funding leg execution link timestamp is invalid.");
  }
  return value;
}

function isConstraintError(error: unknown) {
  return error instanceof Error && /constraint|unique|primary key/iu.test(error.message);
}
