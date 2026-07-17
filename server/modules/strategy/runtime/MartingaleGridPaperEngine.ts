import type { Candle } from "../../../types";
import { aggregateCandles } from "../core/candles";
import { atomicWriteJson } from "./RouteBPaperEngine";

export const MARTINGALE_GRID_ROUTE_ID = "binance-usdm-martingale-grid-paper-v1";
export const MARTINGALE_GRID_FORWARD_START_ISO = "2026-07-16T19:20:00.000Z";
export const MARTINGALE_GRID_FORWARD_START = Math.floor(Date.parse(MARTINGALE_GRID_FORWARD_START_ISO) / 1000);
export const MARTINGALE_GRID_INTERVAL = "5m" as const;
export const MARTINGALE_GRID_INTERVAL_SECONDS = 5 * 60;
export const MARTINGALE_GRID_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;

export type MartingaleGridSymbol = typeof MARTINGALE_GRID_SYMBOLS[number];
export type MartingaleGridSide = "long" | "short";
export type MartingaleGridExitReason = "take_profit" | "group_stop" | "timeout";

export type MartingaleGridConfig = {
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
};

export const MARTINGALE_GRID_CONFIG: Readonly<MartingaleGridConfig> = Object.freeze({
  initialEquityPerSymbol: 5_000,
  leverageSelection: 5,
  marginMode: "isolated",
  baseMarginFraction: 0.005,
  sizeMultiplier: 1.35,
  maximumLayers: 5,
  atrPeriod: 14,
  rsiPeriod: 14,
  fastEmaPeriod15m: 50,
  slowEmaPeriod15m: 200,
  longRsiThreshold: 30,
  shortRsiThreshold: 70,
  gridAtrMultiple: 0.75,
  minimumGridFraction: 0.0035,
  targetAtrMultiple: 0.5,
  minimumTargetFraction: 0.0025,
  stopBeyondLastGridSteps: 2,
  maximumGroupLossFraction: 0.015,
  maximumHoldingMinutes: 24 * 60,
  takerFeeRate: 0.00045,
  slippageRate: 0.0001,
  stopAfterLossForUtcDay: true,
});

export type MartingaleGridFill = {
  level: number;
  time: number;
  price: number;
  quantity: number;
  notional: number;
  fee: number;
};

export type MartingaleGridCompletedGroup = {
  id: string;
  symbol: MartingaleGridSymbol;
  side: MartingaleGridSide;
  signalTime: number;
  entryTime: number;
  exitTime: number;
  exitPrice: number;
  exitReason: MartingaleGridExitReason;
  fills: MartingaleGridFill[];
  averageEntryPrice: number;
  stopPrice: number;
  targetPrice: number;
  quantity: number;
  grossPnl: number;
  netPnl: number;
  fees: number;
  plannedRisk: number;
  rMultiple: number;
  holdingMinutes: number;
};

export type MartingaleGridOpenGroup = {
  id: string;
  symbol: MartingaleGridSymbol;
  side: MartingaleGridSide;
  signalTime: number;
  entryTime: number;
  fills: MartingaleGridFill[];
  averageEntryPrice: number;
  stopPrice: number;
  targetPrice: number;
  nextGridPrice: number | null;
  quantity: number;
  plannedRisk: number;
  markPrice: number;
  unrealizedPnl: number;
  feesPaid: number;
};

