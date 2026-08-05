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
  let authorizationOwner: string | undefined;
  let takeoverOwner: string | undefined;
  let currentTakeoverOwner: string | undefined;
  let abortedTakeoverOwner: string | undefined;
  let policyOwner: string | undefined;
  let smokeLookupOwner: string | undefined;
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
      getAccountAssetAuthorization: async (userId: string) => {
        authorizationOwner = userId;
        return { assetId: "XAUT", accountFingerprint: "fingerprint" };
      },
      previewAssetTakeover: async (userId: string) => {
        takeoverOwner = userId;
        return { previewId: "opaque-preview" };
      },
      getCurrentAssetTakeover: async (userId: string) => {
        currentTakeoverOwner = userId;
        return { takeoverId: "takeover-current", state: "awaiting_reconfirm" };
      },
      abortAssetTakeover: async (userId: string) => {
        abortedTakeoverOwner = userId;
        return { takeoverId: "takeover-current", state: "failed" };
      },
      getConnectivitySmokePolicy: async (userId: string, query: unknown) => {
        policyOwner = userId;
        return {
          mode: "connectivity_smoke",
          venue: "binance",
          accountId: (query as any).accountId,
          executionAuthorized: false,
          policy: { version: "v1", digest: "digest" },
        };
      },
      lookupConnectivitySmokeExecution: async (userId: string, body: unknown) => {
        smokeLookupOwner = userId;
        return (body as any).challengeId === "challenge-r2"
          ? { smokeId: "smoke-r2", stage: "spot_opening" }
          : null;
      },
      putCredentials: async () => { throw new Error("secret=must-not-leak https://private.example"); },
    } as any,
  );
  const automationRoutes = [...routes.keys()].filter((key) => key.includes("/api/arbitrage/automation"));
  assert.equal(automationRoutes.length, 38);
  assert.ok(automationRoutes.every((key) => !key.includes(" /api/admin/")));
  for (const route of [
    "POST /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/preview",
    "POST /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/start",
    "GET /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/current",
    "POST /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/reconfirm",
    "POST /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/abort",
    "GET /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/status",
    "POST /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/exit/preview",
    "POST /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/exit/confirm",
    "GET /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/exit/status",
  ]) {
    assert.equal(routes.has(route), true);
  }

  const okResponse = mockResponse();
  await routes.get("GET /api/arbitrage/automation/venues")({ user: { id: "user-a" }, params: {}, body: {} }, okResponse);
  assert.equal(okResponse.statusCode, 200);
  assert.equal(okResponse.headers["Cache-Control"], "no-store");
  assert.match(JSON.stringify(okResponse.body), /user-a/);

  const policyResponse = mockResponse();
  await routes.get("GET /api/arbitrage/automation/connectivity-smoke/policy")({
    user: { id: "user-a" },
    query: { accountId: "binance:policy-account" },
    params: {},
    body: {},
  }, policyResponse);
  assert.equal(policyOwner, "user-a");
  assert.equal(policyResponse.statusCode, 200);
  assert.equal(policyResponse.headers["Cache-Control"], "no-store");
  assert.deepEqual(policyResponse.body, {
    mode: "connectivity_smoke",
    venue: "binance",
    accountId: "binance:policy-account",
    executionAuthorized: false,
    policy: { version: "v1", digest: "digest" },
  });

  const lookupResponse = mockResponse();
  await routes.get("POST /api/arbitrage/automation/connectivity-smoke/lookup")({
    user: { id: "user-a" },
    query: {},
    params: {},
    body: {
      accountId: "binance:policy-account",
      challengeId: "challenge-r2",
      idempotencyKey: "smoke:lookup:r2",
    },
  }, lookupResponse);
  assert.equal(smokeLookupOwner, "user-a");
  assert.equal(lookupResponse.statusCode, 200);
  assert.equal(lookupResponse.headers["Cache-Control"], "no-store");
  assert.deepEqual(lookupResponse.body, { smokeId: "smoke-r2", stage: "spot_opening" });

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

  const authorizationResponse = mockResponse();
  await routes.get("GET /api/arbitrage/automation/venues/:venue/assets/:assetId/authorization")({
    user: { id: "user-a" },
    params: { venue: "bybit", assetId: "XAUT" },
    body: { userId: "user-b" },
  }, authorizationResponse);
  assert.equal(authorizationOwner, "user-a");
  assert.equal(authorizationResponse.statusCode, 200);
  assert.equal(authorizationResponse.headers["Cache-Control"], "no-store");

  const takeoverResponse = mockResponse();
  await routes.get("POST /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/preview")({
    user: { id: "user-a" },
    userSessionDomain: "session-domain-a",
    params: { venue: "bybit", assetId: "XAUT" },
    body: { userId: "user-b", newCapitalUsd: 1_000, leverage: 2 },
  }, takeoverResponse);
  assert.equal(takeoverOwner, "user-a");
  assert.equal(takeoverResponse.statusCode, 200);
  assert.equal(takeoverResponse.headers["Cache-Control"], "no-store");

  const currentResponse = mockResponse();
  await routes.get("GET /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/current")({
    user: { id: "user-a" },
    userSessionDomain: "session-a",
    params: { venue: "binance", assetId: "xaut" },
    body: {},
  }, currentResponse);
  assert.equal(currentTakeoverOwner, "user-a");
  assert.equal(currentResponse.statusCode, 200);
  assert.equal(currentResponse.headers["Cache-Control"], "no-store");

  const abortResponse = mockResponse();
  await routes.get("POST /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/abort")({
    user: { id: "user-a" },
    userSessionDomain: "session-a",
    params: { venue: "binance", assetId: "xaut", takeoverId: "takeover-current" },
    body: {},
  }, abortResponse);
  assert.equal(abortedTakeoverOwner, "user-a");
  assert.equal(abortResponse.statusCode, 200);
  assert.equal(abortResponse.headers["Cache-Control"], "no-store");

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
