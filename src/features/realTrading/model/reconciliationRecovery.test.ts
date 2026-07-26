import assert from "node:assert/strict";
import test from "node:test";
import type { RealTradingReconciliationRecord } from "../../../api/realTrading";
import { initialRealTradingRealtimeState, realTradingRealtimeReducer } from "./realtimeState";
import { reconciliationRecordsToLifecycles, resolveReconciliationAccess } from "./reconciliationRecovery";

const automaticRecord: RealTradingReconciliationRecord = {
  actionType: "order",
  autoRecoverable: true,
  blockingScope: "new_risk",
  clientOrderIds: ["0x11111111111111111111111111111111"],
  errorCategory: "network_unknown",
  lastReconcileAttemptAt: 200,
  manualReview: false,
  requestId: "request-1",
  submittedAt: 100,
};

test("reconciliation records restore pending lifecycle metadata", () => {
  const [lifecycle] = reconciliationRecordsToLifecycles([automaticRecord]);
  assert.equal(lifecycle.status, "pending_reconciliation");
  assert.equal(lifecycle.requestId, "request-1");
  assert.deepEqual(lifecycle.clientOrderIds, automaticRecord.clientOrderIds);
  assert.equal(lifecycle.autoRecoverable, true);
  assert.match(lifecycle.message ?? "", /交易所返回的最新订单状态/);
});

test("authoritative reconciliation sync removes records that have cleared", () => {
  const pending = reconciliationRecordsToLifecycles([automaticRecord]);
  const restored = realTradingRealtimeReducer(initialRealTradingRealtimeState, {
    type: "reconciliation_synchronized",
    orders: pending,
  });
  assert.equal(restored.orders.length, 1);
  const cleared = realTradingRealtimeReducer(restored, {
    type: "reconciliation_synchronized",
    orders: [],
  });
  assert.deepEqual(cleared.orders, []);
});

test("manual review and request failure both fail closed for new risk", () => {
  const manual = { ...automaticRecord, autoRecoverable: false, blockingScope: "manual_review" as const, manualReview: true };
  assert.match(resolveReconciliationAccess([manual], "").message, /人工核对/);
  assert.equal(resolveReconciliationAccess([], "服务不可用").blocksNewRisk, true);
  assert.equal(resolveReconciliationAccess([], "").blocksNewRisk, false);
});
