import type { HyperliquidInfoClient } from "./HyperliquidInfoClient";
import type { RealTradingExchangeRequest, RealTradingPosition } from "./hyperliquidTypes";

export type RealTradingRiskLimits = {
  maxSnapshotAgeMs: number;
};

export class RealTradingRiskGuard {
  readonly limits: RealTradingRiskLimits;

  constructor(private readonly info: HyperliquidInfoClient, limits = loadRealTradingRiskLimits()) {
    this.limits = limits;
  }

  async assertAllowed(request: RealTradingExchangeRequest) {
    const release = await this.reserveAllowed(request);
    release();
  }

  getHealth() {
    return {
      status: "active",
      limits: this.limits,
      removedPlatformLimits: {
        maxLeverage: "provider_enforced",
        maxOrderNotionalEquityRatio: "provider_enforced",
        maxTotalNotionalEquityRatio: "provider_enforced",
        maxOpenOrders: "provider_enforced",
      },
      inFlightCount: 0,
      inFlightNotional: 0,
      inFlightByAddress: [],
    };
  }

  async reserveAllowed(request: RealTradingExchangeRequest): Promise<() => void> {
    if (request.action.type !== "order") return () => {};

    const orders = normalizeOrderItems(request.action.orders);
    const openingOrders = orders.filter((order) => order.r !== true);
    const symbols = await this.info.getSymbols();
    const symbolsByAsset = new Map(symbols.map((symbol) => [symbol.assetId, symbol]));
    const reduceOnlyOrders = orders.filter((order) => order.r === true);
    if (reduceOnlyOrders.length > 0) {
      const positions = await this.info.getPositions(request.masterAddress);
      assertReduceOnlyOrders(reduceOnlyOrders, positions, symbolsByAsset);
    }
    if (openingOrders.length === 0) return () => {};
    const account = await this.info.getAccountSummary(request.masterAddress);
    assertFreshAccount(account.status, account.timestamp, this.limits.maxSnapshotAgeMs);
    const marketSummaries = await Promise.all([...new Set(openingOrders.map(readOrderAsset))].map(async (assetId) => {
      const symbol = symbolsByAsset.get(assetId);
      if (!symbol || symbol.status !== "active") throw new Error(`真实交易资产 ${assetId} 当前不可开仓。`);
      const summary = await this.info.getSummary(symbol.symbol);
      if (summary.status !== "connected" || Date.now() - summary.timestamp > this.limits.maxSnapshotAgeMs) {
        throw new Error(`真实交易市场 ${symbol.symbol} 行情已过期，暂不允许新增敞口。`);
      }
      return summary;
    }));
    if (marketSummaries.length === 0) throw new Error("真实交易市场状态不可用，暂不允许新增敞口。");
    openingOrders.forEach(assertOpeningOrderShape);
    return () => {};
  }
}

export function loadRealTradingRiskLimits(): RealTradingRiskLimits {
  return {
    maxSnapshotAgeMs: readPositiveNumber("REAL_TRADING_RISK_MAX_SNAPSHOT_AGE_MS", 10_000, true),
  };
}

function normalizeOrderItems(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("order action 必须包含至少一笔订单。");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("order action 订单格式不正确。");
    }
    return item as Record<string, unknown>;
  });
}

function assertOpeningOrderShape(order: Record<string, unknown>) {
  const price = Number(order.p);
  const size = Number(order.s);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) {
    throw new Error("新增敞口订单的价格和数量必须是正数。");
  }
}

function readOrderAsset(order: Record<string, unknown>) {
  const asset = Number(order.a);
  if (!Number.isSafeInteger(asset) || asset < 0) throw new Error("新增敞口订单资产编号无效。");
  return asset;
}

function assertReduceOnlyOrders(
  orders: Array<Record<string, unknown>>,
  positions: RealTradingPosition[],
  symbolsByAsset: Map<number, { symbol: string }>,
) {
  const remaining = new Map<number, { side: "long" | "short"; size: number }>();
  for (const order of orders) {
    const asset = readOrderAsset(order);
    const symbol = symbolsByAsset.get(asset)?.symbol;
    const position = symbol ? positions.find((item) => item.symbol === symbol) : undefined;
    if (!position || !Number.isFinite(position.size) || Math.abs(position.size) <= 0) {
      throw new Error("reduce-only 订单没有可减少的同品种持仓。");
    }
    const state = remaining.get(asset) ?? { side: position.side, size: Math.abs(position.size) };
    if (typeof order.b !== "boolean" || (state.side === "long" ? order.b : !order.b)) {
      throw new Error("reduce-only 订单方向必须与现有持仓相反，不能增加仓位或反手。");
    }
    const closeSize = Number(order.s);
    if (!Number.isFinite(closeSize) || closeSize <= 0 || closeSize > state.size + 1e-12) {
      throw new Error("reduce-only 订单数量超过可平持仓，不能越过零仓位反手。");
    }
    state.size -= closeSize;
    remaining.set(asset, state);
  }
}

function assertFreshAccount(status: string, timestamp: number, maxAgeMs: number) {
  if (status !== "connected" || !Number.isFinite(timestamp) || Date.now() - timestamp > maxAgeMs) {
    throw new Error("真实交易账户快照已过期，暂不允许新增敞口。");
  }
}

function readPositiveNumber(name: string, fallback: number, integer = false) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return integer ? Math.max(1, Math.floor(parsed)) : parsed;
}
