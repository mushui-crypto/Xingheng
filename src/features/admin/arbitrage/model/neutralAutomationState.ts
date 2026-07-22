import { HttpRequestError } from "../../../../api/httpClient";
import type { NeutralAutomationStatus } from "./types";

export type NeutralAutomationErrorKind = "unauthorized" | "forbidden" | "unavailable" | "network" | "unknown";

export type NeutralAutomationLoadError = {
  kind: NeutralAutomationErrorKind;
  message: string;
};

export type NeutralAutomationRequestState = {
  error: NeutralAutomationLoadError | null;
  loading: boolean;
  report: NeutralAutomationStatus | null;
};

export type NeutralAutomationRequestAction =
  | { type: "started" }
  | { type: "succeeded"; report: NeutralAutomationStatus }
  | { type: "failed"; error: NeutralAutomationLoadError };

export const initialNeutralAutomationRequestState: NeutralAutomationRequestState = {
  error: null,
  loading: true,
  report: null,
};

export function neutralAutomationRequestReducer(
  state: NeutralAutomationRequestState,
  action: NeutralAutomationRequestAction,
): NeutralAutomationRequestState {
  if (action.type === "started") return { error: null, loading: true, report: state.report };
  if (action.type === "succeeded") return { error: null, loading: false, report: action.report };
  return { error: action.error, loading: false, report: null };
}

export function classifyNeutralAutomationError(error: unknown): NeutralAutomationLoadError {
  if (error instanceof HttpRequestError) {
    if (error.status === 401) return { kind: "unauthorized", message: error.message };
    if (error.status === 403) return { kind: "forbidden", message: error.message };
    if (error.status === 503) return { kind: "unavailable", message: error.message };
    return { kind: "unknown", message: error.message };
  }
  if (error instanceof TypeError) return { kind: "network", message: "无法连接 RWA Shadow 状态服务。" };
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : "RWA Shadow 状态加载失败。",
  };
}

export function executionSafetyLabel(report: NeutralAutomationStatus) {
  if (report.execution.automaticOrdersEnabled || report.execution.providerWriteCallCount !== 0 || report.shadow.wouldSendProviderWrite) {
    return {
      safe: false,
      label: "执行边界异常",
      detail: `检测到 Provider 写调用 ${report.execution.providerWriteCallCount} 次，请停止使用并核对后端。`,
    };
  }
  return {
    safe: true,
    label: "不发送订单",
    detail: "Provider 写调用 0 次",
  };
}

export function connectorAvailabilityLabel(report: NeutralAutomationStatus) {
  if (!report.connector.connected || !report.connector.permissions.read || report.connector.stale) {
    return {
      available: false,
      label: report.connector.connected ? "只读快照不可用" : "只读 Connector 未配置",
    };
  }
  return { available: true, label: "只读 Connector 已连接" };
}
