import assert from "node:assert/strict";
import test from "node:test";
import { decideUserStreamReconnect } from "./userStreamReconnect";

test("user stream reconnect uses bounded backoff and stops at threshold", () => {
  assert.deepEqual(decideUserStreamReconnect(0, 5), { delayMs: 1_000, exhausted: false, nextAttempt: 1 });
  assert.equal(decideUserStreamReconnect(4, 5).exhausted, false);
  assert.deepEqual(decideUserStreamReconnect(5, 5), { delayMs: 0, exhausted: true, nextAttempt: 5 });
});
