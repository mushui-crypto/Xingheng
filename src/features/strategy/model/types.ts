export type StrategyForwardMetrics = {
  tradeCount: number;
  netPnl: number;
  profitFactor: number | null;
  averageR: number;
  maxDrawdownFraction: number;
  initialEquity: number;
  finalEquity: number;
  fees: number;
};

export type StrategyForwardTrade = {
  side: "long" | "short" | null;
  signalTime: string | null;
  entryTime: string | null;
  exitTime: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  quantity: number | null;
  fees: number | null;
  netPnl: number | null;
  rMultiple: number | null;
  exitReason: string | null;
};

export type StrategyAssumptions = {
  venue: "binance_usdm_btcusdt_perpetual";
  symbol: "BTCUSDT";
  leverageSelection: 100;
  marginMode: "cross";
  marginFraction: number;
  effectiveNotionalEquityMultiple: 2;
  onePositionAtATime: true;
  fundingIgnored: true;
  markPriceAndDynamicBracketIgnored: true;
  automaticOrdersEnabled: false;
};

export type StrategyDataQuality = {
  source: string;
  interval: "5m";
  candleCount: number;
  missingBarCount: number;
  updatedAt: string | null;
};

export type StrategyForwardWorker = {
  enabled: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCompletedCandleAt: string | null;
  nextCheckAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
};

export type StrategyForwardReport = {
  routeId: string;
  status: "collecting" | "observation_gate_reached_pending_review" | "unavailable";
  forwardStart: string | null;
  through: string | null;
  elapsedDays: number;
  observationGate: {
    minimumDays: number;
    minimumCompletedTrades: number;
    mode: "either";
    reached: boolean;
  };
  assumptions: StrategyAssumptions;
  dataQuality: StrategyDataQuality;
  metrics: StrategyForwardMetrics;
  diagnostics: {
    signals: number;
    filled: number;
    expired: number;
    costRejected: number;
    byRegime: Record<string, unknown>;
  };
  openPosition: StrategyForwardTrade | null;
  recentCompletedTrades: StrategyForwardTrade[];
  worker?: StrategyForwardWorker;
  warnings: string[];
};

export type StrategyHistoryReport = {
  routeId: string;
  status: "available" | "unavailable";
  requestedRange: { from: string | null; to: string | null };
  availableRange: { from: string | null; to: string | null };
  dataThrough: string | null;
  attributionField: "entryTime";
  dataQuality: StrategyDataQuality;
  metrics: StrategyForwardMetrics;
  completedTrades: StrategyForwardTrade[];
  pagination: {
    limit: number;
    cursor: string | null;
    nextCursor: string | null;
    hasMore: boolean;
    total: number;
  };
  assumptions: StrategyAssumptions;
  warnings: string[];
};

export type StrategyHistoryQuery = {
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
};

export type StrategyCandleInterval = "5m" | "15m" | "1h" | "4h";

export type StrategyCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type StrategyCandlesReport = {
  source: "binance_usdm";
  symbol: "BTCUSDT";
  interval: StrategyCandleInterval;
  status: "available" | "unavailable";
  requestedRange: { from: string; to: string };
  dataThrough: string | null;
  candles: StrategyCandle[];
  warnings: string[];
};

export type StrategyCandlesQuery = {
  interval: StrategyCandleInterval;
  from: string;
  to: string;
  limit?: number;
};
