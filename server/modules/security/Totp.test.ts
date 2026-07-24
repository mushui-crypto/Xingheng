import assert from "node:assert/strict";
import test from "node:test";
import { totpCode, verifyTotp } from "./Totp";

test("TOTP follows the RFC 6238 SHA-1 test secret and accepts only the configured clock window", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(secret, 1), "287082");
  assert.equal(verifyTotp(secret, "287082", 59_000), 1);
  assert.equal(verifyTotp(secret, "287082", 120_000), null);
  assert.equal(verifyTotp(secret, "not-a-code", 59_000), null);
});