export type MartingaleGridPaperReport = {
  routeId: typeof MARTINGALE_GRID_ROUTE_ID;
  status: "collecting" | "observation_gate_reached_pending_review";
  forwardStart: number;
  forwardStartIso: string;
  through: number | null;
  throughIso: string | null;
  elapsedDays: number;
  observationGate: { minimumDays: 60; minimumCompletedGroups: 100; mode: "either"; reached: boolean };
  assumptions: {
    venue: "binance_usdm_public_market_data";
    symbols: MartingaleGridSymbol[];
    interval: "5m";
    trendInterval: "15m";
    paperOnly: true;
    automaticPaperEnabled: true;
    automaticOrdersEnabled: false;
    exchangeCredentialsRequired: false;
    fundingIgnored: true;
    markPriceAndLiquidationIgnored: true;
  };
  configuration: MartingaleGridConfig & {
    directionMode: "trend_filtered_bidirectional";
    entryModel: "15m_ema_trend_plus_5m_rsi_cross";
    gridModel: "atr_or_fraction_whichever_is_wider";
    exitModel: "weighted_average_group_target_with_hard_group_stop";
    oneGroupPerSymbol: true;
  };
  dataQuality: {
    source: "binance_futures_public_rest";
    interval: "5m";
    updatedAt: string | null;
    symbols: Record<MartingaleGridSymbol, { candleCount: number; missingBarCount: number; through: string | null }>;
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
    bySymbol: Record<MartingaleGridSymbol, {
      signals: number;
      completedGroups: number;
      totalFills: number;
      realizedNetPnl: number;
      openGroup: boolean;
    }>;
  };
  openGroups: MartingaleGridOpenGroup[];
  recentCompletedGroups: MartingaleGridCompletedGroup[];
};

type PendingSignal = { side: MartingaleGridSide; signalTime: number; atr: number };

type InternalOpenGroup = Omit<MartingaleGridOpenGroup, "markPrice" | "unrealizedPnl" | "feesPaid"> & {
  initialPrice: number;
  baseNotional: number;
  gridStep: number;
  targetDistance: number;
  feesPaid: number;
};

type SymbolSimulation = {
  completed: MartingaleGridCompletedGroup[];
  open: MartingaleGridOpenGroup | null;
  equityCurve: Array<{ time: number; equity: number }>;
  diagnostics: { signals: number; startedGroups: number; dailyLossLocks: number };
};

export function buildMartingaleGridPaperReport(
  candlesBySymbol: Record<MartingaleGridSymbol, Candle[]>,
  options: { forwardStart?: number; config?: Partial<MartingaleGridConfig> } = {},
): MartingaleGridPaperReport {
  const config = makeConfig(options.config);
  const forwardStart = options.forwardStart ?? MARTINGALE_GRID_FORWARD_START;
  const simulations = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [
    symbol,
    simulateMartingaleGridSymbol(symbol, candlesBySymbol[symbol], { forwardStart, config }),
  ])) as Record<MartingaleGridSymbol, SymbolSimulation>;
  const completed = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].completed)
    .sort((left, right) => left.exitTime - right.exitTime);
  const openGroups = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].open ? [simulations[symbol].open!] : []);
  const throughValues = MARTINGALE_GRID_SYMBOLS.map((symbol) => candlesBySymbol[symbol].at(-1)?.time).filter((value): value is number => value !== undefined);
  const through = throughValues.length === MARTINGALE_GRID_SYMBOLS.length ? Math.min(...throughValues) : null;
  const elapsedDays = through === null ? 0 : Math.max(0, (through - forwardStart) / 86_400);
  const gateReached = elapsedDays >= 60 || completed.length >= 100;
  const metrics = calculateCombinedMetrics(simulations, completed, openGroups, config);

  return {
    routeId: MARTINGALE_GRID_ROUTE_ID,
    status: gateReached ? "observation_gate_reached_pending_review" : "collecting",
    forwardStart,
    forwardStartIso: new Date(forwardStart * 1000).toISOString(),
    through,
    throughIso: through === null ? null : new Date(through * 1000).toISOString(),
    elapsedDays,
    observationGate: { minimumDays: 60, minimumCompletedGroups: 100, mode: "either", reached: gateReached },
    assumptions: {
      venue: "binance_usdm_public_market_data",
      symbols: [...MARTINGALE_GRID_SYMBOLS],
      interval: "5m",
      trendInterval: "15m",
      paperOnly: true,
      automaticPaperEnabled: true,
      automaticOrdersEnabled: false,
      exchangeCredentialsRequired: false,
      fundingIgnored: true,
      markPriceAndLiquidationIgnored: true,
    },
    configuration: {
      ...config,
      directionMode: "trend_filtered_bidirectional",
      entryModel: "15m_ema_trend_plus_5m_rsi_cross",
      gridModel: "atr_or_fraction_whichever_is_wider",
      exitModel: "weighted_average_group_target_with_hard_group_stop",
      oneGroupPerSymbol: true,
    },
    dataQuality: {
      source: "binance_futures_public_rest",
      interval: "5m",
      updatedAt: through === null ? null : new Date(through * 1000).toISOString(),
      symbols: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => {
        const symbolThrough = candlesBySymbol[symbol].at(-1)?.time ?? null;
        return [symbol, {
          candleCount: candlesBySymbol[symbol].length,
          missingBarCount: countMissingBars(candlesBySymbol[symbol]),
          through: symbolThrough === null ? null : new Date(symbolThrough * 1000).toISOString(),
        }];
      })) as MartingaleGridPaperReport["dataQuality"]["symbols"],
    },
    metrics,
    diagnostics: {
      signals: MARTINGALE_GRID_SYMBOLS.reduce((sum, symbol) => sum + simulations[symbol].diagnostics.signals, 0),
      startedGroups: MARTINGALE_GRID_SYMBOLS.reduce((sum, symbol) => sum + simulations[symbol].diagnostics.startedGroups, 0),
      takeProfits: completed.filter((group) => group.exitReason === "take_profit").length,
      groupStops: completed.filter((group) => group.exitReason === "group_stop").length,
      timeouts: completed.filter((group) => group.exitReason === "timeout").length,
      dailyLossLocks: MARTINGALE_GRID_SYMBOLS.reduce((sum, symbol) => sum + simulations[symbol].diagnostics.dailyLossLocks, 0),
      bySymbol: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => {
        const groups = simulations[symbol].completed;
        return [symbol, {
          signals: simulations[symbol].diagnostics.signals,
          completedGroups: groups.length,
          totalFills: groups.reduce((sum, group) => sum + group.fills.length, 0) + (simulations[symbol].open?.fills.length ?? 0),
          realizedNetPnl: groups.reduce((sum, group) => sum + group.netPnl, 0),
          openGroup: Boolean(simulations[symbol].open),
        }];
      })) as MartingaleGridPaperReport["diagnostics"]["bySymbol"],
    },
    openGroups,
    recentCompletedGroups: completed.slice(-50),
  };
}

