import assert from "node:assert/strict";
import test from "node:test";
import {
  canSkipConfirmationForSession,
  requiresRealTradingConfirmation,
  resetRealTradingConfirmationSessionForTest,
  setSkipPlainLimitConfirmationForSession,
} from "./confirmationPolicy";

test.beforeEach(resetRealTradingConfirmationSessionForTest);

test("only a plain limit entry can skip confirmation for this module session", () => {
  const plainLimit = { action: "entry", orderType: "limit", reduceOnly: false, hasTpsl: false } as const;
  assert.equal(canSkipConfirmationForSession(plainLimit), true);
  assert.equal(requiresRealTradingConfirmation(plainLimit), true);
  setSkipPlainLimitConfirmationForSession(true);
  assert.equal(requiresRealTradingConfirmation(plainLimit), false);
});

test("high-risk actions always require confirmation", () => {
  setSkipPlainLimitConfirmationForSession(true);
  const alwaysConfirmed = [
    { action: "entry", orderType: "market" },
    { action: "entry", orderType: "limit", hasTpsl: true },
    { action: "close", orderType: "market", reduceOnly: true },
    { action: "close_all" },
    { action: "reverse" },
    { action: "margin_leverage" },
    { action: "replace_tpsl" },
  ] as const;
  for (const context of alwaysConfirmed) assert.equal(requiresRealTradingConfirmation(context), true);
});
