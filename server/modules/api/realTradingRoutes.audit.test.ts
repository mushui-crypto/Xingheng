import assert from "node:assert/strict";
import test from "node:test";
import type { RealTradingAuditRecord } from "../hyperliquid/realTradingAuditTypes";
import { toPublicRealTradingOrderAudit } from "./realTradingRoutes";

const base: RealTradingAuditRecord = {
  requestId: "req-1",
  userId: "user-1",
  network: "hyperliquid-testnet",
  masterAddress: "0x1111111111111111111111111111111111111111",
  actionType: "order",
  clientOrderIds: ["0x00112233445566778899aabbccddeeff"],
  outcome: "pending_reconciliation",
  errorCategory: "provider_transport_unknown",
  providerStatus: "unknown",
  httpStatus: 504,
  message: null,
  submittedAt: 100,
  completedAt: 200,
};

test("pending audit maps to the frozen frontend reconciliation contract", () => {
  const value = toPublicRealTradingOrderAudit(base);
  assert.equal(value.orderState, "submitted");
  assert.equal(value.reconcileRequired, true);
  assert.equal(value.timestamp, 200);
  assert.equal(value.cloid, base.clientOrderIds[0]);
  assert.equal("userId" in value, false);
  assert.equal("masterAddress" in value, false);
});

test("accepted audit is terminal and no longer requires reconciliation", () => {
  const value = toPublicRealTradingOrderAudit({ ...base, outcome: "accepted", errorCategory: null });
  assert.equal(value.orderState, "accepted");
  assert.equal(value.reconcileRequired, false);
});
