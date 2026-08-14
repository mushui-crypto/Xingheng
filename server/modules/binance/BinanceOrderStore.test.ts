import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BinanceOrderStore } from "./BinanceOrderStore";

test("fresh stores persist explicit generic symbols and recover them after restart", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-fresh-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    let store = new BinanceOrderStore(dbPath);
    for (const symbol of ["BTCUSDT", "ETHUSDT", "DOGEUSDT"]) {
      assert.deepEqual(store.reserve(orderReservation(symbol)), { kind: "reserved" });
    }
    store.close();

    store = new BinanceOrderStore(dbPath);
    assert.deepEqual(store.listAll().map((order) => order.symbol).sort(), ["BTCUSDT", "DOGEUSDT", "ETHUSDT"]);
    store.close();

    const db = new DatabaseSync(dbPath);
    const symbolColumn = (db.prepare("PRAGMA table_info(binance_personal_orders)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>).find((column) => column.name === "symbol");
    assert.equal(symbolColumn?.notnull, 1);
    assert.equal(symbolColumn?.dflt_value, null);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact Decimal base quantities survive order persistence and restart", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-decimal-fill-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    let store = new BinanceOrderStore(dbPath);
    store.reserve(orderReservation("BTCUSDT"));
    store.recordProcessingOrder("order-BTCUSDT", {
      orderId: "provider-decimal",
      orderLinkId: "client-BTCUSDT",
      status: "PartiallyFilled",
      requestedQuantity: 0.12345678901234568,
      filledQuantity: 0.02345678901234568,
      requestedBaseQuantity: "0.123456789012345678901",
      filledBaseQuantity: "0.023456789012345678901",
      averagePrice: null,
      feeUsd: 0,
      updatedAt: 3_000,
    });
    store.close();

    store = new BinanceOrderStore(dbPath);
    assert.equal(store.find("order-BTCUSDT")?.order?.requestedBaseQuantity, "0.123456789012345678901");
    assert.equal(store.find("order-BTCUSDT")?.order?.filledBaseQuantity, "0.023456789012345678901");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("known-order cancellation claim is durable and idempotent across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-cancel-claim-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    let store = new BinanceOrderStore(dbPath);
    store.reserve(orderReservation("BTCUSDT"));
    assert.equal(store.claimCancellation("order-BTCUSDT"), true);
    assert.equal(store.claimCancellation("order-BTCUSDT"), false);
    assert.ok(store.find("order-BTCUSDT")?.cancelRequestedAt);
    store.close();

    store = new BinanceOrderStore(dbPath);
    assert.equal(store.claimCancellation("order-BTCUSDT"), false);
    assert.ok(store.find("order-BTCUSDT")?.cancelRequestedAt);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy migration backfills only pre-migration XAUT orders and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-legacy-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    const legacyDb = new DatabaseSync(dbPath);
    createLegacyOrdersTable(legacyDb);
    legacyDb.prepare(`INSERT INTO binance_personal_orders (
      idempotencyKey, requestFingerprint, clientOrderId, providerOrderId, category,
      status, orderJson, error, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, 'spot', 'completed', ?, NULL, ?, ?)`)
      .run(
        "legacy-xaut",
        "legacy-fingerprint",
        "legacy-client",
        "legacy-provider",
        JSON.stringify({
          orderId: "legacy-provider",
          orderLinkId: "legacy-client",
          status: "Filled",
          requestedQuantityXaut: 0.01,
          filledQuantityXaut: 0.01,
          positionQuantityXaut: 0.01,
          averagePrice: 2_500,
          feeUsd: 0.1,
          updatedAt: 1_000,
        }),
        1_000,
        1_000,
      );
    legacyDb.close();

    let store = new BinanceOrderStore(dbPath);
    const migrated = store.find("legacy-xaut");
    assert.equal(migrated?.symbol, "XAUTUSDT");
    assert.equal(migrated?.executionMode, "production_ioc");
    assert.equal(migrated?.order?.requestedQuantity, 0.01);
    assert.equal(migrated?.order?.filledQuantity, 0.01);
    assert.equal(migrated?.order?.positionQuantity, 0.01);
    assert.equal(store.listAll().length, 1);
    store.close();

    store = new BinanceOrderStore(dbPath);
    assert.equal(store.find("legacy-xaut")?.symbol, "XAUTUSDT");
    assert.equal(store.listAll().length, 1);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records created after legacy migration fail closed when symbol metadata is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-missing-symbol-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    const legacyDb = new DatabaseSync(dbPath);
    createLegacyOrdersTable(legacyDb);
    legacyDb.close();

    const store = new BinanceOrderStore(dbPath);
    assert.throws(
      () => store.reserve({ ...orderReservation("BTCUSDT"), symbol: undefined as unknown as string }),
      /provider symbol is missing or invalid/u,
    );
    store.close();

    const migratedDb = new DatabaseSync(dbPath);
    migratedDb.prepare(`INSERT INTO binance_personal_orders (
      idempotencyKey, requestFingerprint, clientOrderId, providerOrderId, category, executionMode,
      status, orderJson, error, createdAt, updatedAt
    ) VALUES ('missing-symbol', 'fingerprint', 'client', NULL, 'spot', 'production_ioc',
      'processing', NULL, NULL, 2000, 2000)`)
      .run();
    migratedDb.close();

    const restarted = new BinanceOrderStore(dbPath);
    assert.throws(() => restarted.find("missing-symbol"), /provider symbol is missing or invalid/u);
    restarted.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted symbol is authoritative over an optional provider payload symbol", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-symbol-conflict-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    const store = new BinanceOrderStore(dbPath);
    store.reserve(orderReservation("BTCUSDT"));
    store.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE binance_personal_orders SET orderJson = ? WHERE idempotencyKey = ?")
      .run(JSON.stringify({
        symbol: "ETHUSDT",
        orderId: "provider",
        orderLinkId: "client-BTCUSDT",
        status: "Filled",
        requestedQuantity: 0.001,
        filledQuantity: 0.001,
        averagePrice: 100_000,
        feeUsd: 0.1,
        updatedAt: 3_000,
      }), "order-BTCUSDT");
    db.close();

    const restarted = new BinanceOrderStore(dbPath);
    assert.throws(() => restarted.find("order-BTCUSDT"), /symbol conflicts with its persisted symbol/u);
    restarted.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function orderReservation(symbol: string) {
  return {
    idempotencyKey: `order-${symbol}`,
    requestFingerprint: `fingerprint-${symbol}`,
    clientOrderId: `client-${symbol}`,
    category: (symbol === "DOGEUSDT" ? "linear" : "spot") as "spot" | "linear",
    symbol,
    executionMode: "production_ioc" as const,
  };
}

function createLegacyOrdersTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE binance_personal_orders (
      idempotencyKey TEXT PRIMARY KEY,
      requestFingerprint TEXT NOT NULL,
      clientOrderId TEXT NOT NULL UNIQUE,
      providerOrderId TEXT,
      category TEXT NOT NULL CHECK(category IN ('spot', 'linear')),
      status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
      orderJson TEXT,
      error TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
}
