import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BinancePreflightSnapshot } from "./BinanceTypes";
import type { BinanceProviderOrder } from "./BinanceTypes";
import type { BinanceOrderExecutionMode } from "./BinanceTypes";
import { ManualReconciliationRequiredError } from "../cex/ManualReconciliationRequiredError";

export type BinanceStoredOrder = {
  idempotencyKey: string;
  requestFingerprint: string;
  clientOrderId: string;
  providerOrderId: string | null;
  category: "spot" | "linear";
  symbol: string;
  executionMode: BinanceOrderExecutionMode;
  positionMode?: "ONE_WAY" | "HEDGE";
  positionDirection?: "LONG" | "SHORT";
  positionSide?: "BOTH" | "LONG" | "SHORT";
  expectedSide?: "Buy" | "Sell";
  expectedBaseQuantity?: string;
  expectedReduceOnly?: boolean;
  status: "processing" | "completed" | "failed";
  order: BinanceProviderOrder | null;
  error: string | null;
  cancelRequestedAt: number | null;
  cancelDispatchState: BinanceCancelDispatchState | null;
  createdAt: number;
  updatedAt: number;
};

export type BinanceStoredOrderIsolation = {
  idempotencyKey: string;
  status: string;
  reason: string;
  manualReconciliationRequired: true;
};

export type BinanceStoredOrderCollection = {
  orders: BinanceStoredOrder[];
  isolatedOrders: BinanceStoredOrderIsolation[];
};

export type BinanceStoredOrderLookup =
  | { kind: "found"; order: BinanceStoredOrder }
  | { kind: "missing" }
  | { kind: "isolated"; isolation: BinanceStoredOrderIsolation };

export class BinanceStoredOrderManualReconciliationError extends ManualReconciliationRequiredError {
  constructor(readonly isolation: BinanceStoredOrderIsolation) {
    super(
      isolation.idempotencyKey,
      isolation.reason,
      `Binance stored order requires manual reconciliation: ${isolation.reason}`,
    );
  }
}

