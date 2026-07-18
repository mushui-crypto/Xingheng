import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRealFill } from "./realTrading";

test("normalizes complete Hyperliquid fill payload to the UI contract", () => {
  assert.deepEqual(normalizeRealFill({ coin: "BTC", side: "B", px: "64000.5", sz: "0.002", closedPnl: "12.25", oid: "90071992547409931234", time: 1_720_000_000_000 }), {
    coin: "BTC",
    side: "B",
    fee: null,
    oid: "90071992547409931234",
    price: 64000.5,
    closedPnl: 12.25,
    size: 0.002,
    timestamp: 1_720_000_000_000,
  });
});

test("preserves zero PnL, number OID and canonical millisecond timestamp", () => {
  const fill = normalizeRealFill({ price: 10, size: 2, closedPnl: 0, oid: 42, timestamp: 1_720_000_000_000 });
  assert.equal(fill.closedPnl, 0);
  assert.equal(fill.oid, "42");
  assert.equal(fill.timestamp, 1_720_000_000_000);
});

test("invalid fill fields produce a safe canonical empty record", () => {
  assert.deepEqual(normalizeRealFill({ px: "bad", sz: {}, closedPnl: "", oid: null, time: -1 }), {
    fee: null,
    oid: null,
    price: null,
    closedPnl: null,
    size: null,
    timestamp: null,
  });
});
