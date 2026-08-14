import assert from "node:assert/strict";
import test from "node:test";
import { registerArbitrageExecutionCommandRoutes } from "./arbitrageExecutionCommandRoutes";

test("formal execution command routes are authenticated, no-store, and forward narrow commands", async () => {
  const handlers = new Map<string, any>();
  const calls: unknown[] = [];
  registerArbitrageExecutionCommandRoutes({
    post: (path: string, handler: unknown) => handlers.set(path, handler),
  } as any, {
    async confirm(userId, input) {
      calls.push({ operation: "confirm", userId, input });
      return { instance: { arbitrageId: "arbitrage-1" }, created: true } as any;
    },
    async executeLeg(userId, input) {
      calls.push({ operation: "leg", userId, input });
      return { instance: { arbitrageId: "arbitrage-1" } } as any;
    },
  });
  const finalBody = { opportunityId: "op-1", confirmed: true };
  const legBody = { arbitrageId: "arbitrage-1", legId: "long-leg", confirmed: true };
  const finalResponse = response();
  const legResponse = response();
  await handlers.get("/api/arbitrage-execution/confirm")({ user: { id: "user-a" }, body: finalBody }, finalResponse);
  await handlers.get("/api/arbitrage-execution/legs/confirm")({ user: { id: "user-a" }, body: legBody }, legResponse);
  assert.equal(finalResponse.headers["Cache-Control"], "no-store");
  assert.equal(legResponse.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [
    { operation: "confirm", userId: "user-a", input: finalBody },
    { operation: "leg", userId: "user-a", input: legBody },
  ]);
});

test("formal execution command routes reject unauthenticated requests before service access", async () => {
  let handler: any;
  registerArbitrageExecutionCommandRoutes({
    post: (path: string, value: unknown) => { if (path.endsWith("/confirm") && !path.includes("legs")) handler = value; },
  } as any, {
    confirm: async () => assert.fail("service must not be called"),
    executeLeg: async () => assert.fail("service must not be called"),
  });
  const result = response();
  await handler({ body: {} }, result);
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.category, "invalid_execution_confirmation");
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
