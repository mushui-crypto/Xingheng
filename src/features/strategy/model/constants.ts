export const strategyObservationDefaults = {
  forwardStartIso: "2026-07-15T00:00:00Z",
  minimumDays: 60,
  minimumCompletedTrades: 50,
} as const;

export const strategyConfigDefaults = {
  venue: "Binance USD-M BTCUSDT 永续",
  directionTimeframe: "15m",
  entryTimeframe: "5m",
  leverage: 100,
  marginMode: "全仓",
  initialMarginFraction: 0.02,
  effectiveNotionalEquityMultiple: 2,
  maximumConcurrentPositions: 1,
} as const;
