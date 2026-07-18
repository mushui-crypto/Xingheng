import assert from "node:assert/strict";
import test from "node:test";
import {
  extractExchangeOrderUpdates,
  initialRealTradingRealtimeState,
  normalizeRealTradingConnectionStatus,
  normalizeRealTradingOrderStatus,
  realTradingOrderStatusLabel,
  realTradingRealtimeReducer,
} from "./realtimeState";

test("connection reducer covers connected, stale, disconnected and reconnecting", () => {
  const connected = realTradingRealtimeReducer(initialRealTradingRealtimeState, { type: "heartbeat", at: 1_000 });
  const stale = realTradingRealtimeReducer(connected, { type: "heartbeat_timeout", at: 12_001, staleAfterMs: 10_000 });
  const disconnected = realTradingRealtimeReducer(stale, { type: "connection_failed" });
  const reconnecting = realTradingRealtimeReducer(disconnected, { type: "retry_requested" });

  assert.equal(connected.connectionStatus, "connected");
  assert.equal(stale.connectionStatus, "stale");
  assert.equal(disconnected.connectionStatus, "disconnected");
  assert.equal(reconnecting.connectionStatus, "reconnecting");
});

test("normalizes legacy and future backend status spellings", () => {
  assert.equal(normalizeRealTradingConnectionStatus("LIVE"), "connected");
  assert.equal(normalizeRealTradingConnectionStatus("recovering"), "reconnecting");
  assert.equal(normalizeRealTradingOrderStatus("partially-filled"), "partial");
  assert.equal(normalizeRealTradingOrderStatus("canceled"), "cancelled");
  assert.equal(normalizeRealTradingOrderStatus("needs_reconciliation"), "pending_reconciliation");
  assert.equal(realTradingOrderStatusLabel("pending_reconciliation"), "待交易所对账");
});

test("pending reconciliation is not misclassified as rejected or terminal", () => {
  const submitted = realTradingRealtimeReducer(initialRealTradingRealtimeState, {
    type: "order_submitted",
    order: { clientOrderId: "0x00112233445566778899aabbccddeeff", status: "submitted", updatedAt: 100 },
  });
  const reconciling = realTradingRealtimeReducer(submitted, {
    type: "order_updated",
    order: { clientOrderId: "0x00112233445566778899aabbccddeeff", status: "pending_reconciliation", updatedAt: 101 },
  });
  assert.equal(reconciling.orders[0].status, "pending_reconciliation");
  assert.notEqual(reconciling.orders[0].status, "rejected");
});

test("order reducer advances through pending and final states without regressing", () => {
  const submitted = realTradingRealtimeReducer(initialRealTradingRealtimeState, {
    type: "order_submitted",
    order: { clientOrderId: "client-1", status: "submitted", symbol: "BTCUSDT", updatedAt: 100 },
  });
  const accepted = realTradingRealtimeReducer(submitted, {
    type: "order_updated",
    order: { clientOrderId: "client-1", exchangeOrderId: "42", status: "accepted", symbol: "BTCUSDT", updatedAt: 101 },
  });
  const filled = realTradingRealtimeReducer(accepted, {
    type: "order_updated",
    order: { clientOrderId: "client-1", exchangeOrderId: "42", status: "filled", symbol: "BTCUSDT", updatedAt: 102 },
  });
  const latePartial = realTradingRealtimeReducer(filled, {
    type: "order_updated",
    order: { clientOrderId: "client-1", exchangeOrderId: "42", status: "partial", symbol: "BTCUSDT", updatedAt: 103 },
  });

  assert.equal(submitted.orders[0].status, "submitted");
  assert.equal(accepted.orders[0].status, "accepted");
  assert.equal(filled.orders[0].status, "filled");
  assert.equal(latePartial.orders[0].status, "filled");
});

test("authoritative snapshot recovery withdraws old lifecycle state before replacement", () => {
  const submitted = realTradingRealtimeReducer(initialRealTradingRealtimeState, {
    type: "order_submitted",
    order: { clientOrderId: "old", status: "submitted", updatedAt: 100 },
  });
  const loading = realTradingRealtimeReducer(submitted, { type: "snapshot_started" });
  const recovered = realTradingRealtimeReducer(loading, {
    type: "snapshot_succeeded",
    orders: [{ clientOrderId: "snapshot:42", exchangeOrderId: "42", status: "filled", updatedAt: 200 }],
  });

  assert.deepEqual(loading.orders, []);
  assert.equal(loading.snapshotLoading, true);
  assert.deepEqual(recovered.orders.map((item) => item.status), ["filled"]);
});

