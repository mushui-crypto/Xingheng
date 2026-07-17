import type { Candle } from "../../../types";
import { aggregateCandles } from "../core/candles";
import { atomicWriteJson } from "./RouteBPaperEngine";
import {
  countMissingBars,
  loadBinanceMartingaleClosedKlines,
  loadLatestBinanceMartingaleClosedKline,
  MARTINGALE_GRID_INTERVAL_SECONDS,
  MARTINGALE_GRID_SYMBOLS,
  type MartingaleGridSymbol,
} from "./MartingaleGridPaperEngine";

export const FIXED_GRID_ROUTE_ID = "binance-usdm-martingale-grid-fixed-step-htf-v3-paper";
export const FIXED_GRID_FORWARD_START_ISO = "2026-07-17T06:34:00.000Z";
export const FIXED_GRID_FORWARD_START = Math.floor(Date.parse(FIXED_GRID_FORWARD_START_ISO) / 1000);

export type FixedGridBias = "long" | "short" | "neutral";
export type FixedGridOrderStatus = "working" | "filled" | "cancelled";
export type FixedGridExitReason = "take_profit" | "group_stop" | "timeout";

export type FixedGridConfig = {
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
  gridStepBySymbol: Record<MartingaleGridSymbol, number>;
};

export const FIXED_GRID_CONFIG: Readonly<FixedGridConfig> = Object.freeze({
  initialEquityPerSymbol: 5_000,
  leverageSelection: 5,
  marginMode: "isolated",
  maximumLayers: 12,
  sizeMultiplier: 1.12,
  cumulativeMarginFractionCap: 0.05,
  maximumGroupLossFraction: 0.015,
  targetGridSteps: 1.5,
  stopBeyondLastGridSteps: 2,
  directionValidityHours: 6,
  swingLeftBars: 2,
  swingRightBars: 2,
  maximumHoldingMinutes: 24 * 60,
  takerFeeRate: 0.00045,
  slippageRate: 0.0001,
  stopAfterLossForUtcDay: true,
  gridStepBySymbol: { BTCUSDT: 200, ETHUSDT: 10 },
});

export type FixedGridFill = {
  level: number;
  time: number;
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
  filledAt: number | null;
};

export type FixedGridDirectionState = {
  fourHourBias: FixedGridBias;
  oneHourConfirmation: "long_break" | "short_break" | "none";
  status: "waiting_for_structure" | "orders_working" | "group_open" | "daily_locked";
  anchorPrice: number | null;
  confirmedAt: number | null;
  expiresAt: number | null;
};

export type FixedGridWorkingPlan = {
  id: string;
  symbol: MartingaleGridSymbol;
  side: "long" | "short";
  anchorPrice: number;
  confirmedAt: number;
  expiresAt: number;
  orders: FixedGridOrder[];
};

export type FixedGridOpenGroup = {
  id: string;
  symbol: MartingaleGridSymbol;
  side: "long" | "short";
  anchorPrice: number;
  confirmedAt: number;
  entryTime: number;
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
  exitTime: number;
  exitPrice: number;
  exitReason: FixedGridExitReason;
  grossPnl: number;
  netPnl: number;
  fees: number;
  rMultiple: number;
  holdingMinutes: number;
};

type InternalPlan = Omit<FixedGridWorkingPlan, "orders"> & { gridStep: number };
type InternalOpenGroup = Omit<FixedGridOpenGroup, "markPrice" | "unrealizedPnl" | "orders"> & {
  gridStep: number;
  baseNotional: number;
  entryEquity: number;
};
export type FixedGridDirectionPoint = {
  fourHourBias: FixedGridBias;
  confirmation: "long_break" | "short_break" | "none";
  anchorPrice: number | null;
  confirmedAt: number | null;
};
type SymbolSimulation = {
  completed: FixedGridCompletedGroup[];
  open: FixedGridOpenGroup | null;
  plan: FixedGridWorkingPlan | null;
  direction: FixedGridDirectionState;
  equityCurve: Array<{ time: number; equity: number }>;
  diagnostics: { confirmations: number; expiredPlans: number; startedGroups: number; dailyLossLocks: number };
};

