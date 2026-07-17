import assert from "node:assert/strict";
import test from "node:test";
import { assertHyperliquidCloid } from "./hyperliquidCloid";
import { buildEntryTpslOrderRequest } from "./hyperliquidSdk";
import { buildPositionTpslOrders } from "./tpslOrders";

test("signed order payload carries the same cloid across an action retry", () => {
  const cloid = assertHyperliquidCloid("0x00112233445566778899aabbccddeeff");
  const input = {
    asset: 0,
    cloid,
    isBuy: true,
    market: false,
    price: "60000",
    reduceOnly: false,
    size: "0.01",
  } as const;

  const first = buildEntryTpslOrderRequest(input, []);
  const retry = buildEntryTpslOrderRequest(input, []);
  assert.equal(first.orders[0].c, cloid);
  assert.equal(retry.orders[0].c, cloid);
  assert.deepEqual(retry, first);
});

test("entry TP/SL payload assigns deterministic valid cloids to every child", () => {
  const cloid = assertHyperliquidCloid("0x00112233445566778899aabbccddeeff");
  const triggers = buildPositionTpslOrders({
    asset: 0,
    closingIsBuy: false,
    parentCloid: cloid,
    referencePrice: 60_000,
    size: "0.01",
    slPrice: "59000",
    szDecimals: 5,
    tpPrice: "62000",
  });
  const request = buildEntryTpslOrderRequest({
    asset: 0,
    cloid,
    isBuy: true,
    market: false,
    price: "60000",
    reduceOnly: false,
    size: "0.01",
  }, triggers);

  assert.equal(request.orders.length, 3);
  assert.deepEqual(request.orders.map((order) => order.c), [cloid, triggers[0].cloid, triggers[1].cloid]);
  assert.equal(new Set(request.orders.map((order) => order.c)).size, 3);
  assert.ok(request.orders.every((order) => /^0x[0-9a-f]{32}$/.test(order.c)));
});