export function simulateMartingaleGridSymbol(
  symbol: MartingaleGridSymbol,
  inputCandles: Candle[],
  options: { forwardStart?: number; config?: MartingaleGridConfig; signalIntervalMinutes?: 5 | 15 } = {},
): SymbolSimulation {
  const config = options.config ?? makeConfig();
  const forwardStart = options.forwardStart ?? MARTINGALE_GRID_FORWARD_START;
  const candles = normalizeCandles(inputCandles).filter((candle) => candle.symbol === symbol);
  const signalInputs = calculateSignalInputs(candles, config, options.signalIntervalMinutes ?? 5);
  const trendValues = calculateCompleted15mTrend(candles, config.fastEmaPeriod15m, config.slowEmaPeriod15m);
  const completed: MartingaleGridCompletedGroup[] = [];
  const equityCurve: Array<{ time: number; equity: number }> = [];
  let realizedEquity = config.initialEquityPerSymbol;
  let open: InternalOpenGroup | null = null;
  let pending: PendingSignal | null = null;
  let lockedUtcDate: string | null = null;
  let signals = 0;
  let startedGroups = 0;
  let dailyLossLocks = 0;

  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const utcDate = new Date(candle.time * 1000).toISOString().slice(0, 10);
    if (lockedUtcDate && lockedUtcDate !== utcDate) lockedUtcDate = null;

    if (!open && pending && candle.time >= forwardStart && !lockedUtcDate) {
      open = startGroup(symbol, pending, candle, realizedEquity, config);
      pending = null;
      startedGroups += 1;
    }

    if (open) {
      const exit = processOpenGroup(open, candle, config);
      if (exit) {
        completed.push(exit);
        realizedEquity += exit.netPnl;
        open = null;
        if (exit.netPnl < 0 && config.stopAfterLossForUtcDay) {
          lockedUtcDate = utcDate;
          pending = null;
          dailyLossLocks += 1;
        }
      }
    }

    const unrealized = open ? calculateUnrealized(open, candle.close, config.takerFeeRate) : 0;
    equityCurve.push({ time: candle.time, equity: realizedEquity + unrealized });

    if (!open && !pending && !lockedUtcDate && candle.time >= forwardStart) {
      const { currentRsi, previousRsi, atr, eligible } = signalInputs[index];
      const trend = trendValues[index];
      if (eligible && currentRsi !== null && previousRsi !== null && atr !== null && trend) {
        const side = trend === "up" && previousRsi > config.longRsiThreshold && currentRsi <= config.longRsiThreshold
          ? "long"
          : trend === "down" && previousRsi < config.shortRsiThreshold && currentRsi >= config.shortRsiThreshold
            ? "short"
            : null;
        if (side) {
          pending = { side, signalTime: candle.time, atr };
          signals += 1;
        }
      }
    }
  }

  const lastCandle = candles.at(-1);
  return {
    completed,
    open: open && lastCandle ? publicOpenGroup(open, lastCandle.close, config.takerFeeRate) : null,
    equityCurve,
    diagnostics: { signals, startedGroups, dailyLossLocks },
  };
}

