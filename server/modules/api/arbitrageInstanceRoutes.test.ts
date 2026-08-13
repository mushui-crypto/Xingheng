import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { registerArbitrageInstanceRoutes } from "./arbitrageInstanceRoutes";

test("arbitrage instance routes bind active, history, and detail queries to the authenticated user", async () => {
  const calls: unknown[] = [];
  const app = authenticatedApp("user-a");
  registerArbitrageInstanceRoutes(app, {
    listActive(userId: string) {
      calls.push({ operation: "active", userId });
      return [{ arbitrageId: "active-1" }];
    },
    listHistory(userId: string, pagination: unknown) {
      calls.push({ operation: "history", userId, pagination });
      return [{ arbitrageId: "history-1" }];
    },
    getById(userId: string, arbitrageId: string) {
      calls.push({ operation: "detail", userId, arbitrageId });
      return arbitrageId === "owned" ? { arbitrageId } : null;
    },
  } as never);

  const active = await request(app, "/api/arbitrage-instances/active");
  const history = await request(app, "/api/arbitrage-instances/history?page=2&limit=10");
  const detail = await request(app, "/api/arbitrage-instances/owned");
  try {
    assert.equal(active.response.status, 200);
    assert.equal(history.response.status, 200);
    assert.equal(detail.response.status, 200);
    assert.equal(active.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls, [
      { operation: "active", userId: "user-a" },
      { operation: "history", userId: "user-a", pagination: { page: 2, limit: 10 } },
      { operation: "detail", userId: "user-a", arbitrageId: "owned" },
    ]);
  } finally {
    await active.close();
    await history.close();
    await detail.close();
  }
});

test("history route defaults to the first 50 records", async () => {
  let received: unknown;
  const app = authenticatedApp("user-a");
  registerArbitrageInstanceRoutes(app, {
    listActive: () => [],
    listHistory(_userId: string, pagination: unknown) {
      received = pagination;
      return [];
    },
    getById: () => null,
  } as never);

  const result = await request(app, "/api/arbitrage-instances/history");
  try {
    assert.equal(result.response.status, 200);
    assert.deepEqual(received, { page: 1, limit: 50 });
  } finally {
    await result.close();
  }
});

test("missing and cross-user-invisible arbitrage ids both return not found", async () => {
  const app = authenticatedApp("user-a");
  registerArbitrageInstanceRoutes(app, {
    listActive: () => [],
    listHistory: () => [],
    getById: () => null,
  } as never);

  const result = await request(app, "/api/arbitrage-instances/foreign-id");
  try {
    assert.equal(result.response.status, 404);
    assert.equal((await result.response.json() as { category: string }).category, "arbitrage_instance_not_found");
  } finally {
    await result.close();
  }
});

test("routes reject missing authentication and invalid pagination before querying", async () => {
  let calls = 0;
  const app = express();
  registerArbitrageInstanceRoutes(app, {
    listActive: () => { calls += 1; return []; },
    listHistory: () => { calls += 1; return []; },
    getById: () => { calls += 1; return null; },
  } as never);

  const unauthenticated = await request(app, "/api/arbitrage-instances/active");
  try {
    assert.equal(unauthenticated.response.status, 401);
  } finally {
    await unauthenticated.close();
  }

  const authenticated = authenticatedApp("user-a");
  registerArbitrageInstanceRoutes(authenticated, {
    listActive: () => [],
    listHistory: () => { calls += 1; return []; },
    getById: () => null,
  } as never);
  const invalid = await request(authenticated, "/api/arbitrage-instances/history?page=0");
  try {
    assert.equal(invalid.response.status, 400);
    assert.equal((await invalid.response.json() as { category: string }).category, "invalid_pagination");
    assert.equal(calls, 0);
  } finally {
    await invalid.close();
  }
});

function authenticatedApp(userId: string) {
  const app = express();
  app.use((request, _response, next) => {
    request.user = { id: userId } as never;
    next();
  });
  return app;
}

async function request(app: express.Express, path: string) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    response: await fetch(`http://127.0.0.1:${port}${path}`),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
