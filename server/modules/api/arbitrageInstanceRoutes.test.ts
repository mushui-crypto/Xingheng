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

test("verification route binds the request to the authenticated user and returns no-store results", async () => {
  const calls: unknown[] = [];
  const app = authenticatedApp("user-a");
  registerArbitrageInstanceRoutes(app, emptyQuery(), {
    async verify(userId: string, arbitrageId: string) {
      calls.push({ userId, arbitrageId });
      return {
        arbitrageId,
        checkedAt: 1_800_000_000_000,
        legs: [
          { arbitrageId, legId: "long", expectedManagedQuantity: "1", actualQuantity: "1", verificationStatus: "MATCHED", checkedAt: 1_800_000_000_000 },
          { arbitrageId, legId: "short", expectedManagedQuantity: "1", actualQuantity: null, verificationStatus: "UNKNOWN", checkedAt: 1_800_000_000_000 },
        ],
      } as never;
    },
  });

  const result = await request(app, "/api/arbitrage-instances/arb-1/verification");
  try {
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls, [{ userId: "user-a", arbitrageId: "arb-1" }]);
    assert.deepEqual((await result.response.json() as { legs: { verificationStatus: string }[] }).legs.map((leg) => leg.verificationStatus), ["MATCHED", "UNKNOWN"]);
  } finally {
    await result.close();
  }
});

test("verification route keeps missing instances invisible and provider failures sanitized", async () => {
  const missingApp = authenticatedApp("user-a");
  registerArbitrageInstanceRoutes(missingApp, emptyQuery(), { verify: async () => null });
  const missing = await request(missingApp, "/api/arbitrage-instances/foreign/verification");
  try {
    assert.equal(missing.response.status, 404);
    assert.equal((await missing.response.json() as { category: string }).category, "arbitrage_instance_not_found");
  } finally {
    await missing.close();
  }

  const failedApp = authenticatedApp("user-a");
  registerArbitrageInstanceRoutes(failedApp, emptyQuery(), {
    verify: async () => { throw new Error("provider secret payload"); },
  });
  const failed = await request(failedApp, "/api/arbitrage-instances/arb-1/verification");
  try {
    assert.equal(failed.response.status, 503);
    const payload = await failed.response.json() as { category: string; message: string };
    assert.equal(payload.category, "arbitrage_position_verification_unavailable");
    assert.doesNotMatch(payload.message, /provider secret/u);
  } finally {
    await failed.close();
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

function emptyQuery() {
  return {
    listActive: () => [],
    listHistory: () => [],
    getById: () => null,
  } as never;
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
