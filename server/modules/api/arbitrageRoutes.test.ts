import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerArbitrageRoutes } from "./arbitrageRoutes";
import { registerUserAuthMiddleware } from "../auth/authRoutes";
import { ArbitrageRefreshCooldownError } from "../arbitrage/ArbitrageDashboardService";
import type { ArbitrageDashboardSnapshot } from "../arbitrage/arbitrageTypes";

describe("arbitrage dashboard public access and refresh protection", () => {
  it("allows anonymous GET requests", async () => {
    const { auth, route } = buildArbitrageRouteHarness({ tokenStatus: null });
    const request = createMockRequest();
    const response = createMockResponse();

    let continued = false;
    auth(request as any, response as any, () => { continued = true; });
    assert.equal(continued, true);
    await route(request as any, response as any);

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as ArbitrageDashboardSnapshot).horizonDays, 90);
  });

  it("does not allow non-GET requests to bypass authentication", () => {
    const { auth } = buildArbitrageRouteHarness({ tokenStatus: "disabled" });
    const response = createMockResponse();

    auth(createMockRequest({ authorization: "Bearer valid", method: "POST" }), response as any, () => assert.fail("disabled request should not continue"));

    assert.equal(response.statusCode, 403);
    assert.match(JSON.stringify(response.body), /账号已禁用/);
  });

  it("returns 429 and Retry-After when refresh cooldown has no cached snapshot", async () => {
    const { auth, route } = buildArbitrageRouteHarness({
      tokenStatus: null,
      async getSnapshot() {
        throw new ArbitrageRefreshCooldownError(2_000);
      },
    });
    const request = createMockRequest({ query: { refresh: "1" } });
    const response = createMockResponse();

    let authenticated = false;
    auth(request as any, response as any, () => { authenticated = true; });
    assert.equal(authenticated, true);
    await route(request as any, response as any);

    assert.equal(response.statusCode, 429);
    assert.equal(response.headers["Retry-After"], "2");
    assert.match(JSON.stringify(response.body), /刷新过于频繁/);
  });
});

type HarnessOptions = {
  tokenStatus: "active" | "disabled" | null;
  getSnapshot?: (horizonDays: 90 | 365, forceRefresh: boolean) => Promise<ArbitrageDashboardSnapshot>;
};

function buildArbitrageRouteHarness(options: HarnessOptions) {
  let auth: any;
  let route: any;
  const app = {
    use(_prefixes: unknown, handler: unknown) {
      auth = handler;
    },
    get(path: string, handler: unknown) {
      assert.equal(path, "/api/arbitrage/dashboard");
      route = handler;
    },
  };
  registerUserAuthMiddleware(app as any, {
    authenticate(token: string | null) {
      return token === "valid" && options.tokenStatus
        ? { id: "user-1", email: "u@example.com", status: options.tokenStatus }
        : null;
    },
  } as any);
  registerArbitrageRoutes(app as any, {
    getSnapshot: options.getSnapshot ?? (async (horizonDays: 90 | 365) => snapshot(horizonDays)),
  } as any);
  assert.equal(typeof auth, "function");
  assert.equal(typeof route, "function");
  return { auth, route };
}

function createMockRequest(input: { authorization?: string; query?: Record<string, string>; method?: string } = {}) {
  return {
    method: input.method ?? "GET",
    headers: input.authorization ? { authorization: input.authorization } : {},
    query: input.query ?? {},
    originalUrl: "/api/arbitrage/dashboard",
    baseUrl: "/api/arbitrage",
  };
}

function createMockResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
  };
  return response;
}

function snapshot(horizonDays: 90 | 365): ArbitrageDashboardSnapshot {
  return {
    horizonDays,
    generatedAt: Date.now(),
    markets: [],
    opportunities: [],
    summary: {
      bestScore: null,
      bestNetApr: null,
      eligibleOpportunityCount: 0,
      connectedVenueCount: 0,
      totalVenueCount: 5,
      trackedMarketCount: 0,
      usdcUsdtPrice: null,
      stablecoinBasisBps: null,
    },
    warnings: [],
  };
}
