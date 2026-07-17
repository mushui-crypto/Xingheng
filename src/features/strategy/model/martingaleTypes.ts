import type { StrategyCandle, StrategyCandleInterval } from "./types";

export type MartingaleSymbol = "BTCUSDT" | "ETHUSDT";
export type MartingaleSide = "long" | "short";
export type MartingaleExitReason = "take_profit" | "group_stop" | "timeout" | string;

export type MartingaleFill = {
  level: number | null;
  time: string | null;
  price: number | null;
  quantity: number | null;
  notional: number | null;
  fee: number | null;
};

export type MartingaleOpenGroup = {
  id: string | null;
  symbol: MartingaleSymbol | null;
  side: MartingaleSide | null;
  signalTime: string | null;
  entryTime: string | null;
  fills: MartingaleFill[];
  averageEntryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  nextGridPrice: number | null;
  quantity: number | null;
  plannedRisk: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  feesPaid: number | null;
};

export type MartingaleCompletedGroup = Omit<MartingaleOpenGroup, "markPrice" | "nextGridPrice" | "unrealizedPnl" | "feesPaid"> & {
  exitTime: string | null;
  exitPrice: number | null;
  exitReason: MartingaleExitReason | null;
  grossPnl: number | null;
  netPnl: number | null;
  fees: number | null;
  rMultiple: number | null;
  holdingMinutes: number | null;
};

export type MartingaleGroup = MartingaleOpenGroup | MartingaleCompletedGroup;

export type MartingaleWorkerStatus = {
  enabled: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextCheckAt: string | null;
  consecutiveFailures: number;
  lastError: "source_unavailable" | "data_gap" | "report_write_failed" | "worker_failed" | null;
  lastCompletedCandleAt: Record<MartingaleSymbol, string | null>;
};

export type MartingaleForwardReport = {
  routeId: "binance-usdm-martingale-grid-paper-v1";
  status: "collecting" | "observation_gate_reached_pending_review" | "unavailable";
  forwardStart: string | null;
  through: string | null;
  elapsedDays: number;
  observationGate: {
    minimumDays: number;
    minimumCompletedGroups: number;
    mode: "either";
    reached: boolean;
  };
  assumptions: {
    venue: "binance_usdm_public_market_data";
    symbols: MartingaleSymbol[];
    interval: "5m";
    trendInterval: "15m";
    paperOnly: true;
    automaticPaperEnabled: true;
    automaticOrdersEnabled: false;
    exchangeCredentialsRequired: false;
    fundingIgnored: true;
    markPriceAndLiquidationIgnored: true;
  };
  configuration: {
    initialEquityPerSymbol: number;
    leverageSelection: number;
    marginMode: "isolated";
    baseMarginFraction: number;
    sizeMultiplier: number;
    maximumLayers: number;
    atrPeriod: number;
    rsiPeriod: number;
    fastEmaPeriod15m: number;
    slowEmaPeriod15m: number;
    longRsiThreshold: number;
    shortRsiThreshold: number;
    gridAtrMultiple: number;
    minimumGridFraction: number;
    targetAtrMultiple: number;
    minimumTargetFraction: number;
    stopBeyondLastGridSteps: number;
    maximumGroupLossFraction: number;
    maximumHoldingMinutes: number;
    takerFeeRate: number;
    slippageRate: number;
    stopAfterLossForUtcDay: true;
    directionMode: string;
    entryModel: string;
    gridModel: string;
    exitModel: string;
    oneGroupPerSymbol: true;
  };
  dataQuality: {
    source: "binance_futures_public_rest";
    interval: "5m";
    updatedAt: string | null;
    symbols: Record<MartingaleSymbol, {
      candleCount: number;
      missingBarCount: number;
      through: string | null;
    }>;
  };
  metrics: {
    completedGroups: number;
    totalFills: number;
    realizedNetPnl: number;
    unrealizedPnl: number;
    profitFactor: number | null;
    averageR: number;
    maxMarkToMarketDrawdownFraction: number;
    initialEquity: number;
    currentEquity: number;
    fees: number;
  };
  diagnostics: {
    signals: number;
    startedGroups: number;
    takeProfits: number;
    groupStops: number;
    timeouts: number;
    dailyLossLocks: number;
    bySymbol: Record<MartingaleSymbol, {
      signals: number;
      completedGroups: number;
      totalFills: number;
      realizedNetPnl: number;
      openGroup: boolean;
    }>;
  };
  openGroups: MartingaleOpenGroup[];
  recentCompletedGroups: MartingaleCompletedGroup[];
  worker?: MartingaleWorkerStatus;
  warnings: string[];
};

export type MartingaleCandlesQuery = {
  symbol: MartingaleSymbol;
  interval: StrategyCandleInterval;
  from: string;
  to: string;
  limit?: number;
};

export type MartingaleCandlesReport = {
  source: "binance_usdm";
  symbol: MartingaleSymbol;
  interval: StrategyCandleInterval;
  status: "available" | "unavailable";
  requestedRange: { from: string; to: string };
  dataThrough: string | null;
  candles: StrategyCandle[];
  warnings: string[];
};
