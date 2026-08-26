import assert from "node:assert/strict";
import test from "node:test";
import { registerArbitrageExecutionDraftRoutes } from "./arbitrageExecutionDraftRoutes";

test("execution draft routes are authenticated, no-store, and pass only the narrow application input", async () => {
  let getHandler: any;
  let postHandler: any;
  const calls: unknown[] = [];
  const app = {
    get(path: string, handler: unknown) {
      assert.equal(path, "/api/arbitrage-execution/draft");
      getHandler = handler;
    },
    post(path: string, handler: unknown) {
      assert.equal(path, "/api/arbitrage-execution/draft/preview");
      postHandler = handler;
    },
  };
  registerArbitrageExecutionDraftRoutes(app as any, {
    async createDraft(userId: string, input: unknown) {
      calls.push({ operation: "draft", userId, input });
      return { ok: true } as any;
    },
    async preview(userId: string, input: unknown) {
      calls.push({ operation: "preview", userId, input });
      return { ok: true } as any;
    },
  });

  const getResponse = response();
  await getHandler({
    user: { id: "user-a" },
    query: { opportunityId: "op-1", horizonDays: "90", executionMode: "PRICE_PRIORITY" },
  }, getResponse);
  const postResponse = response();
  await postHandler({
    user: { id: "user-a" },
    body: {
      opportunityId: "op-1",
      horizonDays: 90,
      executionMode: "EXECUTION_PRIORITY",
      quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "20" },
    },
  }, postResponse);

  assert.equal(getResponse.headers["Cache-Control"], "no-store");
  assert.equal(postResponse.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [
    {
      operation: "draft",
      userId: "user-a",
      input: { opportunityId: "op-1", horizonDays: 90, executionMode: "PRICE_PRIORITY" },
    },
    {
      operation: "preview",
      userId: "user-a",
      input: {
        opportunityId: "op-1",
        horizonDays: 90,
        executionMode: "EXECUTION_PRIORITY",
        quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "20" },
      },
    },
  ]);
});

test("execution draft routes reject unauthenticated requests", async () => {
  let handler: any;
  registerArbitrageExecutionDraftRoutes({ get: (_path: string, value: unknown) => { handler = value; }, post: () => undefined } as any, {
    createDraft: async () => assert.fail("service must not be called"),
    preview: async () => assert.fail("service must not be called"),
  });
  const result = response();
  await handler({ query: { opportunityId: "op", horizonDays: "90" } }, result);
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.category, "invalid_execution_draft_request");
});

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
