import assert from "node:assert/strict";
import test from "node:test";
import { presentOrderLifecycleToast } from "./orderLifecycleToast";

test("lifecycle toast key deduplicates the same cloid and status across transports", () => {
  const base = { clientOrderId: "0x00112233445566778899aabbccddeeff", status: "accepted" as const, symbol: "BTCUSDT", updatedAt: 1 };
  assert.equal(presentOrderLifecycleToast(base).key, presentOrderLifecycleToast({ ...base, updatedAt: 2 }).key);
  assert.notEqual(presentOrderLifecycleToast(base).key, presentOrderLifecycleToast({ ...base, status: "filled" }).key);
});

test("lifecycle toast presents success, warning and error with identifying text", () => {
  assert.deepEqual(presentOrderLifecycleToast({ clientOrderId: "c1", exchangeOrderId: "42", status: "filled", symbol: "ETHUSDT", updatedAt: 1 }), {
    key: "c1:filled",
    message: "ETHUSDT · 已成交 · OID 42",
    tone: "success",
  });
  assert.equal(presentOrderLifecycleToast({ clientOrderId: "c1", status: "partial", symbol: "ETHUSDT", updatedAt: 1 }).tone, "warning");
  assert.equal(presentOrderLifecycleToast({ clientOrderId: "c1", message: "余额不足", status: "rejected", symbol: "ETHUSDT", updatedAt: 1 }).tone, "error");
});