function calculateSignalInputs(candles: Candle[], config: MartingaleGridConfig, intervalMinutes: 5 | 15) {
  const empty = () => ({ currentRsi: null, previousRsi: null, atr: null, eligible: false }) as {
    currentRsi: number | null;
    previousRsi: number | null;
    atr: number | null;
    eligible: boolean;
  };
  if (intervalMinutes === 5) {
    const atrValues = calculateAtr(candles, config.atrPeriod);
    const rsiValues = calculateRsi(candles, config.rsiPeriod);
    return candles.map((_, index) => ({
      currentRsi: rsiValues[index],
      previousRsi: index > 0 ? rsiValues[index - 1] : null,
      atr: atrValues[index],
      eligible: true,
    }));
  }

  const aggregated = aggregateCandles(candles, "15m");
  const atrValues = calculateAtr(aggregated, config.atrPeriod);
  const rsiValues = calculateRsi(aggregated, config.rsiPeriod);
  const output = candles.map(empty);
  let completedIndex = -1;
  for (let index = 0; index < candles.length; index += 1) {
    const candleCloseTime = candles[index].time + MARTINGALE_GRID_INTERVAL_SECONDS;
    const previousCompletedIndex = completedIndex;
    while (completedIndex + 1 < aggregated.length && aggregated[completedIndex + 1].time + 15 * 60 <= candleCloseTime) {
      completedIndex += 1;
    }
    if (completedIndex === previousCompletedIndex || completedIndex < 1) continue;
    output[index] = {
      currentRsi: rsiValues[completedIndex],
      previousRsi: rsiValues[completedIndex - 1],
      atr: atrValues[completedIndex],
      eligible: true,
    };
  }
  return output;
}

function startGroup(
  symbol: MartingaleGridSymbol,
  signal: PendingSignal,
  candle: Candle,
  equity: number,
  config: MartingaleGridConfig,
): InternalOpenGroup {
  const initialPrice = adverseEntryPrice(signal.side, candle.open, config.slippageRate);
  const baseNotional = equity * config.baseMarginFraction * config.leverageSelection;
  const gridStep = Math.max(signal.atr * config.gridAtrMultiple, initialPrice * config.minimumGridFraction);
  const targetDistance = Math.max(signal.atr * config.targetAtrMultiple, initialPrice * config.minimumTargetFraction);
  const fill = makeFill(signal.side, 1, candle.time, initialPrice, baseNotional, config.takerFeeRate);
  const planned = buildPlannedFills(signal.side, initialPrice, baseNotional, gridStep, config);
  const structuralStop = signal.side === "long"
    ? initialPrice - gridStep * (config.maximumLayers - 1 + config.stopBeyondLastGridSteps)
    : initialPrice + gridStep * (config.maximumLayers - 1 + config.stopBeyondLastGridSteps);
  const stopPrice = enforceMaximumPlannedLoss(
    signal.side,
    structuralStop,
    planned,
    equity * config.maximumGroupLossFraction,
    config.takerFeeRate,
    config.slippageRate,
  );
  return {
    id: `${MARTINGALE_GRID_ROUTE_ID}-${symbol}-${candle.time}`,
    symbol,
    side: signal.side,
    signalTime: signal.signalTime,
    entryTime: candle.time,
    fills: [fill],
    initialPrice,
    baseNotional,
    gridStep,
    targetDistance,
    averageEntryPrice: fill.price,
    stopPrice,
    targetPrice: targetFor(signal.side, fill.price, targetDistance),
    nextGridPrice: nextGridPrice(signal.side, initialPrice, gridStep, 2, config.maximumLayers),
    quantity: fill.quantity,
    plannedRisk: Math.max(
      0.01,
      -netPnlAtPrice(signal.side, planned, adverseExitPrice(signal.side, stopPrice, config.slippageRate), config.takerFeeRate),
    ),
    feesPaid: fill.fee,
  };
}

