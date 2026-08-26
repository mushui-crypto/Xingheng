import assert from "node:assert/strict";
import test from "node:test";
import { ArbitrageExecutionCloseError } from "../arbitrage-execution/ArbitrageExecutionCloseService";
import { registerArbitrageExecutionCloseRoutes } from "./arbitrageExecutionCloseRoutes";

test("formal close route is authenticated, no-store, and forwards only the request body", async () => {
  let handler: any;
  const calls: unknown[] = [];
  registerArbitrageExecutionCloseRoutes({
    post: (_path: string, value: unknown) => { handler = value; },
  } as any, {
    async closeLeg(userId, input) {
      calls.push({ userId, input });
      return { instance: { arbitrageId: "arbitrage-1" } } as any;
    },
  });
  const body = { arbitrageId: "arbitrage-1", legId: "long-leg", quantity: "0.1" };
  const result = response();
  await handler({ user: { id: "user-a" }, body }, result);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [{ userId: "user-a", input: body }]);
});

test("formal close route rejects unauthenticated requests before service access", async () => {
  let handler: any;
  registerArbitrageExecutionCloseRoutes({ post: (_path: string, value: unknown) => { handler = value; } } as any, {
    closeLeg: async () => assert.fail("service must not be called"),
  });
  const result = response();
  await handler({ body: {} }, result);
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.category, "invalid_close_confirmation");
});

test("Close payload idempotency conflicts are returned as HTTP 409", async () => {
  let handler: any;
  registerArbitrageExecutionCloseRoutes({ post: (_path: string, value: unknown) => { handler = value; } } as any, {
    closeLeg: async () => { throw new ArbitrageExecutionCloseError("idempotency_conflict", "conflict"); },
  });
  const result = response();
  await handler({ user: { id: "user-a" }, body: {} }, result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.category, "idempotency_conflict");
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