const storedOrderSelect = `idempotencyKey, requestFingerprint, clientOrderId, providerOrderId,
  category, symbol, executionMode, positionMode, positionDirection, positionSide,
  expectedSide, expectedBaseQuantity, expectedReduceOnly, status, orderJson, error,
  CAST(cancelRequestedAt AS TEXT) AS cancelRequestedAt, cancelDispatchState,
  CAST(createdAt AS TEXT) AS createdAt, CAST(updatedAt AS TEXT) AS updatedAt`;

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
        expectedSide TEXT,
        expectedBaseQuantity TEXT,
        expectedReduceOnly INTEGER,
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
    for (const column of ["positionMode", "positionDirection", "positionSide", "expectedSide", "expectedBaseQuantity"] as const) {
      if (!this.columnExists("binance_personal_orders", column)) {
        this.db.exec(`ALTER TABLE binance_personal_orders ADD COLUMN ${column} TEXT;`);
      }
    }
    if (!this.columnExists("binance_personal_orders", "expectedReduceOnly")) {
      this.db.exec("ALTER TABLE binance_personal_orders ADD COLUMN expectedReduceOnly INTEGER;");
    }
  }

  reserve(input: Omit<BinanceStoredOrder, "providerOrderId" | "status" | "order" | "error" | "cancelRequestedAt" | "cancelDispatchState" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    const symbol = providerSymbol(input.symbol);
    try {
      this.db.prepare(`INSERT INTO binance_personal_orders (
        idempotencyKey, requestFingerprint, clientOrderId, providerOrderId, category, symbol, executionMode, positionMode, positionDirection, positionSide,
        expectedSide, expectedBaseQuantity, expectedReduceOnly,
        status, orderJson, error, createdAt, updatedAt
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', NULL, NULL, ?, ?)`)
        .run(input.idempotencyKey, input.requestFingerprint, input.clientOrderId, input.category, symbol, input.executionMode,
          input.positionMode ?? null, input.positionDirection ?? null, input.positionSide ?? null,
          input.expectedSide ?? null, input.expectedBaseQuantity ?? null,
          input.expectedReduceOnly === undefined ? null : Number(input.expectedReduceOnly), now, now);
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
    const result = this.lookup(idempotencyKey);
    if (result.kind === "isolated") {
      throw new BinanceStoredOrderManualReconciliationError(result.isolation);
    }
    return result.kind === "found" ? result.order : null;
  }

  lookup(idempotencyKey: string): BinanceStoredOrderLookup {
    const row = this.db.prepare(`SELECT ${storedOrderSelect} FROM binance_personal_orders WHERE idempotencyKey = ?`)
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return { kind: "missing" };
    try {
      return { kind: "found", order: parseStoredOrder(row) };
    } catch (error) {
      return { kind: "isolated", isolation: isolateStoredOrder(row, error) };
    }
  }

  list(limit = 100) {
    return this.listWithIsolation(limit).orders;
  }

  listWithIsolation(limit = 100): BinanceStoredOrderCollection {
    return parseStoredOrderCollection(
      this.db.prepare(`SELECT ${storedOrderSelect} FROM binance_personal_orders ORDER BY createdAt DESC LIMIT ?`).all(limit) as Record<string, unknown>[],
    );
  }

  listAll() {
    return this.listAllWithIsolation().orders;
  }

  listAllWithIsolation(): BinanceStoredOrderCollection {
    return parseStoredOrderCollection(
      this.db.prepare(`SELECT ${storedOrderSelect} FROM binance_personal_orders ORDER BY createdAt DESC`).all() as Record<string, unknown>[],
    );
  }

  listProcessing() {
    return this.listProcessingWithIsolation().orders;
  }

  listProcessingWithIsolation(): BinanceStoredOrderCollection {
    return parseStoredOrderCollection(
      this.db.prepare(`SELECT ${storedOrderSelect} FROM binance_personal_orders WHERE status = 'processing' ORDER BY createdAt ASC`).all() as Record<string, unknown>[],
    );
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

function parseStoredOrderCollection(rows: Record<string, unknown>[]): BinanceStoredOrderCollection {
  const orders: BinanceStoredOrder[] = [];
  const isolatedOrders: BinanceStoredOrderIsolation[] = [];
  for (const row of rows) {
    try {
      orders.push(parseStoredOrder(row));
    } catch (error) {
      isolatedOrders.push(isolateStoredOrder(row, error));
    }
  }
  return { orders, isolatedOrders };
}

function isolateStoredOrder(row: Record<string, unknown>, error: unknown): BinanceStoredOrderIsolation {
  return {
    idempotencyKey: storedIsolationText(row.idempotencyKey),
    status: storedIsolationText(row.status),
    reason: error instanceof Error && error.message.startsWith("Stored Binance ")
      ? error.message
      : "Stored Binance order payload is malformed.",
    manualReconciliationRequired: true,
  };
}

function storedIsolationText(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : "UNKNOWN";
}

function parseStoredOrder(row: Record<string, unknown>): BinanceStoredOrder {
  const symbol = providerSymbol(row.symbol);
  const clientOrderId = storedClientOrderId(row.clientOrderId);
  const providerOrderId = row.providerOrderId === null
    ? null
    : storedProviderOrderId(row.providerOrderId);
  const order = row.orderJson === null
    ? null
    : parseProviderOrder(JSON.parse(String(row.orderJson)), symbol, clientOrderId);
  if (order !== null && providerOrderId === null) {
    throw new Error("Stored Binance providerOrderId column is missing for its provider order.");
  }
  if (providerOrderId !== null && order !== null && providerOrderId !== order.orderId) {
    throw new Error("Stored Binance provider order identity conflicts with its providerOrderId column.");
  }
  const status = storedOuterOrderStatus(row.status);
  assertStoredStatusCombination(status, order);
  return {
    idempotencyKey: String(row.idempotencyKey),
    requestFingerprint: String(row.requestFingerprint),
    clientOrderId,
    providerOrderId,
    category: row.category as "spot" | "linear",
    symbol,
    executionMode: storedExecutionMode(row.executionMode),
    ...(row.positionMode === null || row.positionMode === undefined ? {} : { positionMode: row.positionMode as "ONE_WAY" | "HEDGE" }),
    ...(row.positionDirection === null || row.positionDirection === undefined ? {} : { positionDirection: row.positionDirection as "LONG" | "SHORT" }),
    ...(row.positionSide === null || row.positionSide === undefined ? {} : { positionSide: row.positionSide as "BOTH" | "LONG" | "SHORT" }),
    ...(row.expectedSide === null || row.expectedSide === undefined ? {} : { expectedSide: row.expectedSide as "Buy" | "Sell" }),
    ...(row.expectedBaseQuantity === null || row.expectedBaseQuantity === undefined ? {} : { expectedBaseQuantity: String(row.expectedBaseQuantity) }),
    ...(row.expectedReduceOnly === null || row.expectedReduceOnly === undefined
      ? {}
      : { expectedReduceOnly: storedExpectedReduceOnly(row.expectedReduceOnly) }),
    status,
    order,
    error: row.error === null ? null : String(row.error),
    cancelRequestedAt: row.cancelRequestedAt === null ? null : storedTimestamp(row.cancelRequestedAt, "cancel requested timestamp"),
    cancelDispatchState: cancelDispatchState(row.cancelDispatchState),
    createdAt: storedTimestamp(row.createdAt, "created timestamp"),
    updatedAt: storedTimestamp(row.updatedAt, "updated timestamp"),
  };
}

function storedExpectedReduceOnly(value: unknown) {
  if (value === 0 || value === "0" || value === "0.0") return false;
  if (value === 1 || value === "1" || value === "1.0") return true;
  throw new Error("Stored Binance expectedReduceOnly is invalid.");
}

function cancelDispatchState(value: unknown): BinanceCancelDispatchState | null {
  if (value === null || value === undefined) return null;
  if (value === "CLAIMED_NOT_DISPATCHED" || value === "DISPATCHED_UNKNOWN"
    || value === "TERMINAL_CONFIRMED" || value === "LEGACY_UNKNOWN") return value;
  throw new Error("Stored Binance cancel dispatch state is invalid.");
}

function parseProviderOrder(value: unknown, persistedSymbol: string, persistedClientOrderId: string): BinanceProviderOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored Binance provider order is invalid.");
  }
  const order = value as Record<string, unknown>;
  const orderLinkId = storedClientOrderId(order.orderLinkId);
  if (orderLinkId !== persistedClientOrderId) {
    throw new Error("Stored Binance provider order clientOrderId conflicts with its persisted clientOrderId.");
  }
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
    symbol: persistedSymbol,
    orderId: storedProviderOrderId(order.orderId),
    orderLinkId,
    status: storedProviderOrderStatus(order.status),
    requestedQuantity: Number(requestedQuantity),
    filledQuantity: Number(filledQuantity),
    ...(order.side === undefined ? {} : order.side === "Buy" || order.side === "Sell"
      ? { side: order.side }
      : (() => { throw new Error("Stored Binance provider side is malformed."); })()),
    ...(order.reduceOnly === undefined ? {} : { reduceOnly: Boolean(order.reduceOnly) }),
    requestedBaseQuantity,
    filledBaseQuantity,
    ...(positionQuantity === undefined ? {} : { positionQuantity: Number(positionQuantity) }),
    averagePrice: order.averagePrice === null ? null : Number(order.averagePrice),
    feeUsd: Number(order.feeUsd),
    updatedAt: storedTimestamp(order.updatedAt, "provider order updated timestamp"),
  };
}

