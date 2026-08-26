import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { recoveryAuditSchema } from "../cex/arbitrage-instance/ArbitrageRecoveryAuditSchema";

export type ArbitrageRecoveryAuditEntry = Readonly<{
  recoveryId: string;
  source: "AUTHENTICATED_API" | "SYSTEM_RECOVERY";
  actorId: string;
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  action: "LOCAL_NOT_DISPATCHED_TERMINALIZATION" | "HISTORICAL_RECONCILE"
    | "LEGACY_HISTORICAL_REPAIR" | "SPOT_ATTRIBUTION_BACKFILL";
  oldStatus: string;
  oldQuantity: string;
  newStatus: string;
  newQuantity: string;
  evidenceCategory: string;
  checkedAt: number;
  completedAt: number;
  result: "COMPLETED";
}>;

export interface ArbitrageRecoveryAuditWriter {
  record(entry: ArbitrageRecoveryAuditEntry): void;
}

export class ArbitrageRecoveryAuditStore implements ArbitrageRecoveryAuditWriter {
  private readonly db: DatabaseSync;

  constructor(options: Readonly<{ dbPath?: string }> = {}) {
    const dbPath = options.dbPath
      ?? process.env.TRADING_DB_PATH
      ?? resolve(process.cwd(), "server/data/trading.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(recoveryAuditSchema);
  }

  record(input: ArbitrageRecoveryAuditEntry) {
    const entry = normalize(input);
    this.db.prepare(`INSERT INTO arbitrage_recovery_audit (
      recoveryId, source, actorId, arbitrageId, legId, executionIntentId,
      action, oldStatus, oldQuantity, newStatus, newQuantity, evidenceCategory,
      checkedAt, completedAt, result
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.recoveryId,
        entry.source,
        entry.actorId,
        entry.arbitrageId,
        entry.legId,
        entry.executionIntentId,
        entry.action,
        entry.oldStatus,
        entry.oldQuantity,
        entry.newStatus,
        entry.newQuantity,
        entry.evidenceCategory,
        entry.checkedAt,
        entry.completedAt,
        entry.result,
      );
  }

  listForUser(userId: string): readonly ArbitrageRecoveryAuditEntry[] {
    const rows = this.db.prepare(`SELECT audit.* FROM arbitrage_recovery_audit audit
      JOIN arbitrage_instances owner ON owner.arbitrageId = audit.arbitrageId
      WHERE owner.userId = ? ORDER BY audit.completedAt DESC, audit.recoveryId ASC`).all(
        identifier(userId, "userId"),
      ) as unknown as ArbitrageRecoveryAuditEntry[];
    return Object.freeze(rows.map(normalize));
  }

  close() {
    this.db.close();
  }
}

function normalize(input: ArbitrageRecoveryAuditEntry): ArbitrageRecoveryAuditEntry {
  if (input.source !== "AUTHENTICATED_API" && input.source !== "SYSTEM_RECOVERY") {
    throw new Error("Recovery audit source is invalid.");
  }
  if (input.action !== "LOCAL_NOT_DISPATCHED_TERMINALIZATION"
    && input.action !== "HISTORICAL_RECONCILE"
    && input.action !== "LEGACY_HISTORICAL_REPAIR"
    && input.action !== "SPOT_ATTRIBUTION_BACKFILL") {
    throw new Error("Recovery audit action is invalid.");
  }
  if (input.result !== "COMPLETED") throw new Error("Recovery audit result is invalid.");
  const checkedAt = timestamp(input.checkedAt, "checkedAt");
  const completedAt = timestamp(input.completedAt, "completedAt");
  if (completedAt < checkedAt) throw new Error("Recovery audit completion cannot predate its evidence check.");
  return Object.freeze({
    recoveryId: identifier(input.recoveryId, "recoveryId"),
    source: input.source,
    actorId: identifier(input.actorId, "actorId"),
    arbitrageId: identifier(input.arbitrageId, "arbitrageId"),
    legId: identifier(input.legId, "legId"),
    executionIntentId: identifier(input.executionIntentId, "executionIntentId"),
    action: input.action,
    oldStatus: identifier(input.oldStatus, "oldStatus"),
    oldQuantity: decimal(input.oldQuantity, "oldQuantity"),
    newStatus: identifier(input.newStatus, "newStatus"),
    newQuantity: decimal(input.newQuantity, "newQuantity"),
    evidenceCategory: identifier(input.evidenceCategory, "evidenceCategory"),
    checkedAt,
    completedAt,
    result: input.result,
  });
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function decimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}
