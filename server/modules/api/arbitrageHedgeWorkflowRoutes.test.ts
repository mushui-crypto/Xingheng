import assert from "node:assert/strict";
import test from "node:test";
import { registerArbitrageHedgeWorkflowRoutes } from "./arbitrageHedgeWorkflowRoutes";

test("workflow GET is authenticated and continue route forwards only server-owned path identity", async () => {
  const handlers: Record<string, (request: any, response: any) => unknown> = {};
  registerArbitrageHedgeWorkflowRoutes({
    get: (path: string, handler: any) => { handlers[`GET ${path}`] = handler; },
    post: (path: string, handler: any) => { handlers[`POST ${path}`] = handler; },
  } as any, {
    read: (userId: string, arbitrageId: string) => ({ arbitrageId, phase: "NOT_STARTED", firstLeg: null, secondLeg: null,
      requiresUserAction: false, reason: null, derivedAt: 1, userId }),
  } as any, {
    continuePartialHedge: async (userId: string, arbitrageId: string, body: unknown) => ({ userId, arbitrageId, body }),
  } as any);

  let output: any;
  await handlers["POST /api/arbitrage-instances/:arbitrageId/continue-hedge"]!({
    user: { id: "user-a" }, params: { arbitrageId: "arb-1" }, body: { commandId: "continue-1", confirmed: true },
  }, response((value) => { output = value; }));
  assert.deepEqual(output, { userId: "user-a", arbitrageId: "arb-1", body: { commandId: "continue-1", confirmed: true } });
});

function response(onJson: (value: unknown) => void) {
  return { setHeader: () => undefined, status() { return this; }, json: onJson };
}
