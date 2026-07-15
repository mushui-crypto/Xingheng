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
  assumptions: {
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
  dataQuality: {
    source: string;
    interval: "5m";
    candleCount: number;
    missingBarCount: number;
    updatedAt: string | null;
  };
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
  warnings: string[];
};
