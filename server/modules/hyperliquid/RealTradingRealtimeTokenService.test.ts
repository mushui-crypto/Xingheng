import assert from "node:assert/strict";
import test from "node:test";
import { RealTradingRealtimeTokenService } from "./RealTradingRealtimeTokenService";

test("realtime tokens are address-bound, one-time, and replace older grants for a user", () => {
  const service = new RealTradingRealtimeTokenService(5_000);
  const first = service.issue("USR-1", "0x1111111111111111111111111111111111111111");
  const second = service.issue("USR-1", "0x2222222222222222222222222222222222222222");
  assert.equal(service.consume(first.token), null);
  assert.deepEqual(service.consume(second.token), {
    userId: "USR-1",
    address: "0x2222222222222222222222222222222222222222",
    expiresAt: second.expiresAt,
  });
  assert.equal(service.consume(second.token), null);
});
