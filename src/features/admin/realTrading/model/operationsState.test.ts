import assert from "node:assert/strict";
import test from "node:test";
import type { AdminRealTradingOperations } from "../../../../api/realTrading";
import { adminRealTradingOperationsReducer, initialAdminRealTradingOperationsState } from "./operationsState";

const report = {
  generatedAt: 1,
  network: "hyperliquid-testnet",
  operations: {
    auditCleanup: "unavailable",
    autoRecoverablePendingCount: 0,
    manualReviewPendingCount: 0,
    oldestPendingAgeMs: null,
    oldestPendingSubmittedAt: null,
    pendingCount: 0,
    recentCounts: [],
  },
  reconciliation: {},
  risk: {},
  status: "ok",
  userStreams: {},
} satisfies AdminRealTradingOperations;

test("operations request start and failure remove previous success report", () => {
  const success = adminRealTradingOperationsReducer(initialAdminRealTradingOperationsState, { type: "succeeded", report });
  assert.equal(success.report?.status, "ok");
  const loading = adminRealTradingOperationsReducer(success, { type: "started" });
  assert.equal(loading.report, null);
  const failed = adminRealTradingOperationsReducer(success, { type: "failed", error: "无权限" });
  assert.equal(failed.report, null);
  assert.equal(failed.error, "无权限");
});