function processOpenGroup(
  group: InternalOpenGroup,
  candle: Candle,
  config: MartingaleGridConfig,
): MartingaleGridCompletedGroup | null {
  if (candle.time - group.entryTime >= config.maximumHoldingMinutes * 60) {
    return closeGroup(group, candle.time, adverseExitPrice(group.side, candle.open, config.slippageRate), "timeout", config);
  }

  while (group.fills.length < config.maximumLayers && group.nextGridPrice !== null) {
    const touched = group.side === "long" ? candle.low <= group.nextGridPrice : candle.high >= group.nextGridPrice;
    if (!touched) break;
    const level = group.fills.length + 1;
    const fillPrice = adverseEntryPrice(group.side, group.nextGridPrice, config.slippageRate);
    const notional = group.baseNotional * config.sizeMultiplier ** (level - 1);
    const fill = makeFill(group.side, level, candle.time, fillPrice, notional, config.takerFeeRate);
    group.fills.push(fill);
    group.feesPaid += fill.fee;
    group.quantity += fill.quantity;
    group.averageEntryPrice = weightedAverage(group.fills);
    group.targetPrice = targetFor(group.side, group.averageEntryPrice, group.targetDistance);
    group.nextGridPrice = nextGridPrice(group.side, group.initialPrice, group.gridStep, level + 1, config.maximumLayers);
  }

  const stopped = group.side === "long" ? candle.low <= group.stopPrice : candle.high >= group.stopPrice;
  if (stopped) {
    const gapPrice = group.side === "long" ? Math.min(candle.open, group.stopPrice) : Math.max(candle.open, group.stopPrice);
    return closeGroup(group, candle.time, adverseExitPrice(group.side, gapPrice, config.slippageRate), "group_stop", config);
  }
  const targetHit = group.side === "long" ? candle.high >= group.targetPrice : candle.low <= group.targetPrice;
  if (targetHit) {
    return closeGroup(group, candle.time, adverseExitPrice(group.side, group.targetPrice, config.slippageRate), "take_profit", config);
  }
  return null;
}

function closeGroup(
  group: InternalOpenGroup,
  exitTime: number,
  exitPrice: number,
  exitReason: MartingaleGridExitReason,
  config: MartingaleGridConfig,
): MartingaleGridCompletedGroup {
  const quantity = group.quantity;
  const entryValue = group.fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
  const exitValue = exitPrice * quantity;
  const grossPnl = group.side === "long" ? exitValue - entryValue : entryValue - exitValue;
  const exitFee = exitValue * config.takerFeeRate;
  const fees = group.feesPaid + exitFee;
  const netPnl = grossPnl - fees;
  return {
    id: group.id,
    symbol: group.symbol,
    side: group.side,
    signalTime: group.signalTime,
    entryTime: group.entryTime,
    exitTime,
    exitPrice,
    exitReason,
    fills: group.fills.map((fill) => ({ ...fill })),
    averageEntryPrice: group.averageEntryPrice,
    stopPrice: group.stopPrice,
    targetPrice: group.targetPrice,
    quantity,
    grossPnl,
    netPnl,
    fees,
    plannedRisk: group.plannedRisk,
    rMultiple: netPnl / group.plannedRisk,
    holdingMinutes: (exitTime - group.entryTime) / 60,
  };
}

function publicOpenGroup(group: InternalOpenGroup, markPrice: number, feeRate: number): MartingaleGridOpenGroup {
  return {
    id: group.id,
    symbol: group.symbol,
    side: group.side,
    signalTime: group.signalTime,
    entryTime: group.entryTime,
    fills: group.fills.map((fill) => ({ ...fill })),
    averageEntryPrice: group.averageEntryPrice,
    stopPrice: group.stopPrice,
    targetPrice: group.targetPrice,
    nextGridPrice: group.nextGridPrice,
    quantity: group.quantity,
    plannedRisk: group.plannedRisk,
    markPrice,
    unrealizedPnl: calculateUnrealized(group, markPrice, feeRate),
    feesPaid: group.feesPaid,
  };
}

