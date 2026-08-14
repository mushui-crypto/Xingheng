import assert from "node:assert/strict";
import test from "node:test";
import { registerArbitrageExecutionCancelRoutes } from "./arbitrageExecutionCancelRoutes";

test("formal known-order cancel route is authenticated, no-store, and forwards only the body", async () => {
  let handler: any;
  const calls: unknown[] = [];
  registerArbitrageExecutionCancelRoutes({ post: (_path: string, value: unknown) => { handler = value; } } as any, {
    async cancelKnownOrder(userId, input) {
      calls.push({ userId, input });
      return { instance: { arbitrageId: "arbitrage-1" } } as any;
    },
  });
  const body = { arbitrageId: "arbitrage-1", legId: "long-leg", executionIntentId: "intent-1", confirmed: true };
  const result = response();
  await handler({ user: { id: "user-a" }, body }, result);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [{ userId: "user-a", input: body }]);
});

test("formal known-order cancel route rejects unauthenticated requests before service access", async () => {
  let handler: any;
  registerArbitrageExecutionCancelRoutes({ post: (_path: string, value: unknown) => { handler = value; } } as any, {
    cancelKnownOrder: async () => assert.fail("service must not be called"),
  });
  const result = response();
  await handler({ body: {} }, result);
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.category, "invalid_cancel_confirmation");
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
