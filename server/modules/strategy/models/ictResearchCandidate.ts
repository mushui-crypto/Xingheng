import {
  defaultIctLiquidityReversalConfig,
  type IctLiquidityReversalConfig,
} from "./IctLiquidityReversalStrategy";
import { defaultBacktestConfig, type BacktestConfig } from "../backtest/BacktestEngine";

export const ictResearchCandidateV1: IctLiquidityReversalConfig = {
  ...defaultIctLiquidityReversalConfig,
  biasMode: "ema_only",
  displacementBodyAtr: 0.3,
  sweepLookbackBars: 24,
  setupExpiryBars: 12,
  rewardRisk: 3,
  stopBufferAtr: 0.25,
  maxStopAtr: 3,
  allowWeekends: false,
  volatilityFilter: "high_only",
  sessionTimeZone: "Asia/Shanghai",
  sessionStartMinute: 18 * 60,
  sessionEndMinute: 8 * 60,
};

export const ictResearchCandidateV1Backtest: BacktestConfig = {
  ...defaultBacktestConfig,
  minNetRewardRisk: 1.2,
  stopExecutionMode: "hard",
  sessionTimeZone: ictResearchCandidateV1.sessionTimeZone,
  sessionStartMinute: ictResearchCandidateV1.sessionStartMinute,
  sessionEndMinute: ictResearchCandidateV1.sessionEndMinute,
};

export const ictResearchCandidateV1WorkerParameters = {
  biasMode: ictResearchCandidateV1.biasMode,
  displacementBodyAtr: ictResearchCandidateV1.displacementBodyAtr,
  sweepLookbackBars: ictResearchCandidateV1.sweepLookbackBars,
  setupExpiryBars: ictResearchCandidateV1.setupExpiryBars,
  rewardRisk: ictResearchCandidateV1.rewardRisk,
  stopBufferAtr: ictResearchCandidateV1.stopBufferAtr,
  maxStopAtr: ictResearchCandidateV1.maxStopAtr,
  allowWeekends: ictResearchCandidateV1.allowWeekends,
  volatilityFilter: ictResearchCandidateV1.volatilityFilter,
  sessionTimeZone: ictResearchCandidateV1.sessionTimeZone,
  sessionStartMinute: ictResearchCandidateV1.sessionStartMinute,
  sessionEndMinute: ictResearchCandidateV1.sessionEndMinute,
  minNetRewardRisk: ictResearchCandidateV1Backtest.minNetRewardRisk,
  stopExecutionMode: ictResearchCandidateV1Backtest.stopExecutionMode,
} as const;

export const ictResearchCandidateV1Decision = {
  development: { period: "2021-01..2023-12", trades: 72, netPnl: 363.96, profitFactor: 1.371, averageR: 0.239 },
  validation: { period: "2024-01..2025-06", trades: 74, netPnl: 118.7, profitFactor: 1.107, averageR: 0.064 },
  finalHoldout: { period: "2025-07..2026-06", trades: 34, netPnl: 191.25, profitFactor: 1.452, averageR: 0.254 },
  validationPassed: false,
  deploymentEligible: false,
  allowedModes: ["backtest", "demo_shadow", "hyperliquid_testnet_readonly_validation"] as const,
  blockedModes: ["demo_auto_order", "hyperliquid_testnet_auto_order", "mainnet_order"] as const,
} as const;

export const ictResearchCandidateV2: IctLiquidityReversalConfig = {
  ...ictResearchCandidateV1,
  entryMode: "next_bar_market",
  displacementBodyAtr: 0.3,
  maxStopAtr: 5,
  setupExpiryBars: 12,
  rewardRisk: 3,
  volatilityFilter: "all",
  minimumVolatilityRatio: 1.25,
  fvgRetraceFraction: 0.5,
};

export const ictResearchCandidateV2Backtest: BacktestConfig = {
  ...ictResearchCandidateV1Backtest,
  maxTradesPerDay: 3,
  takerEntryFeeRate: 0.00045,
};

export const ictResearchCandidateV2WorkerParameters = {
  biasMode: ictResearchCandidateV2.biasMode,
  displacementBodyAtr: ictResearchCandidateV2.displacementBodyAtr,
  sweepLookbackBars: ictResearchCandidateV2.sweepLookbackBars,
  setupExpiryBars: ictResearchCandidateV2.setupExpiryBars,
  rewardRisk: ictResearchCandidateV2.rewardRisk,
  stopBufferAtr: ictResearchCandidateV2.stopBufferAtr,
  maxStopAtr: ictResearchCandidateV2.maxStopAtr,
  allowWeekends: ictResearchCandidateV2.allowWeekends,
  volatilityFilter: ictResearchCandidateV2.volatilityFilter,
  minimumVolatilityRatio: ictResearchCandidateV2.minimumVolatilityRatio,
  fvgRetraceFraction: ictResearchCandidateV2.fvgRetraceFraction,
  entryMode: ictResearchCandidateV2.entryMode,
  sessionTimeZone: ictResearchCandidateV2.sessionTimeZone,
  sessionStartMinute: ictResearchCandidateV2.sessionStartMinute,
  sessionEndMinute: ictResearchCandidateV2.sessionEndMinute,
  minNetRewardRisk: ictResearchCandidateV2Backtest.minNetRewardRisk,
  maxTradesPerDay: ictResearchCandidateV2Backtest.maxTradesPerDay,
  stopExecutionMode: ictResearchCandidateV2Backtest.stopExecutionMode,
} as const;

