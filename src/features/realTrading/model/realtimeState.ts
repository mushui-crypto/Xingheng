export type RealTradingConnectionStatus = "connected" | "stale" | "disconnected" | "reconnecting";

export type RealTradingOrderLifecycleStatus =
  | "submitted"
  | "accepted"
  | "partial"
  | "filled"
  | "cancelled"
  | "rejected"
  | "expired"
  | "pending_reconciliation";

export type RealTradingOrderLifecycle = {
  clientOrderId: string;
  requestId?: string;
  exchangeOrderId?: string;
  message?: string;
  status: RealTradingOrderLifecycleStatus;
  symbol?: string;
  updatedAt: number;
};

export type RealTradingRealtimeState = {
  connectionStatus: RealTradingConnectionStatus;
  lastHeartbeatAt: number | null;
  orders: RealTradingOrderLifecycle[];
  snapshotError: string;
  snapshotLoading: boolean;
};

export type RealTradingRealtimeAction =
  | { type: "retry_requested" }
  | { type: "heartbeat"; at: number; status?: RealTradingConnectionStatus }
  | { type: "heartbeat_timeout"; at: number; staleAfterMs: number }
  | { type: "connection_failed" }
  | { type: "order_submitted"; order: RealTradingOrderLifecycle }
  | { type: "order_updated"; order: RealTradingOrderLifecycle }
  | { type: "snapshot_started" }
  | { type: "snapshot_succeeded"; orders: RealTradingOrderLifecycle[] }
  | { type: "snapshot_failed"; message: string };

export const initialRealTradingRealtimeState: RealTradingRealtimeState = {
  connectionStatus: "reconnecting",
  lastHeartbeatAt: null,
  orders: [],
  snapshotError: "",
  snapshotLoading: false,
};

const terminalStatuses = new Set<RealTradingOrderLifecycleStatus>([
  "filled",
  "cancelled",
  "rejected",
  "expired",
]);

const statusRank: Record<RealTradingOrderLifecycleStatus, number> = {
  submitted: 0,
  accepted: 1,
  partial: 2,
  filled: 3,
  cancelled: 3,
  rejected: 3,
  expired: 3,
  pending_reconciliation: 1,
};

export function realTradingRealtimeReducer(
  state: RealTradingRealtimeState,
  action: RealTradingRealtimeAction,
): RealTradingRealtimeState {
  switch (action.type) {
    case "retry_requested":
      return { ...state, connectionStatus: "reconnecting" };
    case "heartbeat":
      return {
        ...state,
        connectionStatus: action.status ?? "connected",
        lastHeartbeatAt: action.at,
      };
    case "heartbeat_timeout":
      if (state.lastHeartbeatAt === null || action.at - state.lastHeartbeatAt <= action.staleAfterMs) return state;
      if (state.connectionStatus === "disconnected" || state.connectionStatus === "reconnecting") return state;
      return { ...state, connectionStatus: "stale" };
    case "connection_failed":
      return { ...state, connectionStatus: "disconnected" };
    case "order_submitted":
      return { ...state, orders: upsertOrder(state.orders, action.order, false) };
    case "order_updated":
      return { ...state, orders: upsertOrder(state.orders, action.order, true) };
    case "snapshot_started":
      return {
        ...state,
        orders: state.orders.filter((order) => order.status === "pending_reconciliation"),
        snapshotError: "",
        snapshotLoading: true,
      };
    case "snapshot_succeeded":
      return {
        ...state,
        orders: mergeAuthoritativeSnapshot(
          state.orders.filter((order) => order.status === "pending_reconciliation"),
          action.orders,
        ),
        snapshotError: "",
        snapshotLoading: false,
      };
    case "snapshot_failed":
      return {
        ...state,
        orders: [],
        snapshotError: action.message,
        snapshotLoading: false,
      };
    default:
      return state;
  }
}

export function normalizeRealTradingConnectionStatus(value: unknown): RealTradingConnectionStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  if (["connected", "live", "healthy", "ok", "ready"].includes(normalized)) return "connected";
  if (["stale", "delayed", "lagging"].includes(normalized)) return "stale";
  if (["reconnecting", "connecting", "recovering", "retrying"].includes(normalized)) return "reconnecting";
  if (["disconnected", "offline", "failed", "error", "unavailable"].includes(normalized)) return "disconnected";
  return null;
}

