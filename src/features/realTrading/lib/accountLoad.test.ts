import assert from "node:assert/strict";
import test from "node:test";
import { transitionRealAccountRequestGeneration, withRealAccountLoadTimeout } from "./accountLoad";

test("real account load returns a completed resource without waiting for the timeout", async () => {
  const value = await withRealAccountLoadTimeout(Promise.resolve("positions"), "真实持仓", 25);
  assert.equal(value, "positions");
});

test("real account load rejects a resource that never settles", async () => {
  await assert.rejects(
    withRealAccountLoadTimeout(new Promise<never>(() => undefined), "真实持仓", 5),
    /真实持仓加载超时，请重试。/,
  );
});

test("real account load preserves the original request error", async () => {
  await assert.rejects(
    withRealAccountLoadTimeout(Promise.reject(new Error("provider unavailable")), "真实持仓", 25),
    /provider unavailable/,
  );
});

test("realtime recovery does not invalidate an in-flight authoritative REST account request", () => {
  const requestGeneration = transitionRealAccountRequestGeneration(0, "request_started");
  const generationWhileRealtimeReconnects = transitionRealAccountRequestGeneration(
    requestGeneration,
    "realtime_recovering",
  );

  assert.equal(generationWhileRealtimeReconnects, requestGeneration);
  assert.equal(requestGeneration === generationWhileRealtimeReconnects, true);
  assert.equal(
    transitionRealAccountRequestGeneration(generationWhileRealtimeReconnects, "wallet_session_changed"),
    requestGeneration + 1,
  );
});
