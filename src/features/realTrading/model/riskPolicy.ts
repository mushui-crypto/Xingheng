export const defaultRealTradingRiskLimits = {
  maxLeverage: 20,
  maxOpenOrders: 20,
  maxOrderEquityRatio: 0.5,
  maxTotalNotionalEquityRatio: 2,
} as const;

export const realTradingRiskPolicy = {
  maxLeverage: defaultRealTradingRiskLimits.maxLeverage,
  maxOpenOrders: defaultRealTradingRiskLimits.maxOpenOrders,
  maxSingleOrderEquityRatio: defaultRealTradingRiskLimits.maxOrderEquityRatio,
  maxTotalExposureEquityRatio: defaultRealTradingRiskLimits.maxTotalNotionalEquityRatio,
} as const;

export type RealTradingOrderPreflightInput = {
  equity?: number | null;
  openOrderCount: number;
  orderNotional: number;
  reduceOnly: boolean;
  totalExposure: number;
};

export function preflightRealTradingOrder(input: RealTradingOrderPreflightInput) {
  if (input.reduceOnly) return [];
  const errors: string[] = [];
  const equity = input.equity;
  if (typeof equity !== "number" || !Number.isFinite(equity) || equity <= 0) {
    return ["账户权益不可用，暂不能增加风险敞口。"];
  }
  if (!Number.isFinite(input.orderNotional) || input.orderNotional <= 0) errors.push("订单名义金额无效。");
  else if (input.orderNotional > equity * realTradingRiskPolicy.maxSingleOrderEquityRatio) errors.push("单笔名义金额不得超过账户权益的 50%。");
  if (input.totalExposure + Math.max(0, input.orderNotional) > equity * realTradingRiskPolicy.maxTotalExposureEquityRatio) errors.push("总持仓名义金额不得超过账户权益的 200%。");
  if (input.openOrderCount >= realTradingRiskPolicy.maxOpenOrders) errors.push(`当前委托已达 ${realTradingRiskPolicy.maxOpenOrders} 笔上限。`);
  return errors;
}

export type RealTradingEntryRiskInput = {
  accountEquity?: number | null;
  currentNotional: number;
  leverage: number;
  marketStatus?: string | null;
  openOrderCount: number;
  orderNotional: number;
  reduceOnly: boolean;
};

export function getRealTradingEntryBlockReason(input: RealTradingEntryRiskInput) {
  if (input.reduceOnly) return null;
  const status = input.marketStatus?.trim().toLowerCase();
  if (!status || !["connected", "live", "ready"].includes(status)) {
    return status === "stale" ? "行情已过期，暂停新开仓；撤单和 Reduce-only 平仓仍可用。" : "行情未连接，暂停新开仓；撤单和 Reduce-only 平仓仍可用。";
  }
  if (!Number.isFinite(input.leverage) || input.leverage < 1 || input.leverage > defaultRealTradingRiskLimits.maxLeverage) {
    return `杠杆不得超过 ${defaultRealTradingRiskLimits.maxLeverage}x。`;
  }
  const equity = input.accountEquity;
  if (typeof equity !== "number" || !Number.isFinite(equity) || equity <= 0) return "账户权益不可用，暂不能增加风险敞口。";
  if (input.openOrderCount >= defaultRealTradingRiskLimits.maxOpenOrders) return `当前委托已达 ${defaultRealTradingRiskLimits.maxOpenOrders} 笔上限。`;
  if (input.orderNotional > equity * defaultRealTradingRiskLimits.maxOrderEquityRatio) return "单笔名义金额不得超过账户权益的 50%。";
  if (input.currentNotional + input.orderNotional > equity * defaultRealTradingRiskLimits.maxTotalNotionalEquityRatio) return "总持仓名义金额不得超过账户权益的 200%。";
  return null;
}