export type FixedGridPaperReport = {
  routeId: typeof FIXED_GRID_ROUTE_ID;
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
  configuration: FixedGridConfig & {
    directionModel: "confirmed_4h_structure_plus_1h_break";
    riskScaling: "scale_all_layers_to_structural_stop_risk_cap";
    oneGroupPerSymbol: true;
  };
  dataQuality: {
    source: "binance_futures_public_rest" | "binance_vision_usdm_archive";
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
    confirmations: number;
    expiredPlans: number;
    startedGroups: number;
    takeProfits: number;
    groupStops: number;
    timeouts: number;
    dailyLossLocks: number;
    bySymbol: Record<MartingaleGridSymbol, {
      confirmations: number;
      expiredPlans: number;
      completedGroups: number;
      totalFills: number;
      realizedNetPnl: number;
      openGroup: boolean;
      workingPlan: boolean;
    }>;
  };
  directions: Record<MartingaleGridSymbol, FixedGridDirectionState>;
  workingPlans: FixedGridWorkingPlan[];
  openGroups: FixedGridOpenGroup[];
  recentCompletedGroups: FixedGridCompletedGroup[];
};

export function buildFixedGridPaperReport(
  candlesBySymbol: Record<MartingaleGridSymbol, Candle[]>,
  options: {
    forwardStart?: number;
    config?: FixedGridConfig;
    source?: FixedGridPaperReport["dataQuality"]["source"];
  } = {},
): FixedGridPaperReport {
  const config = options.config ?? FIXED_GRID_CONFIG;
  const forwardStart = options.forwardStart ?? FIXED_GRID_FORWARD_START;
  const simulations = Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [
    symbol,
    simulateFixedGridSymbol(symbol, candlesBySymbol[symbol], { forwardStart, config }),
  ])) as Record<MartingaleGridSymbol, SymbolSimulation>;
  const completed = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].completed).sort((a, b) => a.exitTime - b.exitTime);
  const workingPlans = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].plan ? [simulations[symbol].plan!] : []);
  const openGroups = MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].open ? [simulations[symbol].open!] : []);
  const throughValues = MARTINGALE_GRID_SYMBOLS.map((symbol) => candlesBySymbol[symbol].at(-1)?.time).filter((value): value is number => value !== undefined);
  const through = throughValues.length === MARTINGALE_GRID_SYMBOLS.length ? Math.min(...throughValues) : null;
  const elapsedDays = through === null ? 0 : Math.max(0, (through - forwardStart) / 86_400);
  const gateReached = elapsedDays >= 60 || completed.length >= 100;
  const metrics = combinedMetrics(simulations, completed, openGroups, config);
  return {
    routeId: FIXED_GRID_ROUTE_ID,
    status: gateReached ? "observation_gate_reached_pending_review" : "collecting",
    forwardStart,
    forwardStartIso: FIXED_GRID_FORWARD_START_ISO,
    through,
    throughIso: through === null ? null : new Date(through * 1000).toISOString(),
    elapsedDays,
    observationGate: { minimumDays: 60, minimumCompletedGroups: 100, mode: "either", reached: gateReached },
    assumptions: {
      venue: "binance_usdm_public_market_data",
      symbols: [...MARTINGALE_GRID_SYMBOLS],
      sourceInterval: "5m",
      directionIntervals: ["4h", "1h"],
      entryModel: "fixed_price_distance",
      paperOnly: true,
      automaticPaperEnabled: true,
      automaticOrdersEnabled: false,
      exchangeCredentialsRequired: false,
      fundingIgnored: true,
      markPriceAndLiquidationIgnored: true,
    },
    configuration: {
      ...config,
      gridStepBySymbol: { ...config.gridStepBySymbol },
      directionModel: "confirmed_4h_structure_plus_1h_break",
      riskScaling: "scale_all_layers_to_structural_stop_risk_cap",
      oneGroupPerSymbol: true,
    },
    dataQuality: {
      source: options.source ?? "binance_futures_public_rest",
      interval: "5m",
      updatedAt: through === null ? null : new Date(through * 1000).toISOString(),
      symbols: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => {
        const last = candlesBySymbol[symbol].at(-1)?.time ?? null;
        return [symbol, {
          candleCount: candlesBySymbol[symbol].length,
          missingBarCount: countMissingBars(candlesBySymbol[symbol]),
          through: last === null ? null : new Date(last * 1000).toISOString(),
        }];
      })) as FixedGridPaperReport["dataQuality"]["symbols"],
    },
    metrics,
    diagnostics: {
      confirmations: sumBySymbol(simulations, (item) => item.diagnostics.confirmations),
      expiredPlans: sumBySymbol(simulations, (item) => item.diagnostics.expiredPlans),
      startedGroups: sumBySymbol(simulations, (item) => item.diagnostics.startedGroups),
      takeProfits: completed.filter((group) => group.exitReason === "take_profit").length,
      groupStops: completed.filter((group) => group.exitReason === "group_stop").length,
      timeouts: completed.filter((group) => group.exitReason === "timeout").length,
      dailyLossLocks: sumBySymbol(simulations, (item) => item.diagnostics.dailyLossLocks),
      bySymbol: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => {
        const simulation = simulations[symbol];
        return [symbol, {
          confirmations: simulation.diagnostics.confirmations,
          expiredPlans: simulation.diagnostics.expiredPlans,
          completedGroups: simulation.completed.length,
          totalFills: simulation.completed.reduce((sum, group) => sum + group.fills.length, 0) + (simulation.open?.fills.length ?? 0),
          realizedNetPnl: simulation.completed.reduce((sum, group) => sum + group.netPnl, 0),
          openGroup: Boolean(simulation.open),
          workingPlan: Boolean(simulation.plan),
        }];
      })) as FixedGridPaperReport["diagnostics"]["bySymbol"],
    },
    directions: Object.fromEntries(MARTINGALE_GRID_SYMBOLS.map((symbol) => [symbol, simulations[symbol].direction])) as FixedGridPaperReport["directions"],
    workingPlans,
    openGroups,
    recentCompletedGroups: completed.slice(-50),
  };
}