function calculateUnrealized(group: InternalOpenGroup, price: number, feeRate: number) {
  return netPnlAtPrice(group.side, group.fills, price, feeRate);
}

function calculateCombinedMetrics(
  simulations: Record<MartingaleGridSymbol, SymbolSimulation>,
  completed: MartingaleGridCompletedGroup[],
  openGroups: MartingaleGridOpenGroup[],
  config: MartingaleGridConfig,
): MartingaleGridPaperReport["metrics"] {
  const initialEquity = config.initialEquityPerSymbol * MARTINGALE_GRID_SYMBOLS.length;
  const realizedNetPnl = completed.reduce((sum, group) => sum + group.netPnl, 0);
  const unrealizedPnl = openGroups.reduce((sum, group) => sum + group.unrealizedPnl, 0);
  const grossProfit = completed.filter((group) => group.netPnl > 0).reduce((sum, group) => sum + group.netPnl, 0);
  const grossLoss = -completed.filter((group) => group.netPnl < 0).reduce((sum, group) => sum + group.netPnl, 0);
  const timestamps = [...new Set(MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].equityCurve.map((point) => point.time)))].sort((a, b) => a - b);
  const cursors = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, 0])) as Record<MartingaleGridSymbol, number>;
  const latest = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, config.initialEquityPerSymbol])) as Record<MartingaleGridSymbol, number>;
  let peak = initialEquity;
  let maxDrawdown = 0;
  for (const time of timestamps) {
    for (const symbol of MARTINGALE_GRID_SYMBOLS) {
      const curve = simulations[symbol].equityCurve;
      while (cursors[symbol] < curve.length && curve[cursors[symbol]].time <= time) {
        latest[symbol] = curve[cursors[symbol]].equity;
        cursors[symbol] += 1;
      }
    }
    const equity = MARTINGALE_GRID_SYMBOLS.reduce((sum, symbol) => sum + latest[symbol], 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  return {
    completedGroups: completed.length,
    totalFills: completed.reduce((sum, group) => sum + group.fills.length, 0) + openGroups.reduce((sum, group) => sum + group.fills.length, 0),
    realizedNetPnl,
    unrealizedPnl,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    averageR: completed.length ? completed.reduce((sum, group) => sum + group.rMultiple, 0) / completed.length : 0,
    maxMarkToMarketDrawdownFraction: maxDrawdown,
    initialEquity,
    currentEquity: initialEquity + realizedNetPnl + unrealizedPnl,
    fees: completed.reduce((sum, group) => sum + group.fees, 0) + openGroups.reduce((sum, group) => sum + group.feesPaid, 0),
  };
}

function makeConfig(overrides: Partial<MartingaleGridConfig> = {}): MartingaleGridConfig {
  const config = { ...MARTINGALE_GRID_CONFIG, ...overrides };
  if (config.maximumLayers < 1 || config.maximumLayers > 8) throw new Error("maximumLayers must be between 1 and 8.");
  if (config.sizeMultiplier < 1 || config.sizeMultiplier > 2) throw new Error("sizeMultiplier must be between 1 and 2.");
  if (config.maximumGroupLossFraction <= 0 || config.maximumGroupLossFraction > 0.03) throw new Error("maximumGroupLossFraction is outside the Paper safety boundary.");
  return config;
}

function buildPlannedFills(
  side: MartingaleGridSide,
  initialPrice: number,
  baseNotional: number,
  gridStep: number,
  config: MartingaleGridConfig,
) {
  return Array.from({ length: config.maximumLayers }, (_, index) => {
    const level = index + 1;
    const trigger = side === "long" ? initialPrice - gridStep * index : initialPrice + gridStep * index;
    const price = index === 0 ? initialPrice : adverseEntryPrice(side, trigger, config.slippageRate);
    return makeFill(side, level, 0, price, baseNotional * config.sizeMultiplier ** index, config.takerFeeRate);
  });
}

function enforceMaximumPlannedLoss(
  side: MartingaleGridSide,
  structuralStop: number,
  fills: MartingaleGridFill[],
  maximumLoss: number,
  exitFeeRate: number,
  slippageRate: number,
) {
  const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  const entryValue = fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
  const entryFees = fills.reduce((sum, fill) => sum + fill.fee, 0);
  const lossCapExitPrice = side === "long"
    ? (entryValue + entryFees - maximumLoss) / (quantity * (1 - exitFeeRate))
    : (entryValue - entryFees + maximumLoss) / (quantity * (1 + exitFeeRate));
  const lossCapTriggerPrice = side === "long"
    ? lossCapExitPrice / (1 - slippageRate)
    : lossCapExitPrice / (1 + slippageRate);
  return side === "long" ? Math.max(structuralStop, lossCapTriggerPrice) : Math.min(structuralStop, lossCapTriggerPrice);
}

function makeFill(side: MartingaleGridSide, level: number, time: number, price: number, notional: number, feeRate: number): MartingaleGridFill {
  void side;
  const quantity = notional / price;
  return { level, time, price, quantity, notional, fee: notional * feeRate };
}

function netPnlAtPrice(side: MartingaleGridSide, fills: MartingaleGridFill[], price: number, exitFeeRate: number) {
  const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  const entryValue = fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
  const gross = side === "long" ? price * quantity - entryValue : entryValue - price * quantity;
  return gross - fills.reduce((sum, fill) => sum + fill.fee, 0) - price * quantity * exitFeeRate;
}

function weightedAverage(fills: MartingaleGridFill[]) {
  const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  return fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) / quantity;
}

