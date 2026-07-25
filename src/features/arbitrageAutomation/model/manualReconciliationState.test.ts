import assert from "node:assert/strict";
import test from "node:test";
import {
  canStartManualReconciliation,
  createManualReconciliationState,
  manualReconciliationReducer,
} from "./manualReconciliationState";

type Report = { reconciliationId: string; canFinalize: boolean };

test("a new reconcile clears the previous authoritative report and failure keeps it cleared", () => {
  const initial = createManualReconciliationState<Report>("binance:account-a:position-a");
  const loading = manualReconciliationReducer(initial, {
    type: "request_started",
    scope: initial.scope,
    requestId: "request-1",
  });
  const success = manualReconciliationReducer(loading, {
    type: "request_succeeded",
    scope: initial.scope,
    requestId: "request-1",
    report: { reconciliationId: "reconcile-1", canFinalize: false },
  });
  const refreshing = manualReconciliationReducer(success, {
    type: "request_started",
    scope: initial.scope,
    requestId: "request-2",
  });
  const failed = manualReconciliationReducer(refreshing, {
    type: "request_failed",
    scope: initial.scope,
    requestId: "request-2",
    error: "服务暂不可用",
  });

  assert.equal(success.report?.reconciliationId, "reconcile-1");
  assert.equal(refreshing.report, null);
  assert.equal(failed.phase, "error");
  assert.equal(failed.report, null);
});

test("stale responses cannot cross account scope or replace the latest request", () => {
  const initial = createManualReconciliationState<Report>("binance:account-a:position-a");
  const loading = manualReconciliationReducer(initial, {
    type: "request_started",
    scope: initial.scope,
    requestId: "request-new",
  });
  const staleRequest = manualReconciliationReducer(loading, {
    type: "request_succeeded",
    scope: initial.scope,
    requestId: "request-old",
    report: { reconciliationId: "stale-request", canFinalize: true },
  });
  const changed = manualReconciliationReducer(staleRequest, {
    type: "scope_changed",
    scope: "binance:account-b:position-a",
  });
  const staleScope = manualReconciliationReducer(changed, {
    type: "request_succeeded",
    scope: initial.scope,
    requestId: "request-new",
    report: { reconciliationId: "stale-scope", canFinalize: true },
  });

  assert.equal(staleRequest.report, null);
  assert.equal(changed.phase, "idle");
  assert.equal(staleScope.report, null);
  assert.equal(staleScope.scope, "binance:account-b:position-a");
});

test("finalize is single-flight and failures withdraw the previous authoritative result", () => {
  const initial = createManualReconciliationState<Report>("binance:account-a:position-a");
  const loading = manualReconciliationReducer(initial, {
    type: "request_started",
    scope: initial.scope,
    requestId: "request-1",
  });
  const success = manualReconciliationReducer(loading, {
    type: "request_succeeded",
    scope: initial.scope,
    requestId: "request-1",
    report: { reconciliationId: "reconcile-1", canFinalize: true },
  });
  const finalizing = manualReconciliationReducer(success, {
    type: "finalize_started",
    scope: initial.scope,
    requestId: "finalize-1",
  });
  const duplicate = manualReconciliationReducer(finalizing, {
    type: "finalize_started",
    scope: initial.scope,
    requestId: "finalize-2",
  });
  const failed = manualReconciliationReducer(duplicate, {
    type: "finalize_failed",
    scope: initial.scope,
    requestId: "finalize-1",
    error: "二次对账仍有残余",
  });

  assert.equal(canStartManualReconciliation(finalizing.phase), false);
  assert.equal(duplicate.requestId, "finalize-1");
  assert.equal(failed.phase, "error");
  assert.equal(failed.report, null);
});
