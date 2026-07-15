import type { BacktestConfig } from "../backtest/BacktestEngine";
import {
  ictResearchCandidateV5,
  ictResearchCandidateV5Backtest,
  ictResearchCandidateV5Decision,
  ictResearchCandidateV6,
  ictResearchCandidateV6Backtest,
  ictResearchCandidateV6Decision,
} from "./ictResearchCandidate";

export const ictV5Archive = Object.freeze({
  archiveId: "ict-btc-v5-2026-07-15",
  archivedAt: "2026-07-15",
  status: "frozen_baseline",
  strategy: Object.freeze({ ...ictResearchCandidateV5 }),
  backtest: Object.freeze({ ...ictResearchCandidateV5Backtest }),
  decision: ictResearchCandidateV5Decision,
});

export const ictOpportunityExpansionRoute = Object.freeze({
  routeId: "ict-route-a-opportunity-expansion",
  baselineArchiveId: ictV5Archive.archiveId,
  objective: "increase_trade_opportunities_without_rewriting_v5",
  researchDimensions: [
    "independent_secondary_setup",
    "regime_adaptive_thresholds",
    "long_short_specific_parameters",
    "additional_non_asia_day_entry_windows",
  ] as const,
  invariants: [
    "no_lookahead",
    "five_minute_entry_fifteen_minute_bias",
    "hard_structural_stop",
    "fees_and_slippage_included",
    "automatic_execution_disabled",
  ] as const,
  activeCandidate: {
    version: "v6",
    strategy: ictResearchCandidateV6,
    backtest: ictResearchCandidateV6Backtest,
    stopRule: {
      minimumPriceFraction: 1 / 120,
      maximumStructuralPriceFraction: 1 / 120,
      exampleAtBtc60000: 500,
    },
    decision: ictResearchCandidateV6Decision,
    status: "rejected_for_route_objective",
  },
});

export const ictLeverage100xRoute = Object.freeze({
  routeId: "ict-route-b-100x-fixed-margin",
  baselineArchiveId: ictV5Archive.archiveId,
  requestedLeverage: 100,
  marginFractions: [0.02, 0.03, 0.04, 0.05] as const,
  notionalEquityMultiples: [2, 3, 4, 5] as const,
  marginMode: "cross" as const,
  venue: "binance_usdm_btcusdt_perpetual" as const,
  maintenanceMarginRate: 0.004,
  liquidationFeeRate: 0.0125,
  researchOnly: true,
  automaticExecutionEnabled: false,
  venueCompatibility: {
    binanceUsdM: true,
    observedAt: "2026-07-15",
    btcBracketOneMaxLeverage: 125,
    btcBracketOneNotionalCap: 500_000,
    reason: "The 2x-5x equity notionals remain inside Binance BTCUSDT bracket one for the current research capital.",
  },
  supersededIsolatedBaselineEvaluation: {
    period: "2024-01-01..2026-07-13",
    candleCount: 266_400,
    tradeCount: 204,
    liquidations: 125,
    liquidationFraction: 0.6127,
    status: "failed" as const,
    fundingIncluded: false,
    byMarginFraction: {
      "0.02": { netPnl: -3355.84, profitFactor: 0.861, maxDrawdownFraction: 0.404 },
      "0.03": { netPnl: -4913.69, profitFactor: 0.854, maxDrawdownFraction: 0.556 },
      "0.04": { netPnl: -6258.58, profitFactor: 0.847, maxDrawdownFraction: 0.685 },
      "0.05": { netPnl: -7352.31, profitFactor: 0.84, maxDrawdownFraction: 0.785 },
    },
    nextRequirement: "test_pre_liquidation_protective_exit_before_any_further_100x_candidate_can_advance",
  },
  crossMarginEvaluation: {
    period: "2024-01-01..2026-07-13",
    candleCount: 266_400,
    tradeCount: 193,
    liquidations: 0,
    status: "selected_for_forward_paper" as const,
    fundingIncluded: false,
    fundingPolicy: "ignored_by_user_for_current_research" as const,
    singlePositionAssumption: true,
    maximumObservedNotional: 468_066.59,
    leverageBracketCapPassed: true,
    recommendedResearchMarginFraction: 0.02,
    byMarginFraction: {
      "0.02": { netPnl: 17620.44, profitFactor: 1.357, maxDrawdownFraction: 0.209 },
      "0.03": { netPnl: 31450.56, profitFactor: 1.314, maxDrawdownFraction: 0.304 },
      "0.04": { netPnl: 48323.84, profitFactor: 1.275, maxDrawdownFraction: 0.392 },
      "0.05": { netPnl: 67112.84, profitFactor: 1.241, maxDrawdownFraction: 0.472 },
    },
    nextRequirement: "collect_60_days_or_50_completed_forward_trades_before_review",
  },
  forwardValidation: {
    start: "2026-07-15T00:00:00Z",
    marginFraction: 0.02,
    status: "collecting" as const,
    gate: { minimumDays: 60, minimumCompletedTrades: 50, mode: "either" as const },
    dataSource: "binance_futures_public_5m",
    automaticOrdersEnabled: false,
    ignoredByUser: ["historical_funding", "mark_price_and_dynamic_bracket_details"] as const,
  },
});

export function makeIctLeverage100xBacktestConfig(
  marginFraction: typeof ictLeverage100xRoute.marginFractions[number],
): BacktestConfig {
  if (!ictLeverage100xRoute.marginFractions.includes(marginFraction)) {
    throw new Error(`Unsupported 100x research margin fraction: ${marginFraction}`);
  }
  return {
    ...ictResearchCandidateV5Backtest,
    positionSizingMode: "fixed_margin_fraction",
    positionMarginFraction: marginFraction,
    positionLeverage: ictLeverage100xRoute.requestedLeverage,
    positionMarginMode: ictLeverage100xRoute.marginMode,
    liquidationMaintenanceMarginRate: ictLeverage100xRoute.maintenanceMarginRate,
    liquidationFeeRate: ictLeverage100xRoute.liquidationFeeRate,
    accountRiskControlsEnabled: false,
  };
}
