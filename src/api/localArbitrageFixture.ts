import type { ArbitrageInstance, ArbitragePositionPresentation } from "./arbitrageInstances";

export const localArbitrageFixture: ArbitrageInstance = {
  arbitrageId: "arbitrage-8df79e258081469956c83ffe65842e2320c01974f27a1ccecb8ffb6e4571df62",
  userId: "demo-user",
  strategyType: "SPOT_PERPETUAL",
  sourcePlanId: null,
  maxResidualBaseQuantity: "0.902",
  status: "HOLDING",
  createdAt: 1788361680834,
  openedAt: 1788361680834,
  updatedAt: 1788361680834,
  closedAt: null,
  legs: [
    { legId: "binance-doge-spot", role: "LONG", venue: "binance", accountId: "local-fixture", instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "97.902", confirmedOpenedQuantity: "97.902", confirmedClosedQuantity: "0" },
    { legId: "binance-doge-perp", role: "SHORT", venue: "binance", accountId: "local-fixture", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "97", confirmedOpenedQuantity: "97", confirmedClosedQuantity: "0" },
  ],
  executionReferences: [],
  managementReleases: [],
  legacyUnresolvedExecutionSeals: [],
  pnl: { asset: "USDT", cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
};

export const localArbitragePresentation: ArbitragePositionPresentation = {
  arbitrageId: localArbitrageFixture.arbitrageId,
  market: { fundingRate: 0.0000759, fundingIntervalHours: 8, nextFundingTime: 1788422400000, nextEstimatedFundingFee: "0.000610408293", nextEstimatedFundingFeeAsset: "USDT", spreadQuotePerBase: -0.00003, spreadBps: -3.6177, quotedAt: 1788422363161, marketDataAsOf: 1788422363161, completeness: "COMPLETE" },
  revenue: {
    cumulativeFundingIncome: null, cumulativeFundingIncomeCompleteness: "INCOMPLETE",
    incurredFees: null, incurredFeesCompleteness: "INCOMPLETE",
    realizedSpreadProfit: null, realizedSpreadProfitCompleteness: "INCOMPLETE",
    realizedNetProfit: null, realizedNetProfitCompleteness: "INCOMPLETE",
    completeness: "INCOMPLETE",
  },
};

export function isLocalFixtureRuntime() {
  return typeof window !== "undefined" && window.location.hostname === "localhost";
}
