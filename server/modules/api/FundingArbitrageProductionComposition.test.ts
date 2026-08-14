import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { registerArbitrageExecutionCommandRoutes } from "./arbitrageExecutionCommandRoutes";
import { registerFundingArbitrageRoutes } from "./fundingArbitrageRoutes";

const productionSource = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");

test("production composition exposes only the formal arbitrage mutation boundary", () => {
  assert.doesNotMatch(productionSource, /FundingArbitrageManualExecutionService/u);
  assert.doesNotMatch(productionSource, /ManualRequestFundingArbitrageExecutionIntentSource/u);
  assert.doesNotMatch(productionSource, /registerFundingArbitrageManualExecutionRoutes/u);
  assert.doesNotMatch(productionSource, /FundingLegExecutionLinkStore/u);
  assert.doesNotMatch(productionSource, /\/api\/funding-arbitrage\/executions\/manual/u);

  assert.match(productionSource, /new ArbitrageExecutionCommandService\(/u);
  assert.match(
    productionSource,
    /registerArbitrageExecutionCommandRoutes\(app, arbitrageExecutionCommand\)/u,
  );
  assert.match(productionSource, /registerFundingArbitrageRoutes\(app, fundingOpportunityQuery\)/u);
});

test("the removed manual endpoint cannot call a mutation while read-only funding and formal routes remain", async () => {
  const routes = new Map<string, (request: any, response: any) => Promise<void>>();
  const app = {
    get(path: string, handler: (request: any, response: any) => Promise<void>) {
      routes.set(`GET ${path}`, handler);
    },
    post(path: string, handler: (request: any, response: any) => Promise<void>) {
      routes.set(`POST ${path}`, handler);
    },
  };
  let fundingReads = 0;
  let formalCalls = 0;
  let providerMutations = 0;
  registerFundingArbitrageRoutes(app as never, {
    async list() {
      fundingReads += 1;
      return { generatedAt: 1_900_000_000_000, opportunities: [] };
    },
  } as never);
  registerArbitrageExecutionCommandRoutes(app as never, {
    async confirm() {
      formalCalls += 1;
      return { instance: { arbitrageId: "arbitrage-1" }, created: true } as never;
    },
    async executeLeg() {
      providerMutations += 1;
      throw new Error("provider mutation is forbidden in this composition test");
    },
    async reconcileLeg() {
      throw new Error("reconciliation is not expected in this composition test");
    },
  });

  assert.equal(routes.has("POST /api/funding-arbitrage/executions/manual"), false);
  assert.equal(formalCalls, 0);
  assert.equal(providerMutations, 0);

  const opportunityResponse = response();
  await routes.get("GET /api/funding-arbitrage/opportunities")!({ query: {} }, opportunityResponse);
  assert.equal(opportunityResponse.statusCode, 200);
  assert.equal(fundingReads, 1);

  const formalResponse = response();
  await routes.get("POST /api/arbitrage-execution/confirm")!(
    { user: { id: "user-a" }, body: { opportunityId: "opportunity-1", confirmed: true } },
    formalResponse,
  );
  assert.equal(formalResponse.statusCode, 200);
  assert.equal(formalCalls, 1);
  assert.equal(providerMutations, 0);
});

test("legacy manual service and route stay explicitly production-not-wired", () => {
  const service = readFileSync(new URL("./FundingArbitrageManualExecutionService.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("./fundingArbitrageManualExecutionRoutes.ts", import.meta.url), "utf8");
  assert.match(service, /PRODUCTION_NOT_WIRED/u);
  assert.match(route, /PRODUCTION_NOT_WIRED/u);
});

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
  };
}