export function simulateFixedGridSymbol(
  symbol: MartingaleGridSymbol,
  inputCandles: Candle[],
  options: { forwardStart?: number; config?: FixedGridConfig } = {},
): SymbolSimulation {
  const config = options.config ?? FIXED_GRID_CONFIG;
  const forwardStart = options.forwardStart ?? FIXED_GRID_FORWARD_START;
  const candles = normalizeCandles(inputCandles).filter((candle) => candle.symbol === symbol);
  const directions = calculateFixedGridDirections(candles, config);
  const completed: FixedGridCompletedGroup[] = [];
  const equityCurve: Array<{ time: number; equity: number }> = [];
  let equity = config.initialEquityPerSymbol;
  let plan: InternalPlan | null = null;
  let open: InternalOpenGroup | null = null;
  let lockedUtcDate: string | null = null;
  let confirmations = 0;
  let expiredPlans = 0;
  let startedGroups = 0;
  let dailyLossLocks = 0;

  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const utcDate = new Date(candle.time * 1000).toISOString().slice(0, 10);
    if (lockedUtcDate && lockedUtcDate !== utcDate) lockedUtcDate = null;
    if (plan && candle.time >= plan.expiresAt) {
      plan = null;
      expiredPlans += 1;
    }
    if (!open && plan && !lockedUtcDate && candle.time >= forwardStart && touches(plan.side, candle, firstOrderPrice(plan))) {
      open = startGroup(plan, candle, equity, config);
      plan = null;
      startedGroups += 1;
    }
    if (open) {
      const exit = processGroup(open, candle, config);
      if (exit) {
        completed.push(exit);
        equity += exit.netPnl;
        open = null;
        if (exit.netPnl < 0 && config.stopAfterLossForUtcDay) {
          lockedUtcDate = utcDate;
          plan = null;
          dailyLossLocks += 1;
        }
      }
    }
    equityCurve.push({ time: candle.time, equity: equity + (open ? unrealized(open, candle.close, config.takerFeeRate) : 0) });

    const direction = directions[index];
    if (!open && !lockedUtcDate && candle.time >= forwardStart && direction.confirmation !== "none" && direction.anchorPrice !== null && direction.confirmedAt !== null) {
      const side = direction.confirmation === "long_break" ? "long" : "short";
      plan = {
        id: `${FIXED_GRID_ROUTE_ID}-${symbol}-${direction.confirmedAt}`,
        symbol,
        side,
        anchorPrice: direction.anchorPrice,
        confirmedAt: direction.confirmedAt,
        expiresAt: direction.confirmedAt + config.directionValidityHours * 3600,
        gridStep: config.gridStepBySymbol[symbol],
      };
      confirmations += 1;
    }
  }

  const last = candles.at(-1);
  const lastDirection = directions.at(-1) ?? { fourHourBias: "neutral", confirmation: "none", anchorPrice: null, confirmedAt: null };
  return {
    completed,
    open: open && last ? publicOpen(open, last.close, config) : null,
    plan: plan ? publicPlan(plan, equity, config) : null,
    direction: {
      fourHourBias: lastDirection.fourHourBias,
      oneHourConfirmation: open
        ? open.side === "long" ? "long_break" : "short_break"
        : plan
          ? plan.side === "long" ? "long_break" : "short_break"
          : lastDirection.confirmation,
      status: lockedUtcDate ? "daily_locked" : open ? "group_open" : plan ? "orders_working" : "waiting_for_structure",
      anchorPrice: open?.anchorPrice ?? plan?.anchorPrice ?? lastDirection.anchorPrice,
      confirmedAt: open?.confirmedAt ?? plan?.confirmedAt ?? lastDirection.confirmedAt,
      expiresAt: plan?.expiresAt ?? null,
    },
    equityCurve,
    diagnostics: { confirmations, expiredPlans, startedGroups, dailyLossLocks },
  };
}