function targetFor(side: MartingaleGridSide, averagePrice: number, distance: number) {
  return side === "long" ? averagePrice + distance : averagePrice - distance;
}

function nextGridPrice(side: MartingaleGridSide, initialPrice: number, step: number, level: number, maximumLayers: number) {
  if (level > maximumLayers) return null;
  return side === "long" ? initialPrice - step * (level - 1) : initialPrice + step * (level - 1);
}

function adverseEntryPrice(side: MartingaleGridSide, price: number, slippageRate: number) {
  return side === "long" ? price * (1 + slippageRate) : price * (1 - slippageRate);
}

function adverseExitPrice(side: MartingaleGridSide, price: number, slippageRate: number) {
  return side === "long" ? price * (1 - slippageRate) : price * (1 + slippageRate);
}

function calculateAtr(candles: Candle[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(candles.length).fill(null);
  let smoothed = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const previousClose = candles[index - 1].close;
    const range = Math.max(
      candles[index].high - candles[index].low,
      Math.abs(candles[index].high - previousClose),
      Math.abs(candles[index].low - previousClose),
    );
    if (index <= period) {
      smoothed += range;
      if (index === period) {
        smoothed /= period;
        output[index] = smoothed;
      }
    } else {
      smoothed = (smoothed * (period - 1) + range) / period;
      output[index] = smoothed;
    }
  }
  return output;
}

function calculateRsi(candles: Candle[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(candles.length).fill(null);
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    if (index <= period) {
      averageGain += gain;
      averageLoss += loss;
      if (index === period) {
        averageGain /= period;
        averageLoss /= period;
        output[index] = rsiFromAverages(averageGain, averageLoss);
      }
    } else {
      averageGain = (averageGain * (period - 1) + gain) / period;
      averageLoss = (averageLoss * (period - 1) + loss) / period;
      output[index] = rsiFromAverages(averageGain, averageLoss);
    }
  }
  return output;
}

