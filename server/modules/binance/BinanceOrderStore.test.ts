import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BinanceClient } from "./BinanceClient";
import { BinanceOrderStore } from "./BinanceOrderStore";
import { assertBinanceProviderOrderIdentity } from "./BinanceProviderOrderIdentity";

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

test("legacy migration creates expectedReduceOnly with INTEGER affinity", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-reduce-only-migration-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    const legacyDb = new DatabaseSync(dbPath);
    createLegacyOrdersTable(legacyDb);
    legacyDb.close();

    new BinanceOrderStore(dbPath).close();

    const migratedDb = new DatabaseSync(dbPath);
    const column = (migratedDb.prepare("PRAGMA table_info(binance_personal_orders)").all() as Array<{
      name: string;
      type: string;
    }>).find((candidate) => candidate.name === "expectedReduceOnly");
    assert.equal(column?.type, "INTEGER");
    migratedDb.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy TEXT expectedReduceOnly decodes exact zero and one representations", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-reduce-only-text-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    const legacyDb = new DatabaseSync(dbPath);
    createLegacyExpectedReduceOnlyTextOrdersTable(legacyDb);
    legacyDb.close();
    new BinanceOrderStore(dbPath).close();

    const writableDb = new DatabaseSync(dbPath);
    const insert = writableDb.prepare(`INSERT INTO binance_personal_orders (
      idempotencyKey, requestFingerprint, clientOrderId, providerOrderId, category, symbol,
      executionMode, expectedReduceOnly, status, orderJson, error, createdAt, updatedAt
    ) VALUES (?, ?, ?, NULL, 'linear', 'DOGEUSDT', 'production_ioc', ?, 'processing', NULL, NULL, ?, ?)`);
    const fixtures = [
      { id: "number-zero", value: 0, expected: false },
      { id: "number-zero-decimal", value: 0.0, expected: false },
      { id: "text-zero", value: "0", expected: false },
      { id: "text-zero-decimal", value: "0.0", expected: false },
      { id: "number-one", value: 1, expected: true },
      { id: "number-one-decimal", value: 1.0, expected: true },
      { id: "text-one", value: "1", expected: true },
      { id: "text-one-decimal", value: "1.0", expected: true },
    ] as const;
    for (const [index, fixture] of fixtures.entries()) {
      insert.run(fixture.id, `${fixture.id}-fingerprint`, `${fixture.id}-client`, fixture.value, index + 1, index + 1);
    }
    writableDb.close();

    const store = new BinanceOrderStore(dbPath);
    for (const fixture of fixtures) {
      assert.equal(store.find(fixture.id)?.expectedReduceOnly, fixture.expected, fixture.id);
    }
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy expectedReduceOnly rejects invalid non-null values and preserves null as absent", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-reduce-only-invalid-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    const legacyDb = new DatabaseSync(dbPath);
    createLegacyExpectedReduceOnlyTextOrdersTable(legacyDb);
    legacyDb.close();
    new BinanceOrderStore(dbPath).close();

    const writableDb = new DatabaseSync(dbPath);
    const insert = writableDb.prepare(`INSERT INTO binance_personal_orders (
      idempotencyKey, requestFingerprint, clientOrderId, providerOrderId, category, symbol,
      executionMode, expectedReduceOnly, status, orderJson, error, createdAt, updatedAt
    ) VALUES (?, ?, ?, NULL, 'linear', 'DOGEUSDT', 'production_ioc', ?, 'processing', NULL, NULL, ?, ?)`);
    for (const [index, value] of ["false", "true", "abc", ""].entries()) {
      insert.run(`invalid-${index}`, `invalid-${index}-fingerprint`, `invalid-${index}-client`, value, index + 1, index + 1);
    }
    insert.run("missing", "missing-fingerprint", "missing-client", null, 10, 10);
    writableDb.close();

    const store = new BinanceOrderStore(dbPath);
    for (const index of [0, 1, 2, 3]) {
      assert.throws(
        () => store.find(`invalid-${index}`),
        /Stored Binance expectedReduceOnly is invalid/u,
      );
    }
    const missing = store.find("missing");
    assert.equal(missing && Object.hasOwn(missing, "expectedReduceOnly"), false);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy migration preserves ONE_WAY opening and CLOSE_ONLY reduceOnly semantics after restart", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-reduce-only-restart-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    const legacyDb = new DatabaseSync(dbPath);
    createLegacyOrdersTable(legacyDb);
    legacyDb.close();

    let store = new BinanceOrderStore(dbPath);
    store.reserve(reduceOnlyReservation("opening", false));
    store.reserve(reduceOnlyReservation("closing", true));
    store.close();

    const rawDb = new DatabaseSync(dbPath);
    const rows = rawDb.prepare(`SELECT idempotencyKey, expectedReduceOnly, typeof(expectedReduceOnly) AS storageType
      FROM binance_personal_orders ORDER BY idempotencyKey`).all() as Array<{
        idempotencyKey: string;
        expectedReduceOnly: number;
        storageType: string;
      }>;
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { idempotencyKey: "closing", expectedReduceOnly: 1, storageType: "integer" },
      { idempotencyKey: "opening", expectedReduceOnly: 0, storageType: "integer" },
    ]);
    rawDb.close();

    store = new BinanceOrderStore(dbPath);
    const opening = store.find("opening")!;
    const closing = store.find("closing")!;
    assert.equal(opening.expectedReduceOnly, false);
    assert.equal(closing.expectedReduceOnly, true);
    assert.doesNotThrow(() => assertBinanceProviderOrderIdentity(
      providerReduceOnlyOrder("opening-client", "7001", "Sell", false),
      { symbol: "DOGEUSDT", clientOrderId: "opening-client", reduceOnly: opening.expectedReduceOnly },
    ));
    assert.doesNotThrow(() => assertBinanceProviderOrderIdentity(
      providerReduceOnlyOrder("closing-client", "7002", "Buy", true),
      { symbol: "DOGEUSDT", clientOrderId: "closing-client", reduceOnly: closing.expectedReduceOnly },
    ));
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh stores persist expectedReduceOnly as exact integer zero and one", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-reduce-only-fresh-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    let store = new BinanceOrderStore(dbPath);
    store.reserve(reduceOnlyReservation("fresh-opening", false));
    store.reserve(reduceOnlyReservation("fresh-closing", true));
    store.close();

    store = new BinanceOrderStore(dbPath);
    assert.equal(store.find("fresh-opening")?.expectedReduceOnly, false);
    assert.equal(store.find("fresh-closing")?.expectedReduceOnly, true);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Binance order recovery persists resolved HEDGE bucket semantics", () => {
  const directory = mkdtempSync(join(tmpdir(), "stellax-binance-hedge-recovery-"));
  const dbPath = join(directory, "trading.sqlite");
  try {
    const store = new BinanceOrderStore(dbPath);
    store.reserve({
      idempotencyKey: "hedge-recovery",
      requestFingerprint: "hedge-fingerprint",
      clientOrderId: "sx-hedge-recovery",
      category: "linear",
      symbol: "DOGEUSDT",
      executionMode: "production_ioc",
      positionMode: "HEDGE",
      positionDirection: "SHORT",
      positionSide: "SHORT",
    });
    assert.equal(store.find("hedge-recovery")?.positionMode, "HEDGE");
    assert.equal(store.find("hedge-recovery")?.positionSide, "SHORT");
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exact Decimal quantities and int64 provider orderId survive persistence and restart", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-decimal-fill-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    let store = new BinanceOrderStore(dbPath);
    store.reserve(orderReservation("BTCUSDT"));
    store.recordProcessingOrder("order-BTCUSDT", {
      symbol: "BTCUSDT",
      orderId: "9223372036854775807",
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
    assert.equal(store.find("order-BTCUSDT")?.providerOrderId, "9223372036854775807");
    assert.equal(store.find("order-BTCUSDT")?.order?.orderId, "9223372036854775807");
    assert.equal(store.find("order-BTCUSDT")?.order?.requestedBaseQuantity, "0.123456789012345678901");
    assert.equal(store.find("order-BTCUSDT")?.order?.filledBaseQuantity, "0.023456789012345678901");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart rejects numeric orderJson identities before any rounded provider identity can escape", () => {
  for (const rawOrderId of ["123456", "9223372036854775807"]) {
    const root = mkdtempSync(join(tmpdir(), "binance-order-store-numeric-identity-"));
    const dbPath = join(root, "orders.sqlite");
    try {
      const store = new BinanceOrderStore(dbPath);
      store.reserve(orderReservation("BTCUSDT"));
      store.close();

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE binance_personal_orders SET providerOrderId = ?, orderJson = ? WHERE idempotencyKey = ?")
        .run(rawOrderId, persistedOrderJson(rawOrderId), "order-BTCUSDT");
      db.close();

      const restarted = new BinanceOrderStore(dbPath);
      assert.throws(() => restarted.find("order-BTCUSDT"), /provider orderId is invalid/u);
      restarted.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("collection reads isolate one numeric identity while returning two valid processing orders", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-isolation-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    let store = new BinanceOrderStore(dbPath);
    for (const symbol of ["ETHUSDT", "DOGEUSDT", "BTCUSDT"]) {
      assert.deepEqual(store.reserve(orderReservation(symbol)), { kind: "reserved" });
    }
    store.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE binance_personal_orders SET providerOrderId = ?, orderJson = ? WHERE idempotencyKey = ?")
      .run("9223372036854775807", persistedOrderJson("9223372036854775807"), "order-BTCUSDT");
    db.close();

    store = new BinanceOrderStore(dbPath);
    const expected = ["order-DOGEUSDT", "order-ETHUSDT"];
    assert.deepEqual(store.listProcessing().map((order) => order.idempotencyKey).sort(), expected);
    assert.deepEqual(store.listAll().map((order) => order.idempotencyKey).sort(), expected);
    assert.deepEqual(store.list().map((order) => order.idempotencyKey).sort(), expected);
    const collection = store.listProcessingWithIsolation();
    assert.deepEqual(collection.orders.map((order) => order.idempotencyKey).sort(), expected);
    assert.deepEqual(collection.isolatedOrders, [{
      idempotencyKey: "order-BTCUSDT",
      status: "processing",
      reason: "Stored Binance provider orderId is invalid.",
      manualReconciliationRequired: true,
    }]);
    assert.throws(() => store.find("order-BTCUSDT"), /provider orderId is invalid/u);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted order validation isolates identity, mode, status, and timestamp corruption", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-complete-validation-"));
  const dbPath = join(root, "orders.sqlite");
  const malformedIds = [
    "client-conflict", "provider-missing", "provider-conflict", "execution-mode",
    "outer-status", "nested-status", "outer-timestamp", "nested-timestamp", "empty-order-json",
    "status-combination",
  ];
  try {
    let store = new BinanceOrderStore(dbPath);
    for (const [index, id] of ["valid-one", "valid-two", ...malformedIds].entries()) {
      const clientOrderId = `validation-${index}`;
      store.reserve({
        idempotencyKey: id, requestFingerprint: `${id}-fingerprint`, clientOrderId,
        category: "spot", symbol: "BTCUSDT", executionMode: "production_ioc",
      });
      store.recordProcessingOrder(id, persistedProviderOrder(clientOrderId, String(7_000 + index)));
    }
    store.close();

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA ignore_check_constraints = ON;");
    mutateStoredProviderOrder(db, "client-conflict", (order) => ({ ...order, orderLinkId: "wrong-client" }));
    db.prepare("UPDATE binance_personal_orders SET providerOrderId = NULL WHERE idempotencyKey = 'provider-missing'").run();
    db.prepare("UPDATE binance_personal_orders SET providerOrderId = '7999' WHERE idempotencyKey = 'provider-conflict'").run();
    db.prepare("UPDATE binance_personal_orders SET executionMode = 'invalid-mode' WHERE idempotencyKey = 'execution-mode'").run();
    db.prepare("UPDATE binance_personal_orders SET status = 'invalid-status' WHERE idempotencyKey = 'outer-status'").run();
    mutateStoredProviderOrder(db, "nested-status", (order) => ({ ...order, status: "INVALID" }));
    db.prepare("UPDATE binance_personal_orders SET updatedAt = -1 WHERE idempotencyKey = 'outer-timestamp'").run();
    mutateStoredProviderOrder(db, "nested-timestamp", (order) => ({ ...order, updatedAt: -1 }));
    db.prepare("UPDATE binance_personal_orders SET orderJson = '' WHERE idempotencyKey = 'empty-order-json'").run();
    mutateStoredProviderOrder(db, "status-combination", (order) => ({ ...order, status: "Filled" }));
    db.close();

    store = new BinanceOrderStore(dbPath);
    const all = store.listAllWithIsolation();
    assert.deepEqual(all.orders.map((order) => order.idempotencyKey).sort(), ["valid-one", "valid-two"]);
    assert.deepEqual(all.isolatedOrders.map((order) => order.idempotencyKey).sort(), [...malformedIds].sort());
    assert.equal(all.isolatedOrders.every((order) => order.manualReconciliationRequired), true);
    assert.deepEqual(
      store.listProcessing().map((order) => order.idempotencyKey).sort(),
      ["valid-one", "valid-two"],
    );
    for (const id of malformedIds) {
      assert.equal(store.lookup(id).kind, "isolated");
      assert.throws(() => store.find(id), /requires manual reconciliation/u);
    }
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe SQLite INTEGER timestamp is isolated without blocking valid records", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-unsafe-timestamp-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    let store = new BinanceOrderStore(dbPath);
    for (const id of ["normal-one", "unsafe-created", "unsafe-updated", "unsafe-cancel", "normal-two"]) {
      store.reserve({
        idempotencyKey: id, requestFingerprint: `${id}-fingerprint`, clientOrderId: `${id}-client`,
        category: "spot", symbol: "BTCUSDT", executionMode: "production_ioc",
      });
    }
    store.close();

    const db = new DatabaseSync(dbPath);
    const unsafe = 9_223_372_036_854_775_807n;
    db.prepare("UPDATE binance_personal_orders SET createdAt = ? WHERE idempotencyKey = 'unsafe-created'").run(unsafe);
    db.prepare("UPDATE binance_personal_orders SET updatedAt = ? WHERE idempotencyKey = 'unsafe-updated'").run(unsafe);
    db.prepare("UPDATE binance_personal_orders SET cancelRequestedAt = ? WHERE idempotencyKey = 'unsafe-cancel'").run(unsafe);
    db.close();

    store = new BinanceOrderStore(dbPath);
    assert.deepEqual(
      store.listProcessing().map((order) => order.idempotencyKey).sort(),
      ["normal-one", "normal-two"],
    );
    for (const id of ["unsafe-created", "unsafe-updated", "unsafe-cancel"]) {
      const exact = store.lookup(id);
      assert.equal(exact.kind, "isolated");
      assert.match(exact.kind === "isolated" ? exact.isolation.reason : "", /timestamp is invalid/u);
      assert.throws(() => store.find(id), /requires manual reconciliation/u);
    }
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted status matrix matches every formal Store write method", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-status-matrix-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    const store = new BinanceOrderStore(dbPath);
    const reserve = (id: string) => store.reserve({
      idempotencyKey: id, requestFingerprint: `${id}-fingerprint`, clientOrderId: `${id}-client`,
      category: "spot", symbol: "BTCUSDT", executionMode: "production_ioc",
    });
    reserve("reserved");
    reserve("provider-only");
    store.recordProviderOrder("provider-only", "8100");
    for (const [index, status] of ["New", "PartiallyFilled", "Unknown"].entries()) {
      const id = `processing-${status}`;
      reserve(id);
      store.recordProcessingOrder(id, { ...persistedProviderOrder(`${id}-client`, String(8_101 + index)), status: status as "New" | "PartiallyFilled" | "Unknown" });
    }
    reserve("completed");
    store.complete("completed", { ...persistedProviderOrder("completed-client", "8110"), status: "Filled" });
    reserve("failed-without-order");
    store.fail("failed-without-order", "pre-provider failure");
    for (const [index, status] of ["Cancelled", "Rejected", "Expired"].entries()) {
      const id = `failed-${status}`;
      reserve(id);
      store.failWithOrder(id, { ...persistedProviderOrder(`${id}-client`, String(8_111 + index)), status: status as "Cancelled" | "Rejected" | "Expired" }, status);
    }

    const state = store.listAllWithIsolation();
    assert.equal(state.orders.length, 10);
    assert.deepEqual(state.isolatedOrders, []);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact-key lookup recovers the oldest order beyond the 100-row collection window", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-exact-key-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    let store = new BinanceOrderStore(dbPath);
    for (let index = 0; index < 102; index += 1) {
      store.reserve({
        idempotencyKey: `exact-${index}`, requestFingerprint: `fingerprint-${index}`,
        clientOrderId: `exact-client-${index}`, category: "spot", symbol: "BTCUSDT",
        executionMode: "production_ioc",
      });
    }
    store.close();

    const db = new DatabaseSync(dbPath);
    for (let index = 0; index < 102; index += 1) {
      db.prepare("UPDATE binance_personal_orders SET createdAt = ?, updatedAt = ? WHERE idempotencyKey = ?")
        .run(index + 1, index + 1, `exact-${index}`);
    }
    db.close();

    store = new BinanceOrderStore(dbPath);
    assert.equal(store.list(100).some((order) => order.idempotencyKey === "exact-0"), false);
    const exact = store.lookup("exact-0");
    assert.equal(exact.kind, "found");
    assert.equal(exact.kind === "found" ? exact.order.clientOrderId : null, "exact-client-0");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart rejects mismatched providerOrderId column and orderJson exact strings", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-identity-conflict-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    const store = new BinanceOrderStore(dbPath);
    store.reserve(orderReservation("BTCUSDT"));
    store.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE binance_personal_orders SET providerOrderId = ?, orderJson = ? WHERE idempotencyKey = ?")
      .run("9223372036854775807", persistedOrderJson("\"9223372036854775806\""), "order-BTCUSDT");
    db.close();

    const restarted = new BinanceOrderStore(dbPath);
    assert.throws(() => restarted.find("order-BTCUSDT"), /identity conflicts with its providerOrderId column/u);
    restarted.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw int64 identity survives parsing, persistence, restart, and exact cancel targeting", async () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-lossless-restart-"));
  const dbPath = join(root, "orders.sqlite");
  const exactOrderId = "9223372036854775807";
  const cancelledOrderIds: string[] = [];
  const client = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return rawJsonResponse('{"serverTime":1800000000000}');
      if (init?.method === "DELETE") {
        cancelledOrderIds.push(url.searchParams.get("orderId") ?? "");
        return rawJsonResponse("{}");
      }
      return rawJsonResponse(`{"symbol":"BTCUSDT","side":"BUY","orderId":${exactOrderId},"clientOrderId":"ptmrestartlossless","status":"NEW","origQty":"0.001","executedQty":"0"}`);
    }) as typeof fetch,
    () => 1_800_000_000_000,
    ["203.0.113.10"],
  );
  try {
    const accepted = await client.placeOrder({
      category: "spot", symbol: "BTCUSDT", side: "Buy", quantity: "0.001",
      limitPrice: "1000", reduceOnly: false, orderLinkId: "ptmrestartlossless",
    });
    let store = new BinanceOrderStore(dbPath);
    store.reserve({
      idempotencyKey: "lossless-restart", requestFingerprint: "fingerprint",
      clientOrderId: accepted.orderLinkId, category: "spot", symbol: "BTCUSDT",
      executionMode: "production_ioc",
    });
    store.recordProcessingOrder("lossless-restart", {
      symbol: "BTCUSDT", orderId: accepted.orderId, orderLinkId: accepted.orderLinkId,
      status: "New", requestedQuantity: 0.001, filledQuantity: 0,
      requestedBaseQuantity: "0.001", filledBaseQuantity: "0",
      averagePrice: null, feeUsd: 0, updatedAt: 1_800_000_000_000,
    });
    store.close();

    store = new BinanceOrderStore(dbPath);
    const restarted = store.find("lossless-restart");
    assert.equal(restarted?.providerOrderId, exactOrderId);
    assert.equal(restarted?.order?.orderId, exactOrderId);
    const queried = await client.findOrderByClientOrderId("spot", "BTCUSDT", restarted!.clientOrderId);
    assert.equal(queried?.orderId, exactOrderId);
    await client.cancelOrder("spot", "BTCUSDT", restarted!.providerOrderId!);
    assert.deepEqual(cancelledOrderIds, [exactOrderId]);
    assert.equal(cancelledOrderIds.includes("9223372036854776000"), false);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("known-order cancellation claim and dispatch evidence are durable across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-cancel-claim-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    let store = new BinanceOrderStore(dbPath);
    store.reserve(orderReservation("BTCUSDT"));
    assert.equal(store.claimCancellation("order-BTCUSDT"), true);
    assert.equal(store.claimCancellation("order-BTCUSDT"), false);
    assert.ok(store.find("order-BTCUSDT")?.cancelRequestedAt);
    assert.equal(store.find("order-BTCUSDT")?.cancelDispatchState, "CLAIMED_NOT_DISPATCHED");
    store.close();

    store = new BinanceOrderStore(dbPath);
    assert.equal(store.claimCancellation("order-BTCUSDT"), false);
    assert.ok(store.find("order-BTCUSDT")?.cancelRequestedAt);
    assert.equal(store.find("order-BTCUSDT")?.cancelDispatchState, "CLAIMED_NOT_DISPATCHED");
    assert.equal(store.markCancellationDispatched("order-BTCUSDT"), true);
    assert.equal(store.markCancellationDispatched("order-BTCUSDT"), false);
    assert.equal(store.find("order-BTCUSDT")?.cancelDispatchState, "DISPATCHED_UNKNOWN");
    store.close();

    store = new BinanceOrderStore(dbPath);
    assert.equal(store.find("order-BTCUSDT")?.cancelDispatchState, "DISPATCHED_UNKNOWN");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal provider evidence closes a claimed cancellation without losing history", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-cancel-terminal-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    const store = new BinanceOrderStore(dbPath);
    store.reserve(orderReservation("BTCUSDT"));
    store.claimCancellation("order-BTCUSDT");
    store.markCancellationDispatched("order-BTCUSDT");
    store.failWithOrder("order-BTCUSDT", {
      symbol: "BTCUSDT",
      orderId: "5002",
      orderLinkId: "client-BTCUSDT",
      status: "Cancelled",
      requestedQuantity: 0.001,
      filledQuantity: 0.0004,
      requestedBaseQuantity: "0.001",
      filledBaseQuantity: "0.0004",
      averagePrice: null,
      feeUsd: 0,
      updatedAt: 3_000,
    }, "cancelled");
    const terminal = store.find("order-BTCUSDT");
    assert.equal(terminal?.cancelDispatchState, "TERMINAL_CONFIRMED");
    assert.equal(terminal?.order?.filledBaseQuantity, "0.0004");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-dispatch-model cancel claims migrate as legacy ambiguous and remain fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "binance-order-store-legacy-cancel-"));
  const dbPath = join(root, "orders.sqlite");
  try {
    const db = new DatabaseSync(dbPath);
    createPreDispatchStateOrdersTable(db);
    db.prepare(`INSERT INTO binance_personal_orders (
      idempotencyKey, requestFingerprint, clientOrderId, providerOrderId, category, symbol,
      executionMode, status, orderJson, error, cancelRequestedAt, createdAt, updatedAt
    ) VALUES ('legacy-cancel', 'fingerprint', 'client', '5001', 'spot', 'BTCUSDT',
      'production_ioc', 'processing', NULL, NULL, 1500, 1000, 1500)`).run();
    db.close();

    let store = new BinanceOrderStore(dbPath);
    assert.equal(store.find("legacy-cancel")?.cancelDispatchState, "LEGACY_UNKNOWN");
    assert.equal(store.claimCancellation("legacy-cancel"), false);
    assert.equal(store.markCancellationDispatched("legacy-cancel"), false);
    store.close();

    store = new BinanceOrderStore(dbPath);
    assert.equal(store.find("legacy-cancel")?.cancelDispatchState, "LEGACY_UNKNOWN");
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
        "5003",
        JSON.stringify({
          orderId: "5003",
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
        orderId: "5004",
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

function reduceOnlyReservation(idempotencyKey: string, expectedReduceOnly: boolean) {
  return {
    idempotencyKey,
    requestFingerprint: `${idempotencyKey}-fingerprint`,
    clientOrderId: `${idempotencyKey}-client`,
    category: "linear" as const,
    symbol: "DOGEUSDT",
    executionMode: "production_ioc" as const,
    positionMode: "ONE_WAY" as const,
    positionDirection: "SHORT" as const,
    expectedSide: expectedReduceOnly ? "Buy" as const : "Sell" as const,
    expectedBaseQuantity: "59",
    expectedReduceOnly,
  };
}

function providerReduceOnlyOrder(
  clientOrderId: string,
  orderId: string,
  side: "Buy" | "Sell",
  reduceOnly: boolean,
) {
  return {
    symbol: "DOGEUSDT",
    orderId,
    orderLinkId: clientOrderId,
    status: "Filled" as const,
    requestedQuantity: 59,
    filledQuantity: 59,
    side,
    reduceOnly,
    positionSide: "BOTH" as const,
    requestedBaseQuantity: "59",
    filledBaseQuantity: "59",
    averagePrice: 0.088,
    feeUsd: 0,
    updatedAt: 3_000,
  };
}

function persistedOrderJson(rawOrderId: string) {
  return `{"symbol":"BTCUSDT","orderId":${rawOrderId},"orderLinkId":"client-BTCUSDT","status":"New","requestedQuantity":0.001,"filledQuantity":0,"requestedBaseQuantity":"0.001","filledBaseQuantity":"0","averagePrice":null,"feeUsd":0,"updatedAt":3000}`;
}

function persistedProviderOrder(clientOrderId: string, orderId: string) {
  return {
    symbol: "BTCUSDT",
    orderId,
    orderLinkId: clientOrderId,
    status: "New" as const,
    requestedQuantity: 0.001,
    filledQuantity: 0,
    requestedBaseQuantity: "0.001",
    filledBaseQuantity: "0",
    averagePrice: null,
    feeUsd: 0,
    updatedAt: 3_000,
  };
}

function mutateStoredProviderOrder(
  db: DatabaseSync,
  idempotencyKey: string,
  mutate: (order: Record<string, unknown>) => Record<string, unknown>,
) {
  const row = db.prepare("SELECT orderJson FROM binance_personal_orders WHERE idempotencyKey = ?")
    .get(idempotencyKey) as { orderJson: string };
  db.prepare("UPDATE binance_personal_orders SET orderJson = ? WHERE idempotencyKey = ?")
    .run(JSON.stringify(mutate(JSON.parse(row.orderJson) as Record<string, unknown>)), idempotencyKey);
}

function rawJsonResponse(rawBody: string) {
  return new Response(rawBody, { status: 200, headers: { "Content-Type": "application/json" } });
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

function createPreDispatchStateOrdersTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE binance_personal_orders (
      idempotencyKey TEXT PRIMARY KEY,
      requestFingerprint TEXT NOT NULL,
      clientOrderId TEXT NOT NULL UNIQUE,
      providerOrderId TEXT,
      category TEXT NOT NULL CHECK(category IN ('spot', 'linear')),
      symbol TEXT,
      executionMode TEXT NOT NULL DEFAULT 'production_ioc',
      status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
      orderJson TEXT,
      error TEXT,
      cancelRequestedAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
}

function createLegacyExpectedReduceOnlyTextOrdersTable(db: DatabaseSync) {
  createPreDispatchStateOrdersTable(db);
  db.exec("ALTER TABLE binance_personal_orders ADD COLUMN expectedReduceOnly TEXT;");
}
