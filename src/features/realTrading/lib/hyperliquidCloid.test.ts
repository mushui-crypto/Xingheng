import assert from "node:assert/strict";
import test from "node:test";
import { assertHyperliquidCloid, createHyperliquidCloid, deriveHyperliquidCloid } from "./hyperliquidCloid";

test("creates the exact 128-bit Hyperliquid cloid wire format", () => {
  const cloid = createHyperliquidCloid(Uint8Array.from({ length: 16 }, (_, index) => index));
  assert.equal(cloid, "0x000102030405060708090a0b0c0d0e0f");
  assert.match(cloid, /^0x[0-9a-f]{32}$/);
});

test("derives deterministic and distinct child cloids for TP/SL batches", () => {
  const parent = assertHyperliquidCloid("0x00112233445566778899aabbccddeeff");
  const tpFirst = deriveHyperliquidCloid(parent, "tp");
  const tpRetry = deriveHyperliquidCloid(parent, "tp");
  const sl = deriveHyperliquidCloid(parent, "sl");

  assert.equal(tpFirst, tpRetry);
  assert.notEqual(tpFirst, sl);
  assert.notEqual(tpFirst, parent);
  assert.match(sl, /^0x[0-9a-f]{32}$/);
});

test("rejects malformed cloids before a signed payload is built", () => {
  assert.throws(() => assertHyperliquidCloid("0x1234"), /32 位十六进制/);
});
