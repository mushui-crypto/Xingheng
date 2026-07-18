import assert from "node:assert/strict";
import test from "node:test";
import { presentRealFill } from "./realFillPresentation";

test("presents a complete canonical fill and preserves a large string OID", () => {
  const result = presentRealFill({ closedPnl: 12.25, coin: "BTC", fee: 0.01, oid: "90071992547409931234", price: 64000.5, side: "B", size: 0.002, timestamp: 1_720_000_000_000 });
  assert.equal(result.oid, "90071992547409931234");
  assert.equal(result.price, "64,000.5");
  assert.equal(result.size, "0.002");
  assert.equal(result.realizedPnl, "+12.25");
  assert.equal(result.realizedPnlTone, "positive");
  assert.notEqual(result.time, "-");
});

test("zero PnL is visible and invalid canonical fields stay safe", () => {
  assert.deepEqual(presentRealFill({ closedPnl: 0, fee: null, oid: "42", price: 0, size: 0, timestamp: null }), {
    oid: "42",
    price: "0",
    realizedPnl: "0",
    realizedPnlTone: undefined,
    size: "0",
    time: "-",
  });
  assert.equal(presentRealFill({ closedPnl: null, fee: null, oid: null, price: null, size: null, timestamp: null }).oid, "-");
});