export function calculateFixedGridDirections(candles: Candle[], config: FixedGridConfig = FIXED_GRID_CONFIG): FixedGridDirectionPoint[] {
  const oneHour = aggregateCandles(candles, "1h");
  const fourHour = aggregateCandles(candles, "4h");
  const oneHighs = swings(oneHour, "high", config.swingLeftBars, config.swingRightBars);
  const oneLows = swings(oneHour, "low", config.swingLeftBars, config.swingRightBars);
  const fourHighs = swings(fourHour, "high", config.swingLeftBars, config.swingRightBars);
  const fourLows = swings(fourHour, "low", config.swingLeftBars, config.swingRightBars);
  const output: FixedGridDirectionPoint[] = candles.map(() => ({ fourHourBias: "neutral", confirmation: "none", anchorPrice: null, confirmedAt: null }));
  let oneCompleted = -1;
  let fourCompleted = -1;
  for (let index = 0; index < candles.length; index += 1) {
    const closeTime = candles[index].time + MARTINGALE_GRID_INTERVAL_SECONDS;
    const priorOneCompleted = oneCompleted;
    while (oneCompleted + 1 < oneHour.length && oneHour[oneCompleted + 1].time + 3600 <= closeTime) oneCompleted += 1;
    while (fourCompleted + 1 < fourHour.length && fourHour[fourCompleted + 1].time + 4 * 3600 <= closeTime) fourCompleted += 1;
    const bias = structureBias(fourHighs, fourLows, fourCompleted);
    let confirmation: FixedGridDirectionPoint["confirmation"] = "none";
    let anchorPrice: number | null = null;
    let confirmedAt: number | null = null;
    if (oneCompleted > priorOneCompleted && oneCompleted >= 1) {
      const high = latestConfirmedSwing(oneHighs, oneCompleted);
      const low = latestConfirmedSwing(oneLows, oneCompleted);
      const current = oneHour[oneCompleted];
      const previous = oneHour[oneCompleted - 1];
      if (bias === "long" && high && previous.close <= high.price && current.close > high.price) confirmation = "long_break";
      if (bias === "short" && low && previous.close >= low.price && current.close < low.price) confirmation = "short_break";
      if (confirmation !== "none") {
        anchorPrice = current.close;
        confirmedAt = current.time + 3600;
      }
    }
    output[index] = { fourHourBias: bias, confirmation, anchorPrice, confirmedAt };
  }
  return output;
}