function rsiFromAverages(averageGain: number, averageLoss: number) {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function calculateCompleted15mTrend(candles: Candle[], fastPeriod: number, slowPeriod: number): Array<"up" | "down" | null> {
  const aggregated = aggregateCandles(candles, "15m");
  const fast = calculateEma(aggregated.map((candle) => candle.close), fastPeriod);
  const slow = calculateEma(aggregated.map((candle) => candle.close), slowPeriod);
  const output: Array<"up" | "down" | null> = Array(candles.length).fill(null);
  let completedIndex = -1;
  for (let index = 0; index < candles.length; index += 1) {
    const candleCloseTime = candles[index].time + MARTINGALE_GRID_INTERVAL_SECONDS;
    while (completedIndex + 1 < aggregated.length && aggregated[completedIndex + 1].time + 15 * 60 <= candleCloseTime) completedIndex += 1;
    if (completedIndex < 0 || fast[completedIndex] === null || slow[completedIndex] === null) continue;
    const close = aggregated[completedIndex].close;
    output[index] = fast[completedIndex]! > slow[completedIndex]! && close > fast[completedIndex]!
      ? "up"
      : fast[completedIndex]! < slow[completedIndex]! && close < fast[completedIndex]!
        ? "down"
        : null;
  }
  return output;
}

function calculateEma(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return output;
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    output[index] = current;
  }
  return output;
}

export type BinanceMartingaleKlineLoaderOptions = {
  symbol: MartingaleGridSymbol;
  startTime: number;
  endTime: number;
  fetchFn?: typeof fetch;
};

export async function loadBinanceMartingaleClosedKlines(options: BinanceMartingaleKlineLoaderOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const candles: Candle[] = [];
  let cursor = Math.floor(options.startTime / MARTINGALE_GRID_INTERVAL_SECONDS) * MARTINGALE_GRID_INTERVAL_SECONDS * 1000;
  const endMilliseconds = options.endTime * 1000;
  for (let request = 0; cursor <= endMilliseconds && request < 100; request += 1) {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    url.searchParams.set("symbol", options.symbol);
    url.searchParams.set("interval", MARTINGALE_GRID_INTERVAL);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endMilliseconds));
    url.searchParams.set("limit", "1500");
    const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("martingale_source_unavailable");
    const rows = await response.json() as unknown[][];
    if (rows.length === 0) break;
    for (const row of rows) {
      const candle = klineRowToCandle(options.symbol, row);
      if (candle && candle.time + MARTINGALE_GRID_INTERVAL_SECONDS <= options.endTime) candles.push(candle);
    }
    const lastOpenTime = Number(rows.at(-1)?.[0]);
    if (!Number.isFinite(lastOpenTime) || lastOpenTime < cursor) break;
    cursor = lastOpenTime + MARTINGALE_GRID_INTERVAL_SECONDS * 1000;
    if (rows.length < 1500) break;
  }
  return normalizeCandles(candles);
}

export async function loadLatestBinanceMartingaleClosedKline(options: { symbol: MartingaleGridSymbol; now: number; fetchFn?: typeof fetch }) {
  const fetchFn = options.fetchFn ?? fetch;
  const url = new URL("https://fapi.binance.com/fapi/v1/klines");
  url.searchParams.set("symbol", options.symbol);
  url.searchParams.set("interval", MARTINGALE_GRID_INTERVAL);
  url.searchParams.set("limit", "3");
  const response = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("martingale_source_unavailable");
  const rows = await response.json() as unknown[][];
  return rows.map((row) => klineRowToCandle(options.symbol, row))
    .filter((candle): candle is Candle => Boolean(candle) && candle!.time + MARTINGALE_GRID_INTERVAL_SECONDS <= options.now)
    .sort((left, right) => left.time - right.time)
    .at(-1) ?? null;
}

export async function writeMartingaleGridReport(filePath: string, report: MartingaleGridPaperReport) {
  await atomicWriteJson(filePath, report);
}

export function countMissingBars(items: Array<{ time: number }>) {
  let missing = 0;
  for (let index = 1; index < items.length; index += 1) {
    const delta = items[index].time - items[index - 1].time;
    if (delta > MARTINGALE_GRID_INTERVAL_SECONDS) missing += Math.floor(delta / MARTINGALE_GRID_INTERVAL_SECONDS) - 1;
  }
  return missing;
}

function klineRowToCandle(symbol: MartingaleGridSymbol, row: unknown[]): Candle | null {
  const candle: Candle = {
    symbol,
    interval: MARTINGALE_GRID_INTERVAL,
    time: Math.trunc(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
  if (![candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) return null;
  if (candle.open <= 0 || candle.high < candle.low || candle.low <= 0 || candle.close <= 0) return null;
  return candle;
}

function normalizeCandles(candles: Candle[]) {
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((left, right) => left.time - right.time);
}
