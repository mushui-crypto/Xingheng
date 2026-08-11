import assert from "node:assert/strict";
import test from "node:test";
import { registerFundingArbitrageManualExecutionRoutes } from "./fundingArbitrageManualExecutionRoutes";

test("manual execution route uses the authenticated user and does not accept raw user binding", async () => {
  const calls: { userId: string; body: unknown }[] = [];
  let route: any;
  registerFundingArbitrageManualExecutionRoutes({
    post(path: string, handler: unknown) {
      assert.equal(path, "/api/funding-arbitrage/executions/manual");
      route = handler;
    },
  } as any, {
    async execute(userId: string, body: unknown) {
      calls.push({ userId, body });
      return { ok: true };
    },
  } as any);

  const response = createMockResponse();
  await route({
    user: { id: "session-user" },
    body: { confirmed: true, userId: "client-user" },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [{
    userId: "session-user",
    body: { confirmed: true, userId: "client-user" },
  }]);
});

test("manual execution route rejects unauthenticated requests without calling the service", async () => {
  let calls = 0;
  let route: any;
  registerFundingArbitrageManualExecutionRoutes({
    post(_path: string, handler: unknown) {
      route = handler;
    },
  } as any, {
    async execute() {
      calls += 1;
      return { ok: true };
    },
  } as any);

  const response = createMockResponse();
  await route({ body: { confirmed: true } }, response);

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.category, "authentication_required");
  assert.equal(calls, 0);
});

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
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
