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

test("provider identity requires the exact HEDGE positionSide when one is persisted", () => {
  const short = { ...providerOrder(), positionSide: "SHORT" as const };
  assert.equal(assertBinanceProviderOrderIdentity(short, {
    symbol: "BTCUSDT",
    clientOrderId: "ptmidentity",
    positionSide: "SHORT",
  }), short);
  assert.throws(() => assertBinanceProviderOrderIdentity({ ...short, positionSide: "LONG" }, {
    symbol: "BTCUSDT",
    clientOrderId: "ptmidentity",
    positionSide: "SHORT",
  }), /positionSide/u);
  assert.doesNotThrow(() => assertBinanceProviderOrderIdentity(providerOrder(), {
    symbol: "BTCUSDT",
    clientOrderId: "ptmidentity",
  }));
});

test("provider identity rejects side, origQty, close semantic, and cumulative ceiling conflicts", () => {
  const expected = {
    symbol: "BTCUSDT",
    clientOrderId: "ptmidentity",
    side: "Sell" as const,
    requestedBaseQuantity: "0.001000000000000001",
    reduceOnly: true,
  };
  assert.doesNotThrow(() => assertBinanceProviderOrderIdentity(providerOrder(), expected));
  for (const conflicting of [
    { side: "Buy" as const },
    { requestedBaseQuantity: "0.002" },
    { reduceOnly: false },
    { filledBaseQuantity: "0.002" },
  ]) {
    assert.throws(() => assertBinanceProviderOrderIdentity({ ...providerOrder(), ...conflicting }, expected));
  }
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
    side: "Sell",
    reduceOnly: true,
    averagePrice: null,
    feeUsd: 0,
    updatedAt: 1_800_000_000_000,
  };
}
