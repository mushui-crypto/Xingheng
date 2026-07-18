import type {
  RealOpenOrder,
  RealOrderHistory,
  RealPosition,
  RealTradingCloidStatus,
  RealTradingOrderAudit,
} from "../../../api/realTrading";
import type { HyperliquidActionResult } from "../lib/useHyperliquidSessionSigner";
import { normalizeRealTradingOrderStatus, type RealTradingOrderLifecycle } from "./realtimeState";

export type RealTradingPositionOperation = "exposure" | "tpsl";

export function positionOperationKey(position: Pick<RealPosition, "coin" | "providerMarketId" | "symbol">, operation: RealTradingPositionOperation) {
  const market = position.providerMarketId ?? position.symbol ?? position.coin;
  return `position:${market.trim().toUpperCase()}:${operation}`;
}

export function orderOperationKey(symbol: string, reduceOnly: boolean) {
  return `order:${symbol.trim().toUpperCase()}:${reduceOnly ? "reduce" : "entry"}`;
}

export function buildAuthoritativeOrderLifecycles(
  openOrders: RealOpenOrder[],
  history: RealOrderHistory,
  authoritativeAt: number,
) {
  const lifecycles: RealTradingOrderLifecycle[] = [];
  const openOrderIds = new Set(openOrders.flatMap((order) => order.oid === undefined ? [] : [String(order.oid)]));
  openOrders.forEach((order, index) => {
    lifecycles.push(lifecycleFromAuthoritativeOrder(order, "accepted", `open:${index}`, authoritativeAt));
  });
  history.orders.forEach((item, index) => {
    const order = { ...item.order, ...item };
    lifecycles.push(lifecycleFromAuthoritativeOrder(order, "accepted", `history:${index}`, item.statusTimestamp ?? authoritativeAt));
  });
  history.fills.forEach((fill, index) => {
    const exchangeOrderId = fill.oid === undefined ? undefined : String(fill.oid);
    lifecycles.push({
      clientOrderId: exchangeOrderId ? `snapshot:${exchangeOrderId}` : `fill:${fill.tid ?? index}`,
      exchangeOrderId,
      status: exchangeOrderId && openOrderIds.has(exchangeOrderId) ? "partial" : "filled",
      symbol: fill.symbol ?? fill.coin,
      updatedAt: normalizeAuthoritativeTimestamp(fill.timestamp ?? fill.time, authoritativeAt),
    });
  });
  return lifecycles;
}

export function lifecycleFromAuthoritativeOrder(
  order: RealOpenOrder,
  fallbackStatus: RealTradingOrderLifecycle["status"],
  fallbackId: string,
  fallbackTimestamp: number,
): RealTradingOrderLifecycle {
  const exchangeOrderId = order.oid === undefined ? undefined : String(order.oid);
  return {
    clientOrderId: order.cloid ?? order.clientOrderId ?? (exchangeOrderId ? `snapshot:${exchangeOrderId}` : fallbackId),
    exchangeOrderId,
    status: normalizeRealTradingOrderStatus(order.lifecycleStatus ?? order.status) ?? fallbackStatus,
    symbol: order.symbol ?? order.coin,
    updatedAt: normalizeAuthoritativeTimestamp(
      order.updatedAt ?? order.timestamp ?? fallbackTimestamp,
      normalizeAuthoritativeTimestamp(fallbackTimestamp, Date.now()),
    ),
  };
}

export function lifecycleFromPositionActionFailure({
  cloid,
  outcome,
  symbol,
  updatedAt,
}: {
  cloid: string;
  outcome: HyperliquidActionResult;
  symbol: string;
  updatedAt: number;
}): RealTradingOrderLifecycle {
  return lifecyclesFromActionFailure({ cloid, outcome, symbol, updatedAt })[0];
}

export function lifecyclesFromActionFailure({
  cloid,
  operationKeys = [],
  outcome,
  symbol,
  updatedAt,
}: {
  cloid: string;
  operationKeys?: string[];
  outcome: HyperliquidActionResult;
  symbol: string;
  updatedAt: number;
}): RealTradingOrderLifecycle[] {
  const cloids = outcome.reconciliationCloids?.length ? outcome.reconciliationCloids : [cloid];
  return cloids.map((clientOrderId, index) => ({
    clientOrderId,
    message: outcome.error,
    operationKey: operationKeys[index] ?? operationKeys[0],
    requestId: outcome.reconciliationRequestId,
    status: outcome.reconciliationRequired ? "pending_reconciliation" : "rejected",
    symbol,
    updatedAt,
  }));
}

export async function lookupReconciliationWithCloidFallback(
  input: { address: string; cloid: string; requestId?: string },
  adapters: {
    fetchAudit: (requestId: string) => Promise<RealTradingOrderAudit>;
    fetchCloid: (address: string, cloid: string) => Promise<RealTradingCloidStatus>;
  },
) {
  if (input.requestId) {
    try {
      return { kind: "audit" as const, value: await adapters.fetchAudit(input.requestId) };
    } catch {
      // An older deployment may not expose /orders/audit yet. The original cloid
      // remains the only safe fallback; never generate a replacement cloid here.
    }
  }
  return { kind: "cloid" as const, value: await adapters.fetchCloid(input.address, input.cloid) };
}

function normalizeAuthoritativeTimestamp(value: number | null | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value < 10_000_000_000 ? value * 1_000 : value;
}
