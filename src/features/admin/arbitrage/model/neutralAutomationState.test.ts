import assert from "node:assert/strict";
import test from "node:test";
import { HttpRequestError } from "../../../../api/httpClient";
import {
  classifyNeutralAutomationError,
  connectorAvailabilityLabel,
  executionSafetyLabel,
  initialNeutralAutomationRequestState,
  neutralAutomationRequestReducer,
} from "./neutralAutomationState";
import type { NeutralAutomationStatus } from "./types";

const report = {
  execution: { automaticOrdersEnabled: false, mode: "shadow", providerWriteCallCount: 0 },
  shadow: { wouldSendProviderWrite: false },
} as NeutralAutomationStatus;

function httpError(status: number, message: string) {
  return new HttpRequestError(message, new Response(null, { status }));
}

test("success followed by 503 or network failure removes the previous private snapshot", () => {
  const success = neutralAutomationRequestReducer(initialNeutralAutomationRequestState, { type: "succeeded", report });
  const unavailable = neutralAutomationRequestReducer(success, {
    type: "failed",
    error: classifyNeutralAutomationError(httpError(503, "服务不可用")),
  });
  assert.equal(unavailable.report, null);
  assert.equal(unavailable.error?.kind, "unavailable");

  const network = neutralAutomationRequestReducer(success, {
    type: "failed",
    error: classifyNeutralAutomationError(new TypeError("fetch failed")),
  });
  assert.equal(network.report, null);
  assert.equal(network.error?.kind, "network");
});

test("401 and 403 remain distinct authorization states and remove private data", () => {
  const success = neutralAutomationRequestReducer(initialNeutralAutomationRequestState, { type: "succeeded", report });
  for (const [status, kind] of [[401, "unauthorized"], [403, "forbidden"]] as const) {
    const next = neutralAutomationRequestReducer(success, {
      type: "failed",
      error: classifyNeutralAutomationError(httpError(status, "拒绝访问")),
    });
    assert.equal(next.report, null);
    assert.equal(next.error?.kind, kind);
  }
});

test("Phase A reports provider write count zero as fail-closed", () => {
  assert.deepEqual(executionSafetyLabel(report), {
    safe: true,
    label: "不发送订单",
    detail: "Provider 写调用 0 次",
  });
  assert.equal(executionSafetyLabel({ ...report, execution: { ...report.execution, providerWriteCallCount: 1 } }).safe, false);
});

test("an unconfigured connector is presented as fail-closed", () => {
  const unconfigured = {
    ...report,
    connector: {
      connected: false,
      permissions: { read: false, trade: false, withdraw: false },
      stale: true,
    },
  } as NeutralAutomationStatus;
  assert.deepEqual(connectorAvailabilityLabel(unconfigured), {
    available: false,
    label: "只读 Connector 未配置",
  });
});
