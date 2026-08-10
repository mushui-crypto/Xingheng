import assert from "node:assert/strict";
import test from "node:test";
import { registerUserAuthMiddleware } from "./authRoutes";

const publicGetPaths = [
  "/api/market/summary",
  "/api/real-trading/market/summary",
  "/api/arbitrage/dashboard",
  "/api/funding-arbitrage/opportunities",
  "/api/strategy/ict/forward",
  "/api/strategy/ict/history",
  "/api/strategy/ict/candles",
  "/api/strategy/martingale/candles",
  "/api/strategy/martingale/forward",
  "/api/strategy/martingale/fixed-grid/forward",
];

const sensitiveGetPaths = [
  "/api/trading/account",
  "/api/trading/positions",
  "/api/trading/orders",
  "/api/wallet/accounts",
  "/api/wallet/simulation-accounts",
  "/api/real-trading/account/summary",
  "/api/real-trading/positions",
  "/api/real-trading/orders/open",
];

const sensitivePostPaths = [
  "/api/trading/order",
  "/api/wallet/withdrawals",
  "/api/real-trading/exchange",
  "/api/real-trading/realtime/token",
  "/api/arbitrage/dashboard",
  "/api/funding-arbitrage/opportunities",
  "/api/strategy/ict/forward",
];

test("anonymous users can read public market, arbitrage and strategy APIs only", () => {
  const authorize = buildPolicyHarness();
  for (const path of publicGetPaths) {
    assert.equal(authorize(path, "GET").statusCode, 200, `expected anonymous GET ${path} to be public`);
  }
  for (const path of sensitiveGetPaths) {
    assert.equal(authorize(path, "GET").statusCode, 401, `expected anonymous GET ${path} to require authentication`);
  }
  for (const path of sensitivePostPaths) {
    assert.equal(authorize(path, "POST").statusCode, 401, `expected anonymous POST ${path} to require authentication`);
  }
});

test("disabled users remain blocked from user and real-trading account APIs", () => {
  const authorize = buildPolicyHarness();
  for (const path of ["/api/wallet/accounts", "/api/trading/account", "/api/real-trading/account/summary"]) {
    assert.equal(authorize(path, "GET", "disabled-token").statusCode, 403, `expected disabled user GET ${path} to be forbidden`);
  }
});

function buildPolicyHarness() {
  let middleware: any;
  let registeredPrefixes: string[] = [];
  registerUserAuthMiddleware({
    use(prefixes: string[], handler: unknown) {
      registeredPrefixes = prefixes;
      middleware = handler;
    },
  } as any, {
    authenticate(token: string | null) {
      return token === "disabled-token" ? disabledUser() : null;
    },
    authenticateIncludingDisabledRevocation(token: string | null) {
      return token === "disabled-token" ? disabledUser() : null;
    },
  } as any);
  assert.equal(typeof middleware, "function");

  return (path: string, method: string, token?: string) => {
    const response = createMockResponse();
    if (!registeredPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      response.statusCode = 200;
      response.body = { ok: true };
      return response;
    }
    middleware({
      method,
      originalUrl: `${path}?probe=1`,
      baseUrl: path,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, response, () => {
      response.statusCode = 200;
      response.body = { ok: true };
    });
    return response;
  };
}

function createMockResponse() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

function disabledUser() {
  return {
    id: "USR-disabled",
    email: "disabled@example.com",
    nickname: "Disabled",
    status: "disabled" as const,
    createdAt: "2026-07-22T00:00:00.000Z",
    emailVerifiedAt: "2026-07-22T00:00:00.000Z",
  };
}
