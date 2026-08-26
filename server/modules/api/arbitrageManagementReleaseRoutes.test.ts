import assert from "node:assert/strict";
import test from "node:test";
import { ArbitrageManagementReleaseError } from "../arbitrage-execution/ArbitrageManagementReleaseService";
import { registerArbitrageManagementReleaseRoutes } from "./arbitrageManagementReleaseRoutes";

test("management release route requires authentication and forwards an explicit mutation body", async () => {
  let postHandler: any;
  let getHandler: any;
  const calls: unknown[] = [];
  registerArbitrageManagementReleaseRoutes({
    get: (path: string, value: unknown) => {
      assert.equal(path, "/api/arbitrage-instances/:arbitrageId/legs/:legId/close-safety");
      getHandler = value;
    },
    post: (path: string, value: unknown) => {
      assert.equal(path, "/api/arbitrage-execution/legs/release-management");
      postHandler = value;
    },
  } as any, {
    async evaluateEligibility(userId, arbitrageId, legId) {
      calls.push({ operation: "read", userId, arbitrageId, legId });
      return {
        activeManagedQuantity: "100",
        safeClosableQuantity: "0",
        fullManagedCloseAvailable: false,
        reason: "PROVIDER_REALITY_UNAVAILABLE",
        checkedAt: 1_800_000_000_000,
        realityReliable: false,
        releaseEligible: false,
        hasUnresolvedExecution: false,
        releaseEligibilityReason: "PROVIDER_REALITY_UNAVAILABLE",
      } as any;
    },
    async release(userId, input) {
      calls.push({ operation: "release", userId, input });
      return { idempotentReplay: false } as any;
    },
  });
  const body = { arbitrageId: "arbitrage-1", legId: "long-leg", commandId: "release-1", confirmed: true };
  const authenticated = response();
  await postHandler({ user: { id: "user-a" }, body }, authenticated);
  assert.equal(authenticated.headers["Cache-Control"], "no-store");
  assert.deepEqual(calls, [{ operation: "release", userId: "user-a", input: body }]);

  const read = response();
  await getHandler({ user: { id: "user-a" }, params: { arbitrageId: "arbitrage-1", legId: "long-leg" } }, read);
  assert.equal(read.headers["Cache-Control"], "no-store");
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.reason, "PROVIDER_REALITY_UNAVAILABLE");
  assert.equal(read.body.releaseEligible, false);
  assert.deepEqual(calls[1], {
    operation: "read", userId: "user-a", arbitrageId: "arbitrage-1", legId: "long-leg",
  });

  const anonymous = response();
  await getHandler({ params: { arbitrageId: "arbitrage-1", legId: "long-leg" } }, anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.body.category, "authentication_required");
  assert.equal(calls.length, 2);
});

test("close safety read keeps missing instances and legs invisible and sanitizes unexpected failures", async () => {
  let handler: any;
  let mode: "missing" | "leg" | "provider" = "missing";
  registerArbitrageManagementReleaseRoutes({
    get: (_path: string, value: unknown) => { handler = value; },
    post: () => undefined,
  } as any, {
    evaluateEligibility: async () => {
      if (mode === "provider") throw new Error("provider secret api-key payload");
      throw new ArbitrageManagementReleaseError(
        mode === "missing" ? "arbitrage_instance_not_found" : "arbitrage_leg_not_found",
        mode === "missing" ? "套利实例不存在或不属于当前用户。" : "所选套利腿不属于当前套利实例。",
      );
    },
    release: async () => { throw new Error("not used"); },
  });

  for (const scenario of ["missing", "leg", "provider"] as const) {
    mode = scenario;
    const result = response();
    await handler({ user: { id: "user-a" }, params: { arbitrageId: "foreign", legId: "foreign-leg" } }, result);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(result.statusCode, scenario === "provider" ? 503 : 404);
    if (scenario === "provider") assert.doesNotMatch(JSON.stringify(result.body), /secret|api-key/u);
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
