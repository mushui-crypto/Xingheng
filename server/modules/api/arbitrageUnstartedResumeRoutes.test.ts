import assert from "node:assert/strict";
import test from "node:test";
import { registerArbitrageUnstartedResumeRoutes } from "./arbitrageUnstartedResumeRoutes";

test("unstarted resume route is authenticated, user scoped, and read only", async () => {
  let handler: any;
  const calls: unknown[] = [];
  registerArbitrageUnstartedResumeRoutes({
    get(path: string, value: unknown) {
      assert.equal(path, "/api/arbitrage-instances/:arbitrageId/resume-opening");
      handler = value;
    },
  } as any, {
    load: async (userId, arbitrageId) => {
      calls.push({ userId, arbitrageId });
      return { ok: true } as any;
    },
  });
  const response = fakeResponse();
  await handler({ user: { id: "user-a" }, params: { arbitrageId: "arbitrage-1" } }, response);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [{ userId: "user-a", arbitrageId: "arbitrage-1" }]);
  assert.deepEqual(response.body, { ok: true });
});

test("unstarted resume route rejects unauthenticated reads", async () => {
  let handler: any;
  registerArbitrageUnstartedResumeRoutes({ get: (_path: string, value: unknown) => { handler = value; } } as any, {
    load: async () => assert.fail("service must not be called"),
  });
  const response = fakeResponse();
  await handler({ params: { arbitrageId: "arbitrage-1" } }, response);
  assert.equal(response.statusCode, 401);
});

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
  };
}