type Swing = { index: number; confirmationIndex: number; price: number };

function swings(candles: Candle[], field: "high" | "low", left: number, right: number): Swing[] {
  const output: Swing[] = [];
  for (let index = left; index < candles.length - right; index += 1) {
    const value = candles[index][field];
    const neighbors = candles.slice(index - left, index + right + 1);
    const match = field === "high"
      ? neighbors.every((candle, offset) => offset === left || candle.high < value)
      : neighbors.every((candle, offset) => offset === left || candle.low > value);
    if (match) output.push({ index, confirmationIndex: index + right, price: value });
  }
  return output;
}

function structureBias(highs: Swing[], lows: Swing[], completedIndex: number): FixedGridBias {
  const confirmedHighs = highs.filter((swing) => swing.confirmationIndex <= completedIndex).slice(-2);
  const confirmedLows = lows.filter((swing) => swing.confirmationIndex <= completedIndex).slice(-2);
  if (confirmedHighs.length < 2 || confirmedLows.length < 2) return "neutral";
  if (confirmedHighs[1].price > confirmedHighs[0].price && confirmedLows[1].price > confirmedLows[0].price) return "long";
  if (confirmedHighs[1].price < confirmedHighs[0].price && confirmedLows[1].price < confirmedLows[0].price) return "short";
  return "neutral";
}

function latestConfirmedSwing(items: Swing[], completedIndex: number) {
  return items.filter((swing) => swing.confirmationIndex <= completedIndex).at(-1) ?? null;
}

function startGroup(plan: InternalPlan, candle: Candle, equity: number, config: FixedGridConfig): InternalOpenGroup {
  const structuralStop = plan.side === "long"
    ? plan.anchorPrice - plan.gridStep * (config.maximumLayers + config.stopBeyondLastGridSteps)
    : plan.anchorPrice + plan.gridStep * (config.maximumLayers + config.stopBeyondLastGridSteps);
  const baseNotional = resolveBaseNotional(plan, equity, config);
  const planned = buildPlannedFills(plan, baseNotional, config);
  const firstPrice = adverseEntryPrice(plan.side, firstOrderPrice(plan), config.slippageRate);
  const first = makeFill(1, candle.time, firstPrice, baseNotional, config.takerFeeRate);
  const averageEntryPrice = first.price;
  const targetDistance = plan.gridStep * config.targetGridSteps;
  return {
    id: plan.id,
    symbol: plan.symbol,
    side: plan.side,
    anchorPrice: plan.anchorPrice,
    confirmedAt: plan.confirmedAt,
    entryTime: candle.time,
    fills: [first],
    averageEntryPrice,
    targetPrice: targetFor(plan.side, averageEntryPrice, targetDistance),
    stopPrice: structuralStop,
    quantity: first.quantity,
    plannedRisk: Math.max(0.01, -netPnlAtPrice(plan.side, planned, adverseExitPrice(plan.side, structuralStop, config.slippageRate), config.takerFeeRate)),
    feesPaid: first.fee,
    gridStep: plan.gridStep,
    baseNotional,
    entryEquity: equity,
  };
}

