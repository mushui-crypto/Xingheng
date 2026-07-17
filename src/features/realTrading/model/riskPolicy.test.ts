import assert from "node:assert/strict";
import test from "node:test";
import { getRealTradingEntryBlockReason, preflightRealTradingOrder } from "./riskPolicy";

const base = { accountEquity: 1_000, currentNotional: 0, leverage: 20, marketStatus: "connected", openOrderCount: 0, orderNotional: 500, reduceOnly: false };

test("safe defaults allow boundary values and reject values above them", () => {
  assert.equal(getRealTradingEntryBlockReason(base), null);
  assert.match(getRealTradingEntryBlockReason({ ...base, orderNotional: 500.01 }) ?? "", /50%/);
  assert.match(getRealTradingEntryBlockReason({ ...base, currentNotional: 1_501 }) ?? "", /200%/);
  assert.match(getRealTradingEntryBlockReason({ ...base, leverage: 21 }) ?? "", /20x/);
  assert.match(getRealTradingEntryBlockReason({ ...base, openOrderCount: 20 }) ?? "", /20/);
});

test("stale blocks entries but never blocks reduce-only exits", () => {
  assert.match(getRealTradingEntryBlockReason({ ...base, marketStatus: "stale" }) ?? "", /过期/);
  assert.equal(getRealTradingEntryBlockReason({ ...base, marketStatus: "stale", reduceOnly: true }), null);
});

test("order preflight mirrors safe notional and open-order limits without blocking exits", () => {
  assert.deepEqual(preflightRealTradingOrder({ equity: 1_000, openOrderCount: 0, orderNotional: 500, reduceOnly: false, totalExposure: 1_500 }), []);
  assert.match(preflightRealTradingOrder({ equity: 1_000, openOrderCount: 0, orderNotional: 501, reduceOnly: false, totalExposure: 0 }).join(" "), /50%/);
  assert.match(preflightRealTradingOrder({ equity: 1_000, openOrderCount: 20, orderNotional: 1, reduceOnly: false, totalExposure: 0 }).join(" "), /20/);
  assert.deepEqual(preflightRealTradingOrder({ equity: null, openOrderCount: 99, orderNotional: 99_999, reduceOnly: true, totalExposure: 99_999 }), []);
});
