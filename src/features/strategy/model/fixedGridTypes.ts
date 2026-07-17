import type { MartingaleSymbol } from "./martingaleTypes";

export type FixedGridSide = "long" | "short";
export type FixedGridOrderStatus = "working" | "filled" | "cancelled";

export type FixedGridFill = {
  level: number;
  time: string | null;
  price: number;
  quantity: number;
  notional: number;
  fee: number;
};

export type FixedGridOrder = {
  level: number;
  price: number;
  status: FixedGridOrderStatus;
  marginFraction: number;
  notional: number | null;
  quantity: number | null;
  filledAt: string | null;
};

export type FixedGridWorkingPlan = {
  id: string;
  symbol: MartingaleSymbol;
  side: FixedGridSide;
  anchorPrice: number;
  confirmedAt: string | null;
  expiresAt: string | null;
  orders: FixedGridOrder[];
};

export type FixedGridOpenGroup = {
  id: string;
  symbol: MartingaleSymbol;
  side: FixedGridSide;
  anchorPrice: number;
  confirmedAt: string | null;
  entryTime: string | null;
  fills: FixedGridFill[];
  orders: FixedGridOrder[];
  averageEntryPrice: number;
  targetPrice: number;
  stopPrice: number;
  quantity: number;
  plannedRisk: number;
  markPrice: number;
  unrealizedPnl: number;
  feesPaid: number;
};

export type FixedGridCompletedGroup = Omit<FixedGridOpenGroup, "markPrice" | "unrealizedPnl" | "feesPaid"> & {
  exitTime: string | null;
  exitPrice: number;
  exitReason: "take_profit" | "group_stop" | "timeout";
  grossPnl: number;
  netPnl: number;
  fees: number;
  rMultiple: number;
  holdingMinutes: number;
};

export type FixedGridWorkerStatus = {
  enabled: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextCheckAt: string | null;
  consecutiveFailures: number;
  lastError: "source_unavailable" | "data_gap" | "report_write_failed" | "worker_failed" | null;
  lastCompletedCandleAt: Record<MartingaleSymbol, string | null>;
};

export type FixedGridForwardReport = {
  routeId: "binance-usdm-martingale-grid-fixed-step-htf-v3-paper";
  status: "collecting" | "observation_gate_reached_pending_review" | "unavailable";
  forwardStart: string | null;
  through: string | null;
  elapsedDays: number;
  observationGate: { minimumDays: number; minimumCompletedGroups: number; mode: "either"; reached: boolean };
  assumptions: {
    venue: "binance_usdm_public_market_data";
    symbols: MartingaleSymbol[];
    sourceInterval: "5m";
    directionIntervals: ["4h", "1h"];
    entryModel: "fixed_price_distance";
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
    maximumLayers: 12;
    sizeMultiplier: number;
    cumulativeMarginFractionCap: number;
    maximumGroupLossFraction: number;
    targetGridSteps: number;
    stopBeyondLastGridSteps: number;
    directionValidityHours: number;
    swingLeftBars: number;
    swingRightBars: number;
    maximumHoldingMinutes: number;
    takerFeeRate: number;
    slippageRate: number;
    stopAfterLossForUtcDay: true;
    gridStepBySymbol: Record<MartingaleSymbol, number>;
    directionModel: string;
    riskScaling: string;
    oneGroupPerSymbol: true;
  };
  dataQuality: {
    source: "binance_futures_public_rest" | "binance_vision_usdm_archive";
    interval: "5m";
    updatedAt: string | null;
    symbols: Record<MartingaleSymbol, { candleCount: number; missingBarCount: number; through: string | null }>;
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
    confirmations: number;
    expiredPlans: number;
    startedGroups: number;
    takeProfits: number;
    groupStops: number;
    timeouts: number;
    dailyLossLocks: number;
    bySymbol: Record<MartingaleSymbol, {
      confirmations: number;
      expiredPlans: number;
      completedGroups: number;
      totalFills: number;
      realizedNetPnl: number;
      openGroup: boolean;
      workingPlan: boolean;
    }>;
  };
  directions: Record<MartingaleSymbol, {
    fourHourBias: "long" | "short" | "neutral";
    oneHourConfirmation: "long_break" | "short_break" | "none";
    status: "waiting_for_structure" | "orders_working" | "group_open" | "daily_locked";
    anchorPrice: number | null;
    confirmedAt: string | null;
    expiresAt: string | null;
  }>;
  workingPlans: FixedGridWorkingPlan[];
  openGroups: FixedGridOpenGroup[];
  recentCompletedGroups: FixedGridCompletedGroup[];
  worker?: FixedGridWorkerStatus;
  warnings: string[];
};
