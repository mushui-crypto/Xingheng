import assert from "node:assert/strict";
import test from "node:test";
import { registerFundingArbitrageRoutes } from "./fundingArbitrageRoutes";
import type { FundingOpportunityQueryService } from "../cex/funding-arbitrage/FundingOpportunityQueryService";

test("funding opportunity API returns a read-only opportunity list", async () => {
  const { route, service } = buildRouteHarness();
  const response = createMockResponse();

  await route(createMockRequest(), response as any);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(service.queries, [{}]);
  assert.deepEqual(response.body, {
    generatedAt: 1_800_000_000_000,
    opportunities: [{
      symbol: "XAUTUSDT",
      longVenue: "okx",
      shortVenue: "binance",
      fundingSpread: 0.0005,
      estimatedCost: 0.0001,
      estimatedNetYield: 0.0004,
      confidence: "high",
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_000_060_000,
    }],
  });
});

test("funding opportunity API supports empty results and passes validated filters to the service", async () => {
  const { route, service } = buildRouteHarness({ opportunities: [] });
  const response = createMockResponse();

  await route(createMockRequest({
    query: { sort: "expiresAt", confidence: "medium", symbol: "xautusdt" },
  }), response as any);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(service.queries, [{ sort: "expiresAt", confidence: "medium", symbol: "xautusdt" }]);
  assert.deepEqual(response.body, { generatedAt: 1_800_000_000_000, opportunities: [] });
});

test("funding opportunity API ignores unsupported query values and surfaces read failures", async () => {
  const { route, service } = buildRouteHarness({ error: new Error("plan source unavailable") });
  const response = createMockResponse();

  await route(createMockRequest({
    query: { sort: "unknown", confidence: "urgent", symbol: "" },
  }), response as any);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(service.queries, [{}]);
  assert.match(JSON.stringify(response.body), /plan source unavailable/u);
});

function buildRouteHarness(options: {
  opportunities?: unknown[];
  error?: Error;
} = {}) {
  let route: any;
  const app = {
    get(path: string, handler: unknown) {
      assert.equal(path, "/api/funding-arbitrage/opportunities");
      route = handler;
    },
  };
  const service = {
    queries: [] as unknown[],
    async list(query: unknown) {
      this.queries.push(query);
      if (options.error) throw options.error;
      return {
        generatedAt: 1_800_000_000_000,
        opportunities: options.opportunities ?? [{
          symbol: "XAUTUSDT",
          longVenue: "okx",
          shortVenue: "binance",
          fundingSpread: 0.0005,
          estimatedCost: 0.0001,
          estimatedNetYield: 0.0004,
          confidence: "high",
          createdAt: 1_800_000_000_000,
          expiresAt: 1_800_000_060_000,
        }],
      };
    },
  };
  registerFundingArbitrageRoutes(app as any, service as unknown as FundingOpportunityQueryService);
  assert.equal(typeof route, "function");
  return { route, service };
}

function createMockRequest(input: { query?: Record<string, string> } = {}) {
  return {
    method: "GET",
    query: input.query ?? {},
    originalUrl: "/api/funding-arbitrage/opportunities",
    baseUrl: "/api/funding-arbitrage",
  };
}

function createMockResponse() {
  return {
    statusCode: 200,
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
