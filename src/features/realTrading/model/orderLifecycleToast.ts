import { realTradingOrderStatusLabel, type RealTradingOrderLifecycle } from "./realtimeState";

export type OrderLifecycleToast = {
  key: string;
  message: string;
  tone: "error" | "info" | "success" | "warning";
};

export function presentOrderLifecycleToast(order: RealTradingOrderLifecycle): OrderLifecycleToast {
  const identity = order.clientOrderId || order.requestId || order.exchangeOrderId || "unknown";
  const symbol = order.symbol || "真实订单";
  const reference = order.exchangeOrderId
    ? ` · OID ${order.exchangeOrderId}`
    : order.requestId
      ? ` · Request ${truncateIdentifier(order.requestId)}`
      : order.clientOrderId && !order.clientOrderId.startsWith("audit:")
        ? ` · Cloid ${truncateIdentifier(order.clientOrderId)}`
        : "";
  const detail = order.message ? ` · ${order.message}` : "";
  return {
    key: `${identity}:${order.status}`,
    message: `${symbol} · ${realTradingOrderStatusLabel(order.status)}${reference}${detail}`,
    tone: lifecycleTone(order.status),
  };
}

function lifecycleTone(status: RealTradingOrderLifecycle["status"]): OrderLifecycleToast["tone"] {
  if (status === "filled") return "success";
  if (status === "rejected") return "error";
  if (status === "partial" || status === "expired" || status === "pending_reconciliation") return "warning";
  return "info";
}

function truncateIdentifier(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
