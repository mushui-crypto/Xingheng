import { normalizeAddress } from "./HyperliquidInfoClient";
import type { HyperliquidInfoClient } from "./HyperliquidInfoClient";
import type {
  RealTradingFill,
  RealTradingHistoricalOrder,
  RealTradingOpenOrder,
  RealTradingOrderIncremental,
  RealTradingOrderSnapshot,
  RealTradingOrderState,
} from "./hyperliquidTypes";

type CachedOrderState = RealTradingOrderSnapshot & { needsRecoverySnapshot: boolean };

/**
 * Produces a polling-friendly state stream using only authoritative Hyperliquid info snapshots.
 * Exchange submission receipts are intentionally not an input and are never treated as fills.
 */
export class RealTradingOrderStateService {
  private readonly states = new Map<string, CachedOrderState>();

  constructor(private readonly info: HyperliquidInfoClient) {}

  async read(addressInput: string, afterSequence?: number | null): Promise<RealTradingOrderState> {
    const address = normalizeAddress(addressInput);
    const previous = this.states.get(address);
    try {
      const [openOrders, history] = await Promise.all([
        this.info.getOpenOrders(address),
        this.info.getOrderHistory(address),
      ]);
      const timestamp = Date.now();
      const sequence = (previous?.sequence ?? 0) + 1;
      const snapshot: CachedOrderState = {
        mode: "snapshot",
        sequence,
        timestamp,
        status: "connected",
        stale: false,
        reconnecting: false,
        authoritative: true,
        openOrders,
        orders: history.orders,
        fills: history.fills,
        warnings: history.warnings.filter((warning): warning is string => typeof warning === "string"),
        needsRecoverySnapshot: false,
      };
      this.states.set(address, snapshot);

      if (!previous || previous.needsRecoverySnapshot || afterSequence !== previous.sequence) {
        return withoutInternalState(snapshot);
      }
      return buildIncremental(previous, snapshot);
    } catch (error) {
      if (!previous) {
        const initial: CachedOrderState = {
          mode: "snapshot",
          sequence: 0,
          timestamp: Date.now(),
          status: "reconnecting",
          stale: true,
          reconnecting: true,
          authoritative: true,
          openOrders: [],
          orders: [],
          fills: [],
          warnings: [`authoritative refresh unavailable: ${sanitizeError(error)}`],
          needsRecoverySnapshot: true,
        };
        this.states.set(address, initial);
        return withoutInternalState(initial);
      }
      const stale: CachedOrderState = {
        ...previous,
        mode: "snapshot",
        timestamp: Date.now(),
        status: "reconnecting",
        stale: true,
        reconnecting: true,
        warnings: [...previous.warnings, `authoritative refresh unavailable: ${sanitizeError(error)}`],
        needsRecoverySnapshot: true,
      };
      this.states.set(address, stale);
      return withoutInternalState(stale);
    }
  }
}

function buildIncremental(previous: CachedOrderState, next: CachedOrderState): RealTradingOrderIncremental {
  const previousOpen = indexBy(previous.openOrders, openOrderIdentity);
  const nextOpen = indexBy(next.openOrders, openOrderIdentity);
  const previousTerminal = indexBy(previous.orders, historicalOrderIdentity);
  const previousFills = new Set(previous.fills.map(fillIdentity));
  return {
    mode: "incremental",
    baseSequence: previous.sequence,
    sequence: next.sequence,
    timestamp: next.timestamp,
    status: "connected",
    stale: false,
    reconnecting: false,
    authoritative: true,
    openOrders: {
      upserted: next.openOrders.filter((order) => {
        const old = previousOpen.get(openOrderIdentity(order));
        return !old || openOrderFingerprint(old) !== openOrderFingerprint(order);
      }),
      removedOrderIds: [...previousOpen.keys()].filter((id) => !nextOpen.has(id)),
    },
    terminalOrders: next.orders.filter((order) => (
      isAuthoritativeTerminal(order.status) && !previousTerminal.has(historicalOrderIdentity(order))
    )),
    fills: next.fills.filter((fill) => !previousFills.has(fillIdentity(fill))),
    warnings: next.warnings,
  };
}

function withoutInternalState(value: CachedOrderState): RealTradingOrderSnapshot {
  const { needsRecoverySnapshot: _, ...snapshot } = value;
  return snapshot;
}

function indexBy<T>(values: T[], identity: (value: T) => string) {
  return new Map(values.map((value) => [identity(value), value]));
}

function openOrderIdentity(order: RealTradingOpenOrder) {
  return order.oid !== null ? String(order.oid) : order.cloid ?? `${order.coin}:${order.side}:${order.timestamp}:${order.price}:${order.size}`;
}

function historicalOrderIdentity(order: RealTradingHistoricalOrder) {
  return `${openOrderIdentity(order)}:${order.status ?? "unknown"}:${order.statusTimestamp ?? order.timestamp ?? 0}`;
}

function fillIdentity(fill: RealTradingFill) {
  return `${fill.hash ?? ""}:${fill.coin ?? ""}:${fill.side}:${fill.timestamp ?? 0}:${fill.price ?? 0}:${fill.size ?? 0}`;
}

function openOrderFingerprint(order: RealTradingOpenOrder) {
  return JSON.stringify({
    oid: order.oid,
    cloid: order.cloid,
    status: order.status,
    price: order.price,
    size: order.size,
    reduceOnly: order.reduceOnly,
    triggerPx: order.triggerPx,
  });
}

function sanitizeError(error: unknown) {
  return (error instanceof Error ? error.message : "provider unavailable").slice(0, 200);
}

function isAuthoritativeTerminal(status: string | null) {
  if (!status) return false;
  return new Set([
    "filled",
    "canceled",
    "cancelled",
    "rejected",
    "margincanceled",
    "scheduledcancel",
    "triggered",
  ]).has(status.replace(/[\s_-]/g, "").toLowerCase());
}