export function normalizeRealTradingOrderStatus(value: unknown): RealTradingOrderLifecycleStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (["submitted", "pending", "sending", "queued"].includes(normalized)) return "submitted";
  if (["unknown", "pending_reconciliation", "needs_reconciliation", "reconciling"].includes(normalized)) return "pending_reconciliation";
  if (["accepted", "open", "resting", "working"].includes(normalized)) return "accepted";
  if (["partial", "partially_filled", "partial_fill", "partiallyfilled"].includes(normalized)) return "partial";
  if (["filled", "complete", "completed", "triggered"].includes(normalized)) return "filled";
  if (["cancelled", "canceled", "cancel", "canceling", "cancelling", "margincanceled", "scheduledcancel"].includes(normalized)) return "cancelled";
  if (["rejected", "reject", "failed", "error"].includes(normalized)) return "rejected";
  if (["expired", "expire"].includes(normalized)) return "expired";
  return null;
}

export function realTradingOrderStatusLabel(status: RealTradingOrderLifecycleStatus) {
  const labels: Record<RealTradingOrderLifecycleStatus, string> = {
    submitted: "已提交",
    accepted: "已受理",
    partial: "部分成交",
    filled: "已成交",
    cancelled: "已撤销",
    rejected: "已拒绝",
    expired: "已过期",
    pending_reconciliation: "待交易所对账",
  };
  return labels[status];
}

export function extractExchangeOrderUpdates(
  result: unknown,
  fallback: Omit<RealTradingOrderLifecycle, "exchangeOrderId" | "message" | "status">,
): RealTradingOrderLifecycle[] {
  const statuses = findStatuses(result);
  if (statuses.length === 0) return [{ ...fallback, status: "accepted" }];
  return statuses.map((item, index) => normalizeExchangeStatus(item, fallback, index));
}

function normalizeExchangeStatus(
  value: unknown,
  fallback: Omit<RealTradingOrderLifecycle, "exchangeOrderId" | "message" | "status">,
  index: number,
): RealTradingOrderLifecycle {
  const item = isRecord(value) ? value : {};
  const error = typeof item.error === "string" ? item.error : undefined;
  const filled = isRecord(item.filled) ? item.filled : null;
  const resting = isRecord(item.resting) ? item.resting : null;
  const rawStatus = item.status ?? filled?.status ?? resting?.status;
  const status = error
    ? "rejected"
    : filled
      ? normalizeFilledStatus(filled)
      : resting
        ? "accepted"
        : normalizeRealTradingOrderStatus(rawStatus) ?? "accepted";
  const oid = item.oid ?? filled?.oid ?? resting?.oid;
  return {
    ...fallback,
    clientOrderId: index === 0 ? fallback.clientOrderId : `${fallback.clientOrderId}:${index}`,
    exchangeOrderId: typeof oid === "number" || typeof oid === "string" ? String(oid) : undefined,
    message: error,
    status,
  };
}

function normalizeFilledStatus(value: Record<string, unknown>): RealTradingOrderLifecycleStatus {
  const totalSize = Number(value.totalSz ?? value.totalSize);
  const filledSize = Number(value.sz ?? value.filledSz ?? value.filledSize);
  if (Number.isFinite(totalSize) && totalSize > 0 && Number.isFinite(filledSize) && filledSize < totalSize) return "partial";
  return "filled";
}

function findStatuses(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.statuses)) return value.statuses;
  for (const key of ["response", "data", "result"]) {
    const nested = findStatuses(value[key]);
    if (nested.length > 0) return nested;
  }
  return [];
}

function upsertOrder(
  orders: RealTradingOrderLifecycle[],
  next: RealTradingOrderLifecycle,
  enforceForwardProgress: boolean,
) {
  const existingIndex = orders.findIndex((item) => (
    item.clientOrderId === next.clientOrderId
    || (item.exchangeOrderId && next.exchangeOrderId && item.exchangeOrderId === next.exchangeOrderId)
  ));
  if (existingIndex < 0) return sortOrders([...orders, next]);
  const existing = orders[existingIndex];
  if (
    enforceForwardProgress
    && (terminalStatuses.has(existing.status) || statusRank[next.status] < statusRank[existing.status])
  ) return orders;
  const updated = [...orders];
  updated[existingIndex] = { ...existing, ...next };
  return sortOrders(updated);
}

function sortOrders(orders: RealTradingOrderLifecycle[]) {
  return [...orders].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 20);
}

function mergeAuthoritativeSnapshot(
  pending: RealTradingOrderLifecycle[],
  authoritative: RealTradingOrderLifecycle[],
) {
  const resolvedClientIds = new Set(authoritative.map((order) => order.clientOrderId));
  const unresolved = pending.filter((order) => !resolvedClientIds.has(order.clientOrderId));
  return sortOrders([...authoritative, ...unresolved]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