function storedClientOrderId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/-]{1,36}$/u.test(value)) {
    throw new Error("Stored Binance clientOrderId is invalid.");
  }
  return value;
}

function storedExecutionMode(value: unknown): BinanceOrderExecutionMode {
  if (value !== "production_ioc" && value !== "test_gtc") {
    throw new Error("Stored Binance execution mode is invalid.");
  }
  return value;
}

function storedOuterOrderStatus(value: unknown): BinanceStoredOrder["status"] {
  if (value !== "processing" && value !== "completed" && value !== "failed") {
    throw new Error("Stored Binance order status is invalid.");
  }
  return value;
}

function storedProviderOrderStatus(value: unknown): BinanceProviderOrder["status"] {
  if (value !== "New" && value !== "PartiallyFilled" && value !== "Filled"
    && value !== "Cancelled" && value !== "Rejected" && value !== "Expired" && value !== "Unknown") {
    throw new Error("Stored Binance provider order status is invalid.");
  }
  return value;
}

function storedTimestamp(value: unknown, name: string) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) {
    const exact = BigInt(value);
    if (exact <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(exact);
  }
  throw new Error(`Stored Binance ${name} is invalid.`);
}

function assertStoredStatusCombination(
  status: BinanceStoredOrder["status"],
  order: BinanceProviderOrder | null,
) {
  if (order === null) {
    if (status !== "completed") return;
  } else if (status === "completed" && order.status === "Filled") {
    return;
  } else if (status === "processing" && ["New", "PartiallyFilled", "Unknown"].includes(order.status)) {
    return;
  } else if (status === "failed" && ["Cancelled", "Rejected", "Expired"].includes(order.status)) {
    return;
  }
  throw new Error("Stored Binance outer and provider order statuses are inconsistent.");
}

function storedProviderOrderId(value: unknown) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error("Stored Binance provider orderId is invalid.");
  }
  return value;
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