function processGroup(group: InternalOpenGroup, candle: Candle, config: FixedGridConfig): FixedGridCompletedGroup | null {
  if (candle.time - group.entryTime >= config.maximumHoldingMinutes * 60) {
    return closeGroup(group, candle.time, adverseExitPrice(group.side, candle.open, config.slippageRate), "timeout", config);
  }
  while (group.fills.length < config.maximumLayers) {
    const level = group.fills.length + 1;
    const trigger = orderPrice(group.side, group.anchorPrice, group.gridStep, level);
    if (!touches(group.side, candle, trigger)) break;
    const price = adverseEntryPrice(group.side, trigger, config.slippageRate);
    const fill = makeFill(level, candle.time, price, group.baseNotional * config.sizeMultiplier ** (level - 1), config.takerFeeRate);
    group.fills.push(fill);
    group.feesPaid += fill.fee;
    group.quantity += fill.quantity;
    group.averageEntryPrice = weightedAverage(group.fills);
    group.targetPrice = targetFor(group.side, group.averageEntryPrice, group.gridStep * config.targetGridSteps);
  }
  const stopped = group.side === "long" ? candle.low <= group.stopPrice : candle.high >= group.stopPrice;
  if (stopped) {
    const gapPrice = group.side === "long" ? Math.min(candle.open, group.stopPrice) : Math.max(candle.open, group.stopPrice);
    return closeGroup(group, candle.time, adverseExitPrice(group.side, gapPrice, config.slippageRate), "group_stop", config);
  }
  const targeted = group.side === "long" ? candle.high >= group.targetPrice : candle.low <= group.targetPrice;
  return targeted ? closeGroup(group, candle.time, adverseExitPrice(group.side, group.targetPrice, config.slippageRate), "take_profit", config) : null;
}

function closeGroup(group: InternalOpenGroup, exitTime: number, exitPrice: number, exitReason: FixedGridExitReason, config: FixedGridConfig): FixedGridCompletedGroup {
  const entryValue = group.fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
  const exitValue = exitPrice * group.quantity;
  const grossPnl = group.side === "long" ? exitValue - entryValue : entryValue - exitValue;
  const exitFee = exitValue * config.takerFeeRate;
  const fees = group.feesPaid + exitFee;
  const netPnl = grossPnl - fees;
  return {
    id: group.id,
    symbol: group.symbol,
    side: group.side,
    anchorPrice: group.anchorPrice,
    confirmedAt: group.confirmedAt,
    entryTime: group.entryTime,
    fills: group.fills.map((fill) => ({ ...fill })),
    orders: publicOrders(group.side, group.anchorPrice, group.gridStep, group.fills, group.baseNotional, group.entryEquity, config, true),
    averageEntryPrice: group.averageEntryPrice,
    targetPrice: group.targetPrice,
    stopPrice: group.stopPrice,
    quantity: group.quantity,
    plannedRisk: group.plannedRisk,
    exitTime,
    exitPrice,
    exitReason,
    grossPnl,
    netPnl,
    fees,
    rMultiple: netPnl / group.plannedRisk,
    holdingMinutes: (exitTime - group.entryTime) / 60,
  };
}

function publicPlan(plan: InternalPlan, equity: number, config: FixedGridConfig): FixedGridWorkingPlan {
  const baseNotional = resolveBaseNotional(plan, equity, config);
  const firstMarginFraction = baseNotional / config.leverageSelection / equity;
  return {
    id: plan.id,
    symbol: plan.symbol,
    side: plan.side,
    anchorPrice: plan.anchorPrice,
    confirmedAt: plan.confirmedAt,
    expiresAt: plan.expiresAt,
    orders: Array.from({ length: config.maximumLayers }, (_, index) => ({
      level: index + 1,
      price: orderPrice(plan.side, plan.anchorPrice, plan.gridStep, index + 1),
      status: "working" as const,
      marginFraction: firstMarginFraction * config.sizeMultiplier ** index,
      notional: baseNotional * config.sizeMultiplier ** index,
      quantity: baseNotional * config.sizeMultiplier ** index / orderPrice(plan.side, plan.anchorPrice, plan.gridStep, index + 1),
      filledAt: null,
    })),
  };
}

