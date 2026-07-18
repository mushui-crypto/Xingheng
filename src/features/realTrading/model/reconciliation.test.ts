import assert from "node:assert/strict";
import test from "node:test";
import { initialRealTradingRealtimeState, realTradingRealtimeReducer } from "./realtimeState";
import {
  buildAuthoritativeOrderLifecycles,
  lifecycleFromPositionActionFailure,
  lifecyclesFromActionFailure,
  lookupReconciliationWithCloidFallback,
  orderOperationKey,
  positionOperationKey,
} from "./reconciliation";

test("position actions preserve the original cloid and become pending on unknown outcome", () => {
  const lifecycle = lifecycleFromPositionActionFailure({
    cloid: "0x00112233445566778899aabbccddeeff",
    outcome: {
      completed: false,
      error: "timeout",
      reconciliationCloids: ["0x11112233445566778899aabbccddeeff"],
      reconciliationRequestId: "request-1",
      reconciliationRequired: true,
    },
    symbol: "BTCUSDT",
    updatedAt: 100,
  });
  assert.equal(lifecycle.status, "pending_reconciliation");
  assert.equal(lifecycle.clientOrderId, "0x11112233445566778899aabbccddeeff");
  assert.equal(lifecycle.requestId, "request-1");
});

test("audit 404 falls back to the same cloid without creating a replacement", async () => {
  const calls: string[] = [];
  const result = await lookupReconciliationWithCloidFallback(
    { address: "0x1111111111111111111111111111111111111111", cloid: "0x00112233445566778899aabbccddeeff", requestId: "missing" },
    {
      fetchAudit: async () => {
        calls.push("audit");
        throw new Error("404");
      },
      fetchCloid: async (_address, cloid) => {
        calls.push(cloid);
        return { authoritative: true, cloid, network: "hyperliquid-testnet", order: null, status: "unknown", timestamp: 1 };
      },
    },
  );
  assert.deepEqual(calls, ["audit", "0x00112233445566778899aabbccddeeff"]);
  assert.equal(result.kind, "cloid");
});

test("a batch reconciliation keeps every receipt cloid under the same request id", () => {
  const lifecycles = lifecyclesFromActionFailure({
    cloid: "0x00112233445566778899aabbccddeeff",
    operationKeys: ["position:BTCUSDT:exposure", "position:ETHUSDT:exposure"],
    outcome: {
      completed: false,
      error: "timeout",
      reconciliationCloids: [
        "0x00112233445566778899aabbccddeeff",
        "0x11112233445566778899aabbccddeeff",
      ],
      reconciliationRequestId: "request-batch",
      reconciliationRequired: true,
    },
    symbol: "MULTI",
    updatedAt: 200,
  });
  assert.deepEqual(lifecycles.map((item) => [item.clientOrderId, item.operationKey, item.requestId]), [
    ["0x00112233445566778899aabbccddeeff", "position:BTCUSDT:exposure", "request-batch"],
    ["0x11112233445566778899aabbccddeeff", "position:ETHUSDT:exposure", "request-batch"],
  ]);
});

test("operation keys distinguish entry, safe reduction and position TP/SL", () => {
  assert.equal(orderOperationKey("btcusdt", false), "order:BTCUSDT:entry");
  assert.equal(orderOperationKey("btcusdt", true), "order:BTCUSDT:reduce");
  assert.equal(positionOperationKey({ coin: "BTC", symbol: "BTCUSDT" }, "exposure"), "position:BTCUSDT:exposure");
  assert.equal(positionOperationKey({ coin: "BTC", providerMarketId: "xyz:BTC" }, "tpsl"), "position:XYZ:BTC:tpsl");
});

test("authoritative snapshot keeps cloid identity and treats a fill with an open remainder as partial", () => {
  const cloid = "0x00112233445566778899aabbccddeeff";
  const lifecycles = buildAuthoritativeOrderLifecycles(
    [{ cloid, coin: "BTC", oid: 42, status: "open" }],
    {
      fills: [{ coin: "BTC", oid: 42, price: 60_000, size: 0.001, timestamp: 150 }],
      nextCursor: null,
      orders: [],
      warnings: [],
    },
    200_000,
  );
  const reduced = lifecycles.reduce((state, order) => realTradingRealtimeReducer(state, { type: "order_updated", order }), initialRealTradingRealtimeState);
  assert.equal(reduced.orders.length, 1);
  assert.equal(reduced.orders[0].clientOrderId, cloid);
  assert.equal(reduced.orders[0].status, "partial");
  assert.equal(reduced.orders[0].updatedAt, 150_000);
});

test("authoritative terminal timestamp deduplicates the same OID and wins over an open record", () => {
  const cloid = "0x00112233445566778899aabbccddeeff";
  const lifecycles = buildAuthoritativeOrderLifecycles(
    [{ cloid, coin: "BTC", oid: 42, status: "open" }],
    {
      fills: [],
      nextCursor: null,
      orders: [{ cloid, coin: "BTC", oid: 42, status: "cancelled", statusTimestamp: 201 }],
      warnings: [],
    },
    200_000,
  );
  const reduced = realTradingRealtimeReducer(initialRealTradingRealtimeState, { type: "snapshot_succeeded", orders: lifecycles });
  assert.equal(reduced.orders.length, 1);
  assert.equal(reduced.orders[0].clientOrderId, cloid);
  assert.equal(reduced.orders[0].status, "cancelled");
  assert.equal(reduced.orders[0].updatedAt, 201_000);
});