test("pending reconciliation survives unrelated snapshots and resolves only when the same cloid is authoritative", () => {
  const cloid = "0x00112233445566778899aabbccddeeff";
  const pending = realTradingRealtimeReducer(initialRealTradingRealtimeState, {
    type: "order_submitted",
    order: { clientOrderId: cloid, status: "pending_reconciliation", updatedAt: 100 },
  });
  const loading = realTradingRealtimeReducer(pending, { type: "snapshot_started" });
  const unrelated = realTradingRealtimeReducer(loading, {
    type: "snapshot_succeeded",
    orders: [{ clientOrderId: "other", status: "filled", updatedAt: 200 }],
  });
  const resolved = realTradingRealtimeReducer(unrelated, {
    type: "snapshot_succeeded",
    orders: [{ clientOrderId: cloid, exchangeOrderId: "42", status: "accepted", updatedAt: 300 }],
  });

  assert.equal(loading.orders[0].status, "pending_reconciliation");
  assert.ok(unrelated.orders.some((order) => order.clientOrderId === cloid && order.status === "pending_reconciliation"));
  assert.equal(resolved.orders.find((order) => order.clientOrderId === cloid)?.status, "accepted");
});

test("a failed recovery snapshot keeps pending reconciliation but removes non-authoritative lifecycle rows", () => {
  const pending = realTradingRealtimeReducer(initialRealTradingRealtimeState, {
    type: "order_submitted",
    order: { clientOrderId: "pending", operationKey: "order:BTCUSDT:entry", status: "pending_reconciliation", updatedAt: 100 },
  });
  const withAccepted = realTradingRealtimeReducer(pending, {
    type: "order_submitted",
    order: { clientOrderId: "accepted", status: "accepted", updatedAt: 101 },
  });
  const failed = realTradingRealtimeReducer(withAccepted, { type: "snapshot_failed", message: "offline" });
  assert.deepEqual(failed.orders.map((order) => order.clientOrderId), ["pending"]);
  assert.equal(failed.orders[0].operationKey, "order:BTCUSDT:entry");
});

test("extracts accepted, partial, filled and rejected statuses from exchange responses", () => {
  const fallback = { clientOrderId: "client-1", symbol: "BTCUSDT", updatedAt: 100 };
  const accepted = extractExchangeOrderUpdates({ response: { data: { statuses: [{ resting: { oid: 1 } }] } } }, fallback);
  const partial = extractExchangeOrderUpdates({ response: { data: { statuses: [{ filled: { oid: 2, sz: "1", totalSz: "2" } }] } } }, fallback);
  const filled = extractExchangeOrderUpdates({ response: { data: { statuses: [{ filled: { oid: 3, sz: "2", totalSz: "2" } }] } } }, fallback);
  const rejected = extractExchangeOrderUpdates({ response: { data: { statuses: [{ error: "risk limit" }] } } }, fallback);

  assert.deepEqual([accepted[0].status, partial[0].status, filled[0].status, rejected[0].status], ["accepted", "partial", "filled", "rejected"]);
  assert.equal(rejected[0].message, "risk limit");
});

test("frozen receipt fields drive lifecycle when raw provider statuses are absent", () => {
  const cloid = "0x00112233445566778899aabbccddeeff";
  const [update] = extractExchangeOrderUpdates({
    result: { status: "ok" },
    stellaxReceipt: { cloids: [cloid], orderState: "partial", requestId: "request-123", timestamp: 123 },
  }, { clientOrderId: "fallback", symbol: "BTCUSDT", updatedAt: 100 });
  assert.deepEqual(update, {
    clientOrderId: cloid,
    requestId: "request-123",
    status: "partial",
    symbol: "BTCUSDT",
    updatedAt: 123_000,
  });
});

test("newer authoritative terminal timestamp wins and older terminal events cannot overwrite it", () => {
  const filled = realTradingRealtimeReducer(initialRealTradingRealtimeState, {
    type: "snapshot_succeeded",
    orders: [{ clientOrderId: "same", status: "filled", updatedAt: 200 }],
  });
  const older = realTradingRealtimeReducer(filled, {
    type: "order_updated",
    order: { clientOrderId: "same", status: "cancelled", updatedAt: 199 },
  });
  const newer = realTradingRealtimeReducer(filled, {
    type: "order_updated",
    order: { clientOrderId: "same", status: "cancelled", updatedAt: 201 },
  });
  assert.equal(older.orders[0].status, "filled");
  assert.equal(newer.orders[0].status, "cancelled");

  const snapshot = realTradingRealtimeReducer(initialRealTradingRealtimeState, {
    type: "snapshot_succeeded",
    orders: [
      { clientOrderId: "same", status: "filled", updatedAt: 200 },
      { clientOrderId: "same", status: "cancelled", updatedAt: 201 },
    ],
  });
  assert.deepEqual(snapshot.orders.map((order) => order.status), ["cancelled"]);
});
