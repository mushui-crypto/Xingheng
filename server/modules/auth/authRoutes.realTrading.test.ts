import assert from "node:assert/strict";
import test from "node:test";
import { userAuthenticatedApiPrefixes } from "./authRoutes";

test("real-trading market remains public while account, orders, exchange and realtime are authenticated", () => {
  assert.equal(userAuthenticatedApiPrefixes.some((prefix) => prefix.startsWith("/api/real-trading/market")), false);
  assert.deepEqual(userAuthenticatedApiPrefixes.filter((prefix) => prefix.startsWith("/api/real-trading")), [
    "/api/real-trading/account",
    "/api/real-trading/positions",
    "/api/real-trading/orders",
    "/api/real-trading/exchange",
    "/api/real-trading/realtime",
  ]);
});