function publicOpen(group: InternalOpenGroup, markPrice: number, config: FixedGridConfig): FixedGridOpenGroup {
  return {
    id: group.id,
    symbol: group.symbol,
    side: group.side,
    anchorPrice: group.anchorPrice,
    confirmedAt: group.confirmedAt,
    entryTime: group.entryTime,
    fills: group.fills.map((fill) => ({ ...fill })),
    orders: publicOrders(group.side, group.anchorPrice, group.gridStep, group.fills, group.baseNotional, group.entryEquity, config),
    averageEntryPrice: group.averageEntryPrice,
    targetPrice: group.targetPrice,
    stopPrice: group.stopPrice,
    quantity: group.quantity,
    plannedRisk: group.plannedRisk,
    markPrice,
    unrealizedPnl: unrealized(group, markPrice, config.takerFeeRate),
    feesPaid: group.feesPaid,
  };
}

function publicOrders(
  side: "long" | "short",
  anchor: number,
  step: number,
  fills: FixedGridFill[],
  baseNotional: number,
  entryEquity: number,
  config: FixedGridConfig,
  closed = false,
): FixedGridOrder[] {
  const firstMarginFraction = baseNotional / config.leverageSelection / entryEquity;
  return Array.from({ length: config.maximumLayers }, (_, index) => {
    const fill = fills[index];
    const notional = baseNotional * config.sizeMultiplier ** index;
    return {
      level: index + 1,
      price: orderPrice(side, anchor, step, index + 1),
      status: fill ? "filled" : closed ? "cancelled" : "working",
      marginFraction: firstMarginFraction * config.sizeMultiplier ** index,
      notional,
      quantity: fill?.quantity ?? notional / orderPrice(side, anchor, step, index + 1),
      filledAt: fill?.time ?? null,
    };
  });
}

export function resolveFixedGridBaseNotional(
  symbol: MartingaleGridSymbol,
  side: "long" | "short",
  anchorPrice: number,
  equity: number,
  config: FixedGridConfig = FIXED_GRID_CONFIG,
) {
  const plan: InternalPlan = {
    id: "preview",
    symbol,
    side,
    anchorPrice,
    confirmedAt: 0,
    expiresAt: 0,
    gridStep: config.gridStepBySymbol[symbol],
  };
  return resolveBaseNotional(plan, equity, config);
}

function resolveBaseNotional(plan: InternalPlan, equity: number, config: FixedGridConfig) {
  const structuralStop = plan.side === "long"
    ? plan.anchorPrice - plan.gridStep * (config.maximumLayers + config.stopBeyondLastGridSteps)
    : plan.anchorPrice + plan.gridStep * (config.maximumLayers + config.stopBeyondLastGridSteps);
  const marginWeights = Array.from({ length: config.maximumLayers }, (_, index) => config.sizeMultiplier ** index);
  const firstMarginFractionCap = config.cumulativeMarginFractionCap / marginWeights.reduce((sum, value) => sum + value, 0);
  const cappedBaseNotional = equity * firstMarginFractionCap * config.leverageSelection;
  const unitPlanned = buildPlannedFills(plan, 1, config);
  const unitRisk = -netPnlAtPrice(plan.side, unitPlanned, adverseExitPrice(plan.side, structuralStop, config.slippageRate), config.takerFeeRate);
  const riskScaledBaseNotional = unitRisk > 0 ? equity * config.maximumGroupLossFraction / unitRisk : cappedBaseNotional;
  return Math.min(cappedBaseNotional, riskScaledBaseNotional);
}

function buildPlannedFills(plan: InternalPlan, baseNotional: number, config: FixedGridConfig) {
  return Array.from({ length: config.maximumLayers }, (_, index) => {
    const trigger = orderPrice(plan.side, plan.anchorPrice, plan.gridStep, index + 1);
    return makeFill(index + 1, 0, adverseEntryPrice(plan.side, trigger, config.slippageRate), baseNotional * config.sizeMultiplier ** index, config.takerFeeRate);
  });
}

