import assert from "node:assert/strict";
import test from "node:test";
import { ArbitrageUnstartedAbandonError } from "../arbitrage-execution/ArbitrageUnstartedAbandonService";
import { registerArbitrageUnstartedAbandonRoutes } from "./arbitrageUnstartedAbandonRoutes";

test("authenticated route forwards only user scope and request body with no-store", () => {
  let handler!: (request: any, response: any) => void;
  const calls: unknown[] = [];
  registerArbitrageUnstartedAbandonRoutes({
    post(path: string, value: typeof handler) {
      assert.equal(path, "/api/arbitrage-execution/abandon-unstarted");
      handler = value;
    },
  } as any, {
    abandon(userId, input) {
      calls.push({ userId, input });
      return { instance: { status: "FAILED" }, providerMutationCount: 0 } as any;
    },
  });
  const body = { arbitrageId: "arbitrage-1", commandId: "command-1", confirmed: true };
  const result = response();
  handler({ user: { id: "user-a" }, body }, result);

  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [{ userId: "user-a", input: body }]);
  assert.equal(result.body.providerMutationCount, 0);
});

test("route rejects missing authentication before service access", () => {
  let handler!: (request: any, response: any) => void;
  registerArbitrageUnstartedAbandonRoutes({ post: (_path: string, value: typeof handler) => { handler = value; } } as any, {
    abandon: () => assert.fail("service must not be called"),
  });
  const result = response();
  handler({ body: {} }, result);
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.category, "authentication_required");
});

test("route maps ineligible and idempotency conflicts without leaking internal failures", () => {
  for (const [category, expected] of [
    ["abandon_unavailable", 409],
    ["idempotency_conflict", 409],
    ["invalid_abandon_confirmation", 400],
  ] as const) {
    let handler!: (request: any, response: any) => void;
    registerArbitrageUnstartedAbandonRoutes({ post: (_path: string, value: typeof handler) => { handler = value; } } as any, {
      abandon() {
        throw new ArbitrageUnstartedAbandonError(category, "safe message");
      },
    });
    const result = response();
    handler({ user: { id: "user-a" }, body: {} }, result);
    assert.equal(result.statusCode, expected);
    assert.deepEqual(result.body, { category, message: "safe message" });
  }
});

function response() {
  return {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
  };
}
