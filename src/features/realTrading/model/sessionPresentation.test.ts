import assert from "node:assert/strict";
import test from "node:test";
import { resolveRealTradingSessionPresentation } from "./sessionPresentation";

test("session presentation separates wallet agent and signer states", () => {
  assert.equal(resolveRealTradingSessionPresentation({ connected: false, signerCleared: false, state: "idle" }).wallet, "未连接");
  assert.equal(resolveRealTradingSessionPresentation({ connected: true, signerCleared: true, state: "idle" }).signer, "刷新后已清除");
  assert.equal(resolveRealTradingSessionPresentation({ connected: true, signerCleared: false, state: "authorizing" }).agent, "等待授权签名");
  assert.equal(resolveRealTradingSessionPresentation({ connected: true, signerCleared: false, state: "authorized" }).tone, "ready");
});
