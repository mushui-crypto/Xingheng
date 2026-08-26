import assert from "node:assert/strict";
import test from "node:test";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import { ArbitrageHedgeStartError, ArbitrageHedgeStartService } from "../arbitrage-execution/ArbitrageHedgeStartService";
import { registerArbitrageHedgeStartRoutes } from "./arbitrageHedgeStartRoutes";

test("start-hedge route uses authenticated ownership and path identity", async () => {
  let path = "";
  let handler: any;
  const calls: unknown[] = [];
  registerArbitrageHedgeStartRoutes({ post: (value: string, route: unknown) => { path = value; handler = route; } } as any, {
    async start(userId, arbitrageId, input) {
      calls.push({ userId, arbitrageId, input });
      return { status: "COMPLETED" } as any;
    },
  });
  const body = { hedgeCommandId: "start-1", confirmed: true };
  const result = response();
  await handler({ user: { id: "user-a" }, params: { arbitrageId: "arbitrage-1" }, body }, result);
  assert.equal(path, "/api/arbitrage-instances/:arbitrageId/start-hedge");
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [{ userId: "user-a", arbitrageId: "arbitrage-1", input: body }]);
});

test("start-hedge route maps idempotency conflict to 409", async () => {
  let handler: any;
  registerArbitrageHedgeStartRoutes({ post: (_path: string, route: unknown) => { handler = route; } } as any, {
    start: async () => { throw new ArbitrageHedgeStartError("idempotency_conflict", "conflict"); },
  });
  const result = response();
  await handler({ user: { id: "user-a" }, params: { arbitrageId: "arbitrage-1" }, body: {} }, result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.category, "idempotency_conflict");
});

test("direct start API rejects Perpetual-first before any execution mutation", async () => {
  let handler: any;
  let mutations = 0;
  const instance = spotPerpetualInstance();
  const service = new ArbitrageHedgeStartService(
    { get: (userId: string, arbitrageId: string) => userId === instance.userId && arbitrageId === instance.arbitrageId ? instance : null } as never,
    { executeLeg: async () => { mutations += 1; throw new Error("unexpected execution mutation"); } } as never,
  );
  registerArbitrageHedgeStartRoutes({ post: (_path: string, route: unknown) => { handler = route; } } as any, service);
  const result = response();
  await handler({
    user: { id: "user-a" },
    params: { arbitrageId: instance.arbitrageId },
    body: {
      hedgeCommandId: "illegal-start",
      firstLegId: "perpetual-leg",
      confirmationId: "confirmation-1",
      opportunityId: "opportunity-1",
      horizonDays: 90,
      quantityInput: { mode: "ASSET_QUANTITY", quantity: "1" },
      executionMode: "EXECUTION_PRIORITY",
      confirmed: true,
    },
  }, result);
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.category, "invalid_start_confirmation");
  assert.equal(mutations, 0);
});

function spotPerpetualInstance(): ArbitrageInstance {
  return {
    arbitrageId: "arbitrage-1", userId: "user-a", strategyType: "SPOT_PERPETUAL", sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0", status: "OPENING", createdAt: 1, openedAt: null, updatedAt: 1, closedAt: null,
    legs: [
      { legId: "spot-leg", role: "LONG", venue: "binance", accountId: "account-a", instrumentId: "BTC-USDT-SPOT", plannedQuantity: "1", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" },
      { legId: "perpetual-leg", role: "SHORT", venue: "okx", accountId: "account-b", instrumentId: "BTC-USDT-PERP", plannedQuantity: "1", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" },
    ],
    executionReferences: [], managementReleases: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}

function response() {
  return {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
  };
}
