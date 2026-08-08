import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BinancePreflightSnapshot } from "./BinanceTypes";
import type { BinanceProviderOrder } from "./BinanceTypes";
import type { BinanceOrderExecutionMode } from "./BinanceTypes";

export type BinanceStoredOrder = {
  idempotencyKey: string;
  requestFingerprint: string;
  clientOrderId: string;
  providerOrderId: string | null;
  category: "spot" | "linear";
  executionMode: BinanceOrderExecutionMode;
  status: "processing" | "completed" | "failed";
  order: BinanceProviderOrder | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export class BinanceOrderStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = process.env.BINANCE_TRADING_DB_PATH
    ?? process.env.TRADING_DB_PATH
    ?? resolve(process.cwd(), "server/data/trading.sqlite")) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS binance_personal_orders (
        idempotencyKey TEXT PRIMARY KEY,
        requestFingerprint TEXT NOT NULL,
        clientOrderId TEXT NOT NULL UNIQUE,
        providerOrderId TEXT,
        category TEXT NOT NULL CHECK(category IN ('spot', 'linear')),
        executionMode TEXT NOT NULL DEFAULT 'production_ioc' CHECK(executionMode IN ('production_ioc', 'test_gtc')),
        status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
        orderJson TEXT,
        error TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS binance_personal_position_snapshots (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        snapshotJson TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);
    if (!this.columnExists("binance_personal_orders", "executionMode")) {
      this.db.exec("ALTER TABLE binance_personal_orders ADD COLUMN executionMode TEXT NOT NULL DEFAULT 'production_ioc';");
    }
  }

  reserve(input: Omit<BinanceStoredOrder, "providerOrderId" | "status" | "order" | "error" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    try {
      this.db.prepare(`INSERT INTO binance_personal_orders (
        idempotencyKey, requestFingerprint, clientOrderId, providerOrderId, category, executionMode,
        status, orderJson, error, createdAt, updatedAt
      ) VALUES (?, ?, ?, NULL, ?, ?, 'processing', NULL, NULL, ?, ?)`)
        .run(input.idempotencyKey, input.requestFingerprint, input.clientOrderId, input.category, input.executionMode, now, now);
      return { kind: "reserved" as const };
    } catch {
      const existing = this.find(input.idempotencyKey);
      if (!existing || existing.requestFingerprint !== input.requestFingerprint) return { kind: "conflict" as const };
      return { kind: "existing" as const, order: existing };
    }
  }

  recordProviderOrder(idempotencyKey: string, providerOrderId: string) {
    this.db.prepare("UPDATE binance_personal_orders SET providerOrderId = ?, updatedAt = ? WHERE idempotencyKey = ?")
      .run(providerOrderId, Date.now(), idempotencyKey);
  }

  complete(idempotencyKey: string, order: BinanceProviderOrder) {
    if (order.status !== "Filled") throw new Error("Only Filled Binance orders can be completed.");
    this.db.prepare("UPDATE binance_personal_orders SET providerOrderId = ?, status = 'completed', orderJson = ?, error = NULL, updatedAt = ? WHERE idempotencyKey = ?")
      .run(order.orderId, JSON.stringify(order), Date.now(), idempotencyKey);
  }

  recordProcessingOrder(idempotencyKey: string, order: BinanceProviderOrder) {
    if (!["New", "PartiallyFilled", "Unknown"].includes(order.status)) {
      throw new Error("Only non-terminal Binance orders can remain processing.");
    }
    this.db.prepare("UPDATE binance_personal_orders SET providerOrderId = ?, status = 'processing', orderJson = ?, error = NULL, updatedAt = ? WHERE idempotencyKey = ?")
      .run(order.orderId, JSON.stringify(order), Date.now(), idempotencyKey);
  }

  fail(idempotencyKey: string, error: string) {
    this.db.prepare("UPDATE binance_personal_orders SET status = 'failed', error = ?, updatedAt = ? WHERE idempotencyKey = ?")
      .run(error.slice(0, 500), Date.now(), idempotencyKey);
  }

  failWithOrder(idempotencyKey: string, order: BinanceProviderOrder, error: string) {
    if (!["Cancelled", "Rejected", "Expired"].includes(order.status)) {
      throw new Error("Only failed terminal Binance orders can be terminalized as failed.");
    }
    this.db.prepare("UPDATE binance_personal_orders SET providerOrderId = ?, status = 'failed', orderJson = ?, error = ?, updatedAt = ? WHERE idempotencyKey = ?")
      .run(order.orderId, JSON.stringify(order), error.slice(0, 500), Date.now(), idempotencyKey);
  }

  markProcessingError(idempotencyKey: string, error: string) {
    this.db.prepare("UPDATE binance_personal_orders SET error = ?, updatedAt = ? WHERE idempotencyKey = ? AND status = 'processing'")
      .run(error.slice(0, 500), Date.now(), idempotencyKey);
  }

  find(idempotencyKey: string): BinanceStoredOrder | null {
    const row = this.db.prepare("SELECT * FROM binance_personal_orders WHERE idempotencyKey = ?").get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? parseStoredOrder(row) : null;
  }

  list(limit = 100) {
    return (this.db.prepare("SELECT * FROM binance_personal_orders ORDER BY createdAt DESC LIMIT ?").all(limit) as Record<string, unknown>[])
      .map(parseStoredOrder);
  }

  listAll() {
    return (this.db.prepare("SELECT * FROM binance_personal_orders ORDER BY createdAt DESC").all() as Record<string, unknown>[])
      .map(parseStoredOrder);
  }

  listProcessing() {
    return (this.db.prepare("SELECT * FROM binance_personal_orders WHERE status = 'processing' ORDER BY createdAt ASC").all() as Record<string, unknown>[])
      .map(parseStoredOrder);
  }

  savePositionSnapshot(snapshot: BinancePreflightSnapshot) {
    this.db.prepare(`INSERT INTO binance_personal_position_snapshots (id, snapshotJson, updatedAt)
      VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshotJson = excluded.snapshotJson, updatedAt = excluded.updatedAt`)
      .run(JSON.stringify(snapshot), Date.now());
  }

  close() {
    this.db.close();
  }

  private columnExists(table: string, column: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((item) => item.name === column);
  }
}

function parseStoredOrder(row: Record<string, unknown>): BinanceStoredOrder {
  return {
    idempotencyKey: String(row.idempotencyKey),
    requestFingerprint: String(row.requestFingerprint),
    clientOrderId: String(row.clientOrderId),
    providerOrderId: row.providerOrderId === null ? null : String(row.providerOrderId),
    category: row.category as "spot" | "linear",
    executionMode: row.executionMode === "test_gtc" ? "test_gtc" : "production_ioc",
    status: row.status as BinanceStoredOrder["status"],
    order: row.orderJson ? JSON.parse(String(row.orderJson)) as BinanceProviderOrder : null,
    error: row.error === null ? null : String(row.error),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}