function combinedMetrics(
  simulations: Record<MartingaleGridSymbol, SymbolSimulation>,
  completed: FixedGridCompletedGroup[],
  openGroups: FixedGridOpenGroup[],
  config: FixedGridConfig,
): FixedGridPaperReport["metrics"] {
  const initialEquity = config.initialEquityPerSymbol * MARTINGALE_GRID_SYMBOLS.length;
  const realizedNetPnl = completed.reduce((sum, group) => sum + group.netPnl, 0);
  const unrealizedPnl = openGroups.reduce((sum, group) => sum + group.unrealizedPnl, 0);
  const grossProfit = completed.filter((group) => group.netPnl > 0).reduce((sum, group) => sum + group.netPnl, 0);
  const grossLoss = -completed.filter((group) => group.netPnl < 0).reduce((sum, group) => sum + group.netPnl, 0);
  const times = [...new Set(MARTINGALE_GRID_SYMBOLS.flatMap((symbol) => simulations[symbol].equityCurve.map((point) => point.time)))].sort((a, b) => a - b);
  const cursor: Record<MartingaleGridSymbol, number> = { BTCUSDT: 0, ETHUSDT: 0 };
  const latest: Record<MartingaleGridSymbol, number> = { BTCUSDT: config.initialEquityPerSymbol, ETHUSDT: config.initialEquityPerSymbol };
  let peak = initialEquity;
  let maxDrawdown = 0;
  for (const time of times) {
    for (const symbol of MARTINGALE_GRID_SYMBOLS) {
      const curve = simulations[symbol].equityCurve;
      while (cursor[symbol] < curve.length && curve[cursor[symbol]].time <= time) latest[symbol] = curve[cursor[symbol]++].equity;
    }
    const equity = latest.BTCUSDT + latest.ETHUSDT;
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

function sumBySymbol(simulations: Record<MartingaleGridSymbol, SymbolSimulation>, value: (simulation: SymbolSimulation) => number) {
  return MARTINGALE_GRID_SYMBOLS.reduce((sum, symbol) => sum + value(simulations[symbol]), 0);
}

function firstOrderPrice(plan: InternalPlan) { return orderPrice(plan.side, plan.anchorPrice, plan.gridStep, 1); }
function orderPrice(side: "long" | "short", anchor: number, step: number, level: number) { return side === "long" ? anchor - step * level : anchor + step * level; }
function touches(side: "long" | "short", candle: Candle, price: number) { return side === "long" ? candle.low <= price : candle.high >= price; }
function adverseEntryPrice(side: "long" | "short", price: number, slippage: number) { return side === "long" ? price * (1 + slippage) : price * (1 - slippage); }
function adverseExitPrice(side: "long" | "short", price: number, slippage: number) { return side === "long" ? price * (1 - slippage) : price * (1 + slippage); }
function targetFor(side: "long" | "short", average: number, distance: number) { return side === "long" ? average + distance : average - distance; }
function weightedAverage(fills: FixedGridFill[]) { const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0); return fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) / quantity; }
function makeFill(level: number, time: number, price: number, notional: number, feeRate: number): FixedGridFill { const quantity = notional / price; return { level, time, price, quantity, notional, fee: notional * feeRate }; }
function unrealized(group: InternalOpenGroup, price: number, feeRate: number) { return netPnlAtPrice(group.side, group.fills, price, feeRate); }
function netPnlAtPrice(side: "long" | "short", fills: FixedGridFill[], price: number, exitFeeRate: number) { const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0); const entry = fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0); const gross = side === "long" ? price * quantity - entry : entry - price * quantity; return gross - fills.reduce((sum, fill) => sum + fill.fee, 0) - price * quantity * exitFeeRate; }
function normalizeCandles(candles: Candle[]) { return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((a, b) => a.time - b.time); }

export async function loadFixedGridClosedKlines(options: { symbol: MartingaleGridSymbol; startTime: number; endTime: number }) {
  return loadBinanceMartingaleClosedKlines(options);
}
export async function loadLatestFixedGridClosedKline(options: { symbol: MartingaleGridSymbol; now: number }) {
  return loadLatestBinanceMartingaleClosedKline(options);
}
export async function writeFixedGridReport(filePath: string, report: FixedGridPaperReport) {
  await atomicWriteJson(filePath, report);
}
