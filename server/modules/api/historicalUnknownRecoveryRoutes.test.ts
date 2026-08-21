import assert from "node:assert/strict";
import test from "node:test";
import { HistoricalUnknownRecoveryError } from "../arbitrage-execution/HistoricalUnknownNotDispatchedRecoveryService";
import { registerHistoricalUnknownRecoveryRoutes } from "./historicalUnknownRecoveryRoutes";

test("historical UNKNOWN recovery route is authenticated, no-store, and forwards a narrow command", async () => {
  let handler: any;
  const calls: unknown[] = [];
  registerHistoricalUnknownRecoveryRoutes({
    post: (_path: string, value: unknown) => { handler = value; },
  } as any, {
    async recover(userId, input) {
      calls.push({ userId, input });
      return { instance: { arbitrageId: "arbitrage-1" } } as never;
    },
  });
  const body = { arbitrageId: "arbitrage-1", legId: "spot-leg", confirmed: true };
  const result = response();
  await handler({ user: { id: "user-a" }, body }, result);

  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [{ userId: "user-a", input: body }]);
});

test("historical UNKNOWN recovery route rejects an unauthenticated request without service access", async () => {
  let handler: any;
  registerHistoricalUnknownRecoveryRoutes({
    post: (_path: string, value: unknown) => { handler = value; },
  } as any, {
    recover: async () => assert.fail("service must not be called"),
  });
  const result = response();
  await handler({ body: {} }, result);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.category, "invalid_historical_recovery");
});

test("historical UNKNOWN recovery route preserves a fail-closed proof error", async () => {
  let handler: any;
  registerHistoricalUnknownRecoveryRoutes({
    post: (_path: string, value: unknown) => { handler = value; },
  } as any, {
    recover: async () => {
      throw new HistoricalUnknownRecoveryError(
        "historical_recovery_proof_incomplete",
        "Provider facts remain uncertain.",
      );
    },
  });
  const result = response();
  await handler({ user: { id: "user-a" }, body: {} }, result);

  assert.equal(result.statusCode, 409);
  assert.deepEqual(result.body, {
    category: "historical_recovery_proof_incomplete",
    message: "Provider facts remain uncertain.",
  });
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
