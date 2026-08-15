import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { registerArbitrageInstanceRoutes } from "../api/arbitrageInstanceRoutes";
import { ArbitrageInstanceQueryService } from "../cex/arbitrage-instance/ArbitrageInstanceQueryService";
import { registerUserAuthMiddleware } from "./authRoutes";

test("arbitrage instance reads require authentication and retain user ownership filtering", async () => {
  const queries: Array<{ operation: string; userId: string; arbitrageId?: string }> = [];
  const records = [
    { arbitrageId: "owned", userId: "user-a" },
    { arbitrageId: "foreign", userId: "user-b" },
  ];
  const query = new ArbitrageInstanceQueryService({
    listActive(userId) {
      queries.push({ operation: "listActive", userId });
      return records.filter((record) => record.userId === userId) as never;
    },
    listHistory: () => [],
    get(userId, arbitrageId) {
      queries.push({ operation: "get", userId, arbitrageId });
      return (records.find((record) => record.userId === userId && record.arbitrageId === arbitrageId) ?? null) as never;
    },
  });
  const app = express();
  registerUserAuthMiddleware(app, users() as never);
  registerArbitrageInstanceRoutes(app, query);
  const server = await listen(app);

  try {
    const anonymous = await fetch(`${server.origin}/api/arbitrage-instances`);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { message: "用户未登录或登录已失效。" });
    assert.deepEqual(queries, []);

    const active = await fetch(`${server.origin}/api/arbitrage-instances/active`, {
      headers: { Authorization: "Bearer valid-user-token" },
    });
    assert.equal(active.status, 200);
    assert.deepEqual(await active.json(), [{ arbitrageId: "owned", userId: "user-a" }]);

    const foreign = await fetch(`${server.origin}/api/arbitrage-instances/foreign`, {
      headers: { Authorization: "Bearer valid-user-token" },
    });
    assert.equal(foreign.status, 404);
    assert.deepEqual(queries, [
      { operation: "listActive", userId: "user-a" },
      { operation: "get", userId: "user-a", arbitrageId: "foreign" },
    ]);
  } finally {
    await server.close();
  }
});

function users() {
  const user = {
    id: "user-a",
    email: "user-a@example.com",
    nickname: "User A",
    status: "active" as const,
    createdAt: "2026-08-15T00:00:00.000Z",
    emailVerifiedAt: "2026-08-15T00:00:00.000Z",
  };
  return {
    authenticate(token: string | null) {
      return token === "valid-user-token" ? user : null;
    },
    authenticateIncludingDisabledRevocation(token: string | null) {
      return token === "valid-user-token" ? user : null;
    },
  };
}

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
