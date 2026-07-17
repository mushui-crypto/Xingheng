import type { HyperliquidInfoClient } from "./HyperliquidInfoClient";
import type { RealTradingExchangeRequest, RealTradingPosition } from "./hyperliquidTypes";

export type RealTradingRiskLimits = {
  maxLeverage: number;
  maxOrderNotionalEquityRatio: number;
  maxTotalNotionalEquityRatio: number;
  maxOpenOrders: number;
  maxSnapshotAgeMs: number;
};

export class RealTradingRiskGuard {
  readonly limits: RealTradingRiskLimits;

  constructor(private readonly info: HyperliquidInfoClient, limits = loadRealTradingRiskLimits()) {
    this.limits = limits;
  }

  async assertAllowed(request: RealTradingExchangeRequest) {
    if (request.action.type === "updateLeverage") {
      const leverage = Number(request.action.leverage);
      if (leverage > this.limits.maxLeverage) {
        throw new Error(`真实交易杠杆不得超过 ${this.limits.maxLeverage}x。`);
      }
      return;
    }
    if (request.action.type !== "order") return;

    const orders = normalizeOrderItems(request.action.orders);
    const openingOrders = orders.filter((order) => order.r !== true);
    // Closing/protection orders must remain available even when an account is already over a limit.
    if (openingOrders.length === 0) return;

    const [account, positions, openOrders, symbols] = await Promise.all([
      this.info.getAccountSummary(request.masterAddress),
      this.info.getPositions(request.masterAddress),
      this.info.getOpenOrders(request.masterAddress),
      this.info.getSymbols(),
    ]);
    assertFreshAccount(account.status, account.timestamp, this.limits.maxSnapshotAgeMs);
    const symbolsByAsset = new Map(symbols.map((symbol) => [symbol.assetId, symbol]));
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
    const equity = account.accountValue;
    if (equity === null || !Number.isFinite(equity) || equity <= 0) {
      throw new Error("真实交易账户权益不可用，暂不允许新增敞口。");
    }

    const orderNotionals = openingOrders.map(calculateOrderNotional);
    const maxOrderNotional = equity * this.limits.maxOrderNotionalEquityRatio;
    if (orderNotionals.some((notional) => notional > maxOrderNotional)) {
      throw new Error(`单笔新增名义价值不得超过账户权益的 ${formatPercent(this.limits.maxOrderNotionalEquityRatio)}。`);
    }

    if (positions.some((position) => position.leverage !== null && position.leverage > this.limits.maxLeverage)) {
      throw new Error(`账户存在超过 ${this.limits.maxLeverage}x 的持仓，降低杠杆前不得新增敞口。`);
    }
    const currentNotional = calculatePositionNotional(positions) + calculateOpenOrderNotional(openOrders);
    const submittedNotional = orderNotionals.reduce((sum, value) => sum + value, 0);
    if (currentNotional + submittedNotional > equity * this.limits.maxTotalNotionalEquityRatio) {
      throw new Error(`新增敞口后总持仓名义价值不得超过账户权益的 ${formatPercent(this.limits.maxTotalNotionalEquityRatio)}。`);
    }

    if (openOrders.length + openingOrders.length > this.limits.maxOpenOrders) {
      throw new Error(`当前新增敞口委托不得超过 ${this.limits.maxOpenOrders} 笔。`);
    }
  }
}

export function loadRealTradingRiskLimits(): RealTradingRiskLimits {
  return {
    maxLeverage: readPositiveNumber("REAL_TRADING_RISK_MAX_LEVERAGE", 20, true),
    maxOrderNotionalEquityRatio: readPositiveNumber("REAL_TRADING_RISK_MAX_ORDER_NOTIONAL_EQUITY_RATIO", 0.5),
    maxTotalNotionalEquityRatio: readPositiveNumber("REAL_TRADING_RISK_MAX_TOTAL_NOTIONAL_EQUITY_RATIO", 2),
    maxOpenOrders: readPositiveNumber("REAL_TRADING_RISK_MAX_OPEN_ORDERS", 20, true),
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

function calculateOrderNotional(order: Record<string, unknown>) {
  const price = Number(order.p);
  const size = Number(order.s);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) {
    throw new Error("新增敞口订单的价格和数量必须是正数。");
  }
  const notional = price * size;
  if (!Number.isFinite(notional)) throw new Error("新增敞口订单名义价值无效。");
  return notional;
}

function readOrderAsset(order: Record<string, unknown>) {
  const asset = Number(order.a);
  if (!Number.isSafeInteger(asset) || asset < 0) throw new Error("新增敞口订单资产编号无效。");
  return asset;
}

function calculatePositionNotional(positions: RealTradingPosition[]) {
  return positions.reduce((sum, position) => {
    const direct = position.positionValue;
    if (direct !== null && Number.isFinite(direct)) return sum + Math.abs(direct);
    const referencePrice = position.markPrice ?? position.entryPrice;
    return referencePrice !== null && Number.isFinite(referencePrice)
      ? sum + Math.abs(position.size * referencePrice)
      : sum;
  }, 0);
}

function calculateOpenOrderNotional(openOrders: Array<{ reduceOnly: boolean | null; price: number | null; size: number | null }>) {
  return openOrders.reduce((sum, order) => {
    if (order.reduceOnly === true) return sum;
    if (order.price === null || order.size === null || !Number.isFinite(order.price) || !Number.isFinite(order.size)) {
      throw new Error("现有委托名义价值不可核对，暂不允许新增敞口。");
    }
    return sum + Math.abs(order.price * order.size);
  }, 0);
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

function formatPercent(ratio: number) {
  return `${Number((ratio * 100).toFixed(2))}%`;
}
