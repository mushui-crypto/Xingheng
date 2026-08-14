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
  symbol: string;
  executionMode: BinanceOrderExecutionMode;
  status: "processing" | "completed" | "failed";
  order: BinanceProviderOrder | null;
  error: string | null;
  cancelRequestedAt: number | null;
  cancelDispatchState: BinanceCancelDispatchState | null;
  createdAt: number;
  updatedAt: number;
};

export type BinanceCancelDispatchState =
  | "CLAIMED_NOT_DISPATCHED"
  | "DISPATCHED_UNKNOWN"
  | "TERMINAL_CONFIRMED"
  | "LEGACY_UNKNOWN";

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
        symbol TEXT NOT NULL,
        executionMode TEXT NOT NULL DEFAULT 'production_ioc' CHECK(executionMode IN ('production_ioc', 'test_gtc')),
        status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
        orderJson TEXT,
        error TEXT,
        cancelRequestedAt INTEGER,
        cancelDispatchState TEXT CHECK(cancelDispatchState IN (
          'CLAIMED_NOT_DISPATCHED', 'DISPATCHED_UNKNOWN', 'TERMINAL_CONFIRMED', 'LEGACY_UNKNOWN'
        )),
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
    if (!this.columnExists("binance_personal_orders", "symbol")) {
      // Every row present before this migration belongs to the legacy XAUT-only execution path.
      // The new nullable column deliberately has no default: records created after migration must
      // persist an explicit provider symbol and fail closed when that metadata is absent.
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE binance_personal_orders ADD COLUMN symbol TEXT;
        UPDATE binance_personal_orders SET symbol = 'XAUTUSDT' WHERE symbol IS NULL;
        COMMIT;
      `);
    }
    if (!this.columnExists("binance_personal_orders", "cancelRequestedAt")) {
      this.db.exec("ALTER TABLE binance_personal_orders ADD COLUMN cancelRequestedAt INTEGER;");
    }
    if (!this.columnExists("binance_personal_orders", "cancelDispatchState")) {
      // A legacy cancelRequestedAt does not prove whether the provider request was dispatched.
      // Keep it explicitly ambiguous and fail closed instead of guessing either direction.
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE binance_personal_orders ADD COLUMN cancelDispatchState TEXT;
        UPDATE binance_personal_orders
        SET cancelDispatchState = 'LEGACY_UNKNOWN'
        WHERE cancelRequestedAt IS NOT NULL;
        COMMIT;
      `);
    }
  }

  reserve(input: Omit<BinanceStoredOrder, "providerOrderId" | "status" | "order" | "error" | "cancelRequestedAt" | "cancelDispatchState" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    const symbol = providerSymbol(input.symbol);
    try {
      this.db.prepare(`INSERT INTO binance_personal_orders (
        idempotencyKey, requestFingerprint, clientOrderId, providerOrderId, category, symbol, executionMode,
        status, orderJson, error, createdAt, updatedAt
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'processing', NULL, NULL, ?, ?)`)
        .run(input.idempotencyKey, input.requestFingerprint, input.clientOrderId, input.category, symbol, input.executionMode, now, now);
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
    this.db.prepare(`UPDATE binance_personal_orders
      SET providerOrderId = ?, status = 'completed', orderJson = ?, error = NULL,
        cancelDispatchState = CASE WHEN cancelRequestedAt IS NULL THEN cancelDispatchState ELSE 'TERMINAL_CONFIRMED' END,
        updatedAt = ?
      WHERE idempotencyKey = ?`)
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
    this.db.prepare(`UPDATE binance_personal_orders
      SET providerOrderId = ?, status = 'failed', orderJson = ?, error = ?,
        cancelDispatchState = CASE WHEN cancelRequestedAt IS NULL THEN cancelDispatchState ELSE 'TERMINAL_CONFIRMED' END,
        updatedAt = ?
      WHERE idempotencyKey = ?`)
      .run(order.orderId, JSON.stringify(order), error.slice(0, 500), Date.now(), idempotencyKey);
  }

  markProcessingError(idempotencyKey: string, error: string) {
    this.db.prepare("UPDATE binance_personal_orders SET error = ?, updatedAt = ? WHERE idempotencyKey = ? AND status = 'processing'")
      .run(error.slice(0, 500), Date.now(), idempotencyKey);
  }

  claimCancellation(idempotencyKey: string) {
    const result = this.db.prepare(`UPDATE binance_personal_orders
      SET cancelRequestedAt = ?, cancelDispatchState = 'CLAIMED_NOT_DISPATCHED', updatedAt = ?
      WHERE idempotencyKey = ? AND status = 'processing'
        AND cancelRequestedAt IS NULL AND cancelDispatchState IS NULL`)
      .run(Date.now(), Date.now(), idempotencyKey);
    return result.changes === 1;
  }

  markCancellationDispatched(idempotencyKey: string) {
    const result = this.db.prepare(`UPDATE binance_personal_orders
      SET cancelDispatchState = 'DISPATCHED_UNKNOWN', updatedAt = ?
      WHERE idempotencyKey = ? AND status = 'processing'
        AND cancelRequestedAt IS NOT NULL AND cancelDispatchState = 'CLAIMED_NOT_DISPATCHED'`)
      .run(Date.now(), idempotencyKey);
    return result.changes === 1;
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
  const symbol = providerSymbol(row.symbol);
  return {
    idempotencyKey: String(row.idempotencyKey),
    requestFingerprint: String(row.requestFingerprint),
    clientOrderId: String(row.clientOrderId),
    providerOrderId: row.providerOrderId === null ? null : String(row.providerOrderId),
    category: row.category as "spot" | "linear",
    symbol,
    executionMode: row.executionMode === "test_gtc" ? "test_gtc" : "production_ioc",
    status: row.status as BinanceStoredOrder["status"],
    order: row.orderJson ? parseProviderOrder(JSON.parse(String(row.orderJson)), symbol) : null,
    error: row.error === null ? null : String(row.error),
    cancelRequestedAt: row.cancelRequestedAt === null ? null : Number(row.cancelRequestedAt),
    cancelDispatchState: cancelDispatchState(row.cancelDispatchState),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function cancelDispatchState(value: unknown): BinanceCancelDispatchState | null {
  if (value === null || value === undefined) return null;
  if (value === "CLAIMED_NOT_DISPATCHED" || value === "DISPATCHED_UNKNOWN"
    || value === "TERMINAL_CONFIRMED" || value === "LEGACY_UNKNOWN") return value;
  throw new Error("Stored Binance cancel dispatch state is invalid.");
}

function parseProviderOrder(value: unknown, persistedSymbol: string): BinanceProviderOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored Binance provider order is invalid.");
  }
  const order = value as Record<string, unknown>;
  if (Object.hasOwn(order, "symbol") && providerSymbol(order.symbol) !== persistedSymbol) {
    throw new Error("Stored Binance provider order symbol conflicts with its persisted symbol.");
  }
  const requestedQuantity = order.requestedQuantity ?? order.requestedQuantityXaut;
  const filledQuantity = order.filledQuantity ?? order.filledQuantityXaut;
  const requestedBaseQuantity = storedDecimalQuantity(
    order.requestedBaseQuantity,
    requestedQuantity,
    "requested base quantity",
  );
  const filledBaseQuantity = storedDecimalQuantity(
    order.filledBaseQuantity,
    filledQuantity,
    "filled base quantity",
  );
  const positionQuantity = order.positionQuantity ?? order.positionQuantityXaut;
  return {
    orderId: String(order.orderId ?? ""),
    orderLinkId: String(order.orderLinkId ?? ""),
    status: order.status as BinanceProviderOrder["status"],
    requestedQuantity: Number(requestedQuantity),
    filledQuantity: Number(filledQuantity),
    requestedBaseQuantity,
    filledBaseQuantity,
    ...(positionQuantity === undefined ? {} : { positionQuantity: Number(positionQuantity) }),
    averagePrice: order.averagePrice === null ? null : Number(order.averagePrice),
    feeUsd: Number(order.feeUsd),
    updatedAt: Number(order.updatedAt),
  };
}

function storedDecimalQuantity(exact: unknown, legacy: unknown, name: string) {
  if (typeof exact === "string") {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(exact)) {
      throw new Error(`Stored Binance ${name} is invalid.`);
    }
    return exact;
  }
  const numeric = Number(legacy);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`Stored Binance ${name} is invalid.`);
  }
  return legacyNumberToDecimal(numeric);
}

function legacyNumberToDecimal(value: number) {
  const text = String(value);
  if (!/[eE]/u.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [integer, fraction = ""] = coefficient!.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer!.length + exponent;
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function providerSymbol(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z0-9]{4,30}$/u.test(value)) {
    throw new Error("Stored Binance provider symbol is missing or invalid.");
  }
  return value;
}
