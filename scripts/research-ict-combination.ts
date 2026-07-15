import { BacktestEngine, defaultBacktestConfig } from "../server/modules/strategy/backtest/BacktestEngine";
import { BinanceVisionHistoricalDataSource, monthRange } from "../server/modules/strategy/backtest/BinanceVisionHistoricalDataSource";
import {
  defaultIctLiquidityReversalConfig,
  IctLiquidityReversalStrategy,
  type IctLiquidityReversalConfig,
} from "../server/modules/strategy/models/IctLiquidityReversalStrategy";

type ResearchParameters = Pick<
  IctLiquidityReversalConfig,
  "symbol" | "biasMode" | "displacementBodyAtr" | "sweepLookbackBars" | "setupExpiryBars" | "rewardRisk" | "stopBufferAtr" | "maxStopAtr" | "allowWeekends" | "volatilityFilter" | "minimumVolatilityRatio" | "fvgRetraceFraction" | "entryMode" | "setupMode" | "sessionStartMinute" | "sessionEndMinute" | "sessionTimeZone" | "stopDistanceMode" | "minimumStopPriceFraction" | "maximumStructuralStopPriceFraction"
> & {
  minNetRewardRisk: number;
  stopExecutionMode?: "hard" | "session_close_only";
  maxTradesPerDay?: number;
  closePositionAtSessionEnd?: boolean;
  accountRiskControlsEnabled?: boolean;
};

const [startMonth, endMonth, serializedParameters] = process.argv.slice(2);
if (!startMonth || !endMonth || !serializedParameters) {
  throw new Error("Usage: research-ict-combination <start YYYY-MM> <end YYYY-MM> <parameters JSON>");
}

const parameters = JSON.parse(serializedParameters) as ResearchParameters;
const researchSymbol = parameters.symbol === "ETHUSDT" ? "ETHUSDT" : "BTCUSDT";
const source = new BinanceVisionHistoricalDataSource();
const { candles, quality } = await source.loadMonths(monthRange(startMonth, endMonth, researchSymbol));
if (quality.missingBarCount > 0) {
  throw new Error(`Research data contains ${quality.missingBarCount} missing 5m bars.`);
}

const strategy = new IctLiquidityReversalStrategy({
  ...defaultIctLiquidityReversalConfig,
  symbol: researchSymbol,
  biasMode: parameters.biasMode,
  displacementBodyAtr: parameters.displacementBodyAtr,
  sweepLookbackBars: parameters.sweepLookbackBars,
  setupExpiryBars: parameters.setupExpiryBars,
  rewardRisk: parameters.rewardRisk,
  stopBufferAtr: parameters.stopBufferAtr,
  maxStopAtr: parameters.maxStopAtr ?? defaultIctLiquidityReversalConfig.maxStopAtr,
  allowWeekends: parameters.allowWeekends ?? defaultIctLiquidityReversalConfig.allowWeekends,
  volatilityFilter: parameters.volatilityFilter ?? defaultIctLiquidityReversalConfig.volatilityFilter,
  minimumVolatilityRatio: parameters.minimumVolatilityRatio ?? defaultIctLiquidityReversalConfig.minimumVolatilityRatio,
  fvgRetraceFraction: parameters.fvgRetraceFraction ?? defaultIctLiquidityReversalConfig.fvgRetraceFraction,
  entryMode: parameters.entryMode ?? defaultIctLiquidityReversalConfig.entryMode,
  setupMode: parameters.setupMode ?? defaultIctLiquidityReversalConfig.setupMode,
  sessionStartMinute: parameters.sessionStartMinute ?? defaultIctLiquidityReversalConfig.sessionStartMinute,
  sessionEndMinute: parameters.sessionEndMinute ?? defaultIctLiquidityReversalConfig.sessionEndMinute,
  sessionTimeZone: parameters.sessionTimeZone ?? defaultIctLiquidityReversalConfig.sessionTimeZone,
  stopDistanceMode: parameters.stopDistanceMode ?? defaultIctLiquidityReversalConfig.stopDistanceMode,
  minimumStopPriceFraction: parameters.minimumStopPriceFraction ?? defaultIctLiquidityReversalConfig.minimumStopPriceFraction,
  maximumStructuralStopPriceFraction: parameters.maximumStructuralStopPriceFraction ?? defaultIctLiquidityReversalConfig.maximumStructuralStopPriceFraction,
});
const result = new BacktestEngine(strategy, {
  ...defaultBacktestConfig,
  minNetRewardRisk: parameters.minNetRewardRisk,
  stopExecutionMode: parameters.stopExecutionMode ?? "hard",
  sessionStartMinute: parameters.sessionStartMinute ?? defaultBacktestConfig.sessionStartMinute,
  sessionEndMinute: parameters.sessionEndMinute ?? defaultBacktestConfig.sessionEndMinute,
  sessionTimeZone: parameters.sessionTimeZone ?? defaultBacktestConfig.sessionTimeZone,
  maxTradesPerDay: parameters.maxTradesPerDay ?? defaultBacktestConfig.maxTradesPerDay,
  closePositionAtSessionEnd: parameters.closePositionAtSessionEnd ?? defaultBacktestConfig.closePositionAtSessionEnd,
  accountRiskControlsEnabled: parameters.accountRiskControlsEnabled ?? defaultBacktestConfig.accountRiskControlsEnabled,
}).run(candles);

process.stdout.write(JSON.stringify({
  quality,
  row: {
    parameters,
    diagnostics: result.diagnostics,
    metrics: result.metrics,
    regimeMetrics: summarizeRegimes(result.trades),
    sideMetrics: summarizeTrades(result.trades, (trade) => trade.side),
    exitMetrics: summarizeTrades(result.trades, (trade) => trade.exitReason),
  },
}));
strategy.release();

function summarizeRegimes(trades: Array<{ regimeKey: string; netPnl: number; rMultiple: number }>) {
  const groups: Record<string, { trades: number; wins: number; netPnl: number; averageR: number }> = {};
  for (const trade of trades) {
    groups[trade.regimeKey] ??= { trades: 0, wins: 0, netPnl: 0, averageR: 0 };
    const group = groups[trade.regimeKey];
    group.trades += 1;
    group.wins += trade.netPnl > 0 ? 1 : 0;
    group.netPnl += trade.netPnl;
    group.averageR += trade.rMultiple;
  }
  for (const group of Object.values(groups)) group.averageR = group.trades ? group.averageR / group.trades : 0;
  return groups;
}

function summarizeTrades<T extends { netPnl: number; rMultiple: number }>(
  trades: T[],
  key: (trade: T) => string,
) {
  const groups: Record<string, { trades: number; wins: number; netPnl: number; averageR: number }> = {};
  for (const trade of trades) {
    const groupKey = key(trade);
    groups[groupKey] ??= { trades: 0, wins: 0, netPnl: 0, averageR: 0 };
    groups[groupKey].trades += 1;
    groups[groupKey].wins += trade.netPnl > 0 ? 1 : 0;
    groups[groupKey].netPnl += trade.netPnl;
    groups[groupKey].averageR += trade.rMultiple;
  }
  for (const group of Object.values(groups)) group.averageR = group.trades ? group.averageR / group.trades : 0;
  return groups;
}
