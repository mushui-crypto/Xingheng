import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { registerArbitrageExecutionCommandRoutes } from "../api/arbitrageExecutionCommandRoutes";
import { registerArbitrageExecutionCloseRoutes } from "../api/arbitrageExecutionCloseRoutes";
import { registerArbitrageExecutionDraftRoutes } from "../api/arbitrageExecutionDraftRoutes";
import { registerUserAuthMiddleware } from "./authRoutes";

const executionRequests = [
  { method: "GET", path: "/api/arbitrage-execution/draft?opportunityId=op-1&horizonDays=90" },
  { method: "POST", path: "/api/arbitrage-execution/draft/preview" },
  { method: "POST", path: "/api/arbitrage-execution/confirm" },
  { method: "POST", path: "/api/arbitrage-execution/legs/confirm" },
  { method: "POST", path: "/api/arbitrage-execution/legs/reconcile" },
  { method: "POST", path: "/api/arbitrage-execution/legs/close" },
] as const;

test("formal execution routes reject anonymous requests before application service access", async () => {
  const calls: unknown[] = [];
  const server = await startServer(calls);
  try {
    for (const request of executionRequests) {
      const response = await fetch(`${server.origin}${request.path}`, {
        method: request.method,
        headers: request.method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: request.method === "POST" ? JSON.stringify({ userId: "user-b" }) : undefined,
      });
      assert.equal(response.status, 401, `${request.method} ${request.path} must require authentication`);
      assert.deepEqual(await response.json(), { message: "用户未登录或登录已失效。" });
    }
    assert.deepEqual(calls, []);
  } finally {
    await server.close();
  }
});

test("formal execution routes use authenticated request.user and ignore client user identity", async () => {
  const calls: Array<{ operation: string; userId: string; input: unknown }> = [];
  const server = await startServer(calls);
  try {
    for (const request of executionRequests) {
      const response = await fetch(`${server.origin}${request.path}`, {
        method: request.method,
        headers: {
          Authorization: "Bearer valid-user-token",
          ...(request.method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        body: request.method === "POST" ? JSON.stringify({ userId: "user-b", probe: request.path }) : undefined,
      });
      assert.equal(response.status, 200, `${request.method} ${request.path} should receive authenticated user context`);
    }

    assert.deepEqual(calls.map(({ operation, userId }) => ({ operation, userId })), [
      { operation: "draft", userId: "user-a" },
      { operation: "preview", userId: "user-a" },
      { operation: "confirm", userId: "user-a" },
      { operation: "leg-confirm", userId: "user-a" },
      { operation: "reconcile", userId: "user-a" },
      { operation: "close", userId: "user-a" },
    ]);
    assert.deepEqual(calls[0]?.input, { opportunityId: "op-1", horizonDays: 90 });
  } finally {
    await server.close();
  }
});

test("existing arbitrage API authentication remains unchanged", async () => {
  const app = express();
  registerUserAuthMiddleware(app, users() as any);
  app.get("/api/arbitrage/private-probe", (request, response) => response.json({ userId: request.user?.id }));
  const server = await listen(app);
  try {
    const anonymous = await fetch(`${server.origin}/api/arbitrage/private-probe`);
    assert.equal(anonymous.status, 401);

    const authenticated = await fetch(`${server.origin}/api/arbitrage/private-probe`, {
      headers: { Authorization: "Bearer valid-user-token" },
    });
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), { userId: "user-a" });
  } finally {
    await server.close();
  }
});

async function startServer(calls: unknown[]) {
  const app = express();
  app.use(express.json());
  registerUserAuthMiddleware(app, users() as any);
  registerArbitrageExecutionDraftRoutes(app, {
    async createDraft(userId, input) {
      calls.push({ operation: "draft", userId, input });
      return { ok: true } as any;
    },
    async preview(userId, input) {
      calls.push({ operation: "preview", userId, input });
      return { ok: true } as any;
    },
  });
  registerArbitrageExecutionCommandRoutes(app, {
    async confirm(userId, input) {
      calls.push({ operation: "confirm", userId, input });
      return { ok: true } as any;
    },
    async executeLeg(userId, input) {
      calls.push({ operation: "leg-confirm", userId, input });
      return { ok: true } as any;
    },
    async reconcileLeg(userId, input) {
      calls.push({ operation: "reconcile", userId, input });
      return { ok: true } as any;
    },
  });
  registerArbitrageExecutionCloseRoutes(app, {
    async closeLeg(userId, input) {
      calls.push({ operation: "close", userId, input });
      return { ok: true } as any;
    },
  });
  return listen(app);
}

function users() {
  const user = {
    id: "user-a",
    email: "user-a@example.com",
    nickname: "User A",
    status: "active" as const,
    createdAt: "2026-08-14T00:00:00.000Z",
    emailVerifiedAt: "2026-08-14T00:00:00.000Z",
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
