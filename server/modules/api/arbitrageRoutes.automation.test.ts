import assert from "node:assert/strict";
import test from "node:test";
import { registerArbitrageRoutes } from "./arbitrageRoutes";
import { registerUserAuthMiddleware } from "../auth/authRoutes";
import { RwaAutomationGovernanceError } from "../arbitrage/automation/RwaAutomationGovernance";

test("automation user API rejects anonymous and disabled users before handlers", () => {
  let auth: any;
  registerUserAuthMiddleware({ use(_prefixes: unknown, handler: unknown) { auth = handler; } } as any, {
    authenticate(token: string | null) {
      if (token === "active") return { id: "user-active", status: "active" };
      return null;
    },
    authenticateIncludingDisabledRevocation(token: string | null) {
      if (token === "disabled") return { id: "user-disabled", status: "disabled" };
      if (token === "active") return { id: "user-active", status: "active" };
      return null;
    },
  } as any);
  const request = (token?: string) => ({
    method: "GET",
    originalUrl: "/api/arbitrage/automation/venues",
    baseUrl: "/api/arbitrage",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const anonymous = mockResponse();
  auth(request(), anonymous, () => assert.fail("anonymous request continued"));
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers["Cache-Control"], "no-store");
  const disabled = mockResponse();
  auth(request("disabled"), disabled, () => assert.fail("disabled request continued"));
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.headers["Cache-Control"], "no-store");
  const active = mockResponse();
  let continued = false;
  auth(request("active"), active, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(active.headers["Cache-Control"], "no-store");
});

test("automation user routes derive ownership from auth, are no-store, and sanitize unknown failures", async () => {
  const routes = new Map<string, any>();
  const app = {
    get(path: string, handler: unknown) { routes.set(`GET ${path}`, handler); },
    put(path: string, handler: unknown) { routes.set(`PUT ${path}`, handler); },
    post(path: string, handler: unknown) { routes.set(`POST ${path}`, handler); },
    delete(path: string, handler: unknown) { routes.set(`DELETE ${path}`, handler); },
  };
  registerArbitrageRoutes(
    app as any,
    { getSnapshot: async () => ({ ok: true }) } as any,
    undefined,
    {
      listVenues: async (userId: string) => [{ venue: "bybit", owner: userId }],
      getReconciliation: async () => ({ items: [] }),
      putCredentials: async () => { throw new Error("secret=must-not-leak https://private.example"); },
    } as any,
  );
  const automationRoutes = [...routes.keys()].filter((key) => key.includes("/api/arbitrage/automation"));
  assert.equal(automationRoutes.length, 18);
  assert.ok(automationRoutes.every((key) => !key.includes(" /api/admin/")));

  const okResponse = mockResponse();
  await routes.get("GET /api/arbitrage/automation/venues")({ user: { id: "user-a" }, params: {}, body: {} }, okResponse);
  assert.equal(okResponse.statusCode, 200);
  assert.equal(okResponse.headers["Cache-Control"], "no-store");
  assert.match(JSON.stringify(okResponse.body), /user-a/);

  const anonymousResponse = mockResponse();
  await routes.get("GET /api/arbitrage/automation/venues")({ params: {}, body: {} }, anonymousResponse);
  assert.equal(anonymousResponse.statusCode, 401);

  const reconciliationResponse = mockResponse();
  await routes.get("GET /api/arbitrage/automation/venues/:venue/reconciliation")({
    user: { id: "user-a" },
    params: { venue: "bybit" },
    query: { accountId: "acct-1" },
    body: {},
  }, reconciliationResponse);
  assert.equal(reconciliationResponse.statusCode, 200);
  assert.equal(reconciliationResponse.headers["Cache-Control"], "no-store");

  const failedResponse = mockResponse();
  await routes.get("PUT /api/arbitrage/automation/venues/:venue/credentials")({
    user: { id: "user-a" },
    userSessionDomain: "session-domain-a",
    params: { venue: "bybit" },
    body: { apiKey: "key", apiSecret: "secret-value" },
  }, failedResponse);
  assert.equal(failedResponse.statusCode, 500);
  assert.equal(failedResponse.headers["Cache-Control"], "no-store");
  assert.doesNotMatch(JSON.stringify(failedResponse.body), /must-not-leak|private\.example|secret-value/i);
});

test("automation 429 responses are no-store and expose only stable retry metadata", async () => {
  const routes = new Map<string, any>();
  const app = {
    get(path: string, handler: unknown) { routes.set(`GET ${path}`, handler); },
    put() {},
    post() {},
    delete() {},
  };
  registerArbitrageRoutes(app as any, {} as any, undefined, {
    listVenues: async () => {
      throw new RwaAutomationGovernanceError(429, "automation_rate_limited", "自动套利请求过于频繁，请稍后再试。", 17);
    },
  } as any);
  const response = mockResponse();
  await routes.get("GET /api/arbitrage/automation/venues")({
    user: { id: "user-a" },
    ip: "203.0.113.10",
    params: {},
    body: {},
  }, response);
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(response.headers["Retry-After"], "17");
  assert.deepEqual(response.body, {
    category: "automation_rate_limited",
    message: "自动套利请求过于频繁，请稍后再试。",
  });
});

function mockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}
