import assert from "node:assert/strict";
import test from "node:test";
import { registerArbitrageInstanceExitRoutes } from "./arbitrageInstanceExitRoutes";

test("instance exit and reconciliation routes use authenticated user context and no-store", async () => {
  const handlers = new Map<string, (request: any, response: any) => Promise<void>>();
  const calls: unknown[] = [];
  registerArbitrageInstanceExitRoutes({
    post: (path: string, handler: (request: any, response: any) => Promise<void>) => handlers.set(path, handler),
  } as any, {
    async exit(userId, input) {
      calls.push({ operation: "exit", userId, input });
      return { status: "STOPPED" } as any;
    },
    async reconcile(userId, input) {
      calls.push({ operation: "reconcile", userId, input });
      return { instance: { arbitrageId: "arbitrage-1" } } as any;
    },
  });
  const exitBody = { arbitrageId: "arbitrage-1", commandId: "command-1", executionMode: "EXECUTION_PRIORITY", confirmed: true };
  const reconcileBody = { arbitrageId: "arbitrage-1" };
  const exitResponse = response();
  const reconcileResponse = response();

  await handlers.get("/api/arbitrage-execution/exit")!({ user: { id: "user-a" }, body: exitBody }, exitResponse);
  await handlers.get("/api/arbitrage-execution/reconcile")!({ user: { id: "user-a" }, body: reconcileBody }, reconcileResponse);

  assert.equal(exitResponse.headers["Cache-Control"], "no-store");
  assert.equal(reconcileResponse.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [
    { operation: "exit", userId: "user-a", input: exitBody },
    { operation: "reconcile", userId: "user-a", input: reconcileBody },
  ]);
});

test("instance exit routes reject missing user context before service access", async () => {
  const handlers: Array<(request: any, response: any) => Promise<void>> = [];
  registerArbitrageInstanceExitRoutes({ post: (_path: string, handler: any) => handlers.push(handler) } as any, {
    exit: async () => assert.fail("exit service must not be called"),
    reconcile: async () => assert.fail("reconciliation service must not be called"),
  });

  for (const handler of handlers) {
    const result = response();
    await handler({ body: {} }, result);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.category, "invalid_exit_confirmation");
  }
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
