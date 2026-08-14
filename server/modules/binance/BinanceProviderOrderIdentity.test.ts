import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBinanceProviderOrderIdentity,
  assertBinanceSubmissionIdentity,
} from "./BinanceProviderOrderIdentity";
import type { BinanceProviderOrder } from "./BinanceTypes";

test("submission identity accepts only an already-normalized exact decimal orderId string", () => {
  assert.deepEqual(assertBinanceSubmissionIdentity({
    orderId: "9223372036854775807",
    orderLinkId: "ptmidentity",
    symbol: "BTCUSDT",
  }, { symbol: "BTCUSDT", clientOrderId: "ptmidentity" }), {
    orderId: "9223372036854775807",
    orderLinkId: "ptmidentity",
  });

  for (const orderId of [7, "provider-7", "", " 7", "1e3", "-1", "1.5"]) {
    assert.throws(() => assertBinanceSubmissionIdentity({
      orderId,
      orderLinkId: "ptmidentity",
      symbol: "BTCUSDT",
    }, { symbol: "BTCUSDT", clientOrderId: "ptmidentity" }), /orderId/u);
  }
});

test("provider identity compares the exact int64 orderId without numeric conversion", () => {
  const order = providerOrder();
  assert.equal(assertBinanceProviderOrderIdentity(order, {
    symbol: "BTCUSDT",
    clientOrderId: "ptmidentity",
    providerOrderId: "9223372036854775807",
  }), order);
  assert.throws(() => assertBinanceProviderOrderIdentity(order, {
    symbol: "BTCUSDT",
    clientOrderId: "ptmidentity",
    providerOrderId: "9223372036854776000",
  }), /orderId/u);
});

function providerOrder(): BinanceProviderOrder {
  return {
    symbol: "BTCUSDT",
    orderId: "9223372036854775807",
    orderLinkId: "ptmidentity",
    status: "Filled",
    requestedQuantity: 0.001,
    filledQuantity: 0.001,
    requestedBaseQuantity: "0.001000000000000001",
    filledBaseQuantity: "0.001000000000000001",
    averagePrice: null,
    feeUsd: 0,
    updatedAt: 1_800_000_000_000,
  };
}