export const ictResearchCandidateV3: IctLiquidityReversalConfig = {
  ...ictResearchCandidateV2,
  maxStopAtr: 4.25,
  rewardRisk: 2.5,
};

export const ictResearchCandidateV3Backtest: BacktestConfig = {
  ...ictResearchCandidateV2Backtest,
};

export const ictResearchCandidateV3WorkerParameters = {
  ...ictResearchCandidateV2WorkerParameters,
  maxStopAtr: ictResearchCandidateV3.maxStopAtr,
  rewardRisk: ictResearchCandidateV3.rewardRisk,
} as const;

export const ictResearchCandidateV4: IctLiquidityReversalConfig = {
  ...ictResearchCandidateV3,
  maxStopAtr: 4,
  minimumVolatilityRatio: 1.18,
};

export const ictResearchCandidateV4Backtest: BacktestConfig = {
  ...ictResearchCandidateV3Backtest,
};

export const ictResearchCandidateV4WorkerParameters = {
  ...ictResearchCandidateV3WorkerParameters,
  maxStopAtr: ictResearchCandidateV4.maxStopAtr,
  minimumVolatilityRatio: ictResearchCandidateV4.minimumVolatilityRatio,
} as const;

// V5 changes execution policy only: the session gates new entries, while open
// positions remain managed by their structural stop/target. Account-level risk
// gates are intentionally disabled during strategy research.
export const ictResearchCandidateV5 = {
  ...ictResearchCandidateV3,
} satisfies IctLiquidityReversalConfig;

export const ictResearchCandidateV5Backtest: BacktestConfig = {
  ...ictResearchCandidateV3Backtest,
  closePositionAtSessionEnd: false,
  accountRiskControlsEnabled: false,
};

export const ictResearchCandidateV5WorkerParameters = {
  ...ictResearchCandidateV3WorkerParameters,
  closePositionAtSessionEnd: false,
  accountRiskControlsEnabled: false,
} as const;

export const ictResearchCandidateV5Decision = {
  development: {
    period: "2024-01..2025-12",
    trades: 159,
    netPnl: 1042.88,
    profitFactor: 1.427,
    averageR: 0.271,
    maxDrawdownFraction: 0.0236,
    yearlyTrades: { 2024: 77, 2025: 82 },
  },
  historicalRecalculation: {
    period: "2026-01-01..2026-07-13",
    trades: 33,
    netPnl: 188.6,
    profitFactor: 1.368,
    averageR: 0.235,
    maxDrawdownFraction: 0.0101,
  },
  historicalQualityPassed: true,
  cleanHoldoutAvailable: false,
  frequencyTargetPassed: false,
  shadowEligible: true,
  automaticExecutionEligible: false,
  changeReason: "session_entry_gate_only_and_account_risk_controls_disabled",
} as const;

export const ictResearchCandidateV6: IctLiquidityReversalConfig = {
  ...ictResearchCandidateV5,
  stopDistanceMode: "price_fraction_floor",
  minimumStopPriceFraction: 1 / 120,
  maximumStructuralStopPriceFraction: 1 / 120,
};

export const ictResearchCandidateV6Backtest: BacktestConfig = {
  ...ictResearchCandidateV5Backtest,
};

export const ictResearchCandidateV6WorkerParameters = {
  ...ictResearchCandidateV5WorkerParameters,
  stopDistanceMode: ictResearchCandidateV6.stopDistanceMode,
  minimumStopPriceFraction: ictResearchCandidateV6.minimumStopPriceFraction,
  maximumStructuralStopPriceFraction: ictResearchCandidateV6.maximumStructuralStopPriceFraction,
} as const;

export const ictResearchCandidateV6Decision = {
  routeId: "ict-route-a-opportunity-expansion",
  rule: "price_fraction_stop_floor_0.8333pct",
  development: {
    period: "2024-01..2025-12",
    trades: 77,
    netPnl: 479.23,
    profitFactor: 1.404,
    averageR: 0.26,
    maxDrawdownFraction: 0.0342,
    yearlyTrades: { 2024: 30, 2025: 47 },
  },
  historicalRecalculation: {
    period: "2026-01-01..2026-07-13",
    trades: 17,
    netPnl: 116.68,
    profitFactor: 1.46,
    averageR: 0.29,
    maxDrawdownFraction: 0.005,
  },
  qualityPassed: true,
  opportunityExpansionPassed: false,
  status: "rejected_for_route_objective",
  shadowEligible: false,
  automaticExecutionEligible: false,
} as const;

export const ictResearchCandidateV3Decision = {
  development: {
    period: "2024-01..2025-12",
    trades: 162,
    netPnl: 802.01,
    profitFactor: 1.443,
    averageR: 0.205,
    yearlyTrades: { 2024: 79, 2025: 83 },
  },
  finalHoldout: {
    period: "2026-01-01..2026-07-13",
    trades: 34,
    netPnl: 110.13,
    profitFactor: 1.292,
    averageR: 0.135,
  },
  qualityPassed: true,
  frequencyTargetPassed: false,
  shadowEligible: true,
  automaticExecutionEligible: false,
  rejectedExtensions: ["ETHUSDT", "mss_continuation", "minimum_volatility_ratio_1.18"] as const,
} as const;
