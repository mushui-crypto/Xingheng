import type { Candle } from "../../../types";
import { aggregateCandles } from "../core/candles";
import type { MartingaleGridSymbol } from "../runtime/MartingaleGridPaperEngine";

export type RangeGridConfig = {
  initialEquity: number;
  leverageSelection: number;
  gridCount: 12;
  cumulativeMarginFractionCap: number;
  maximumCycleLossFraction: number;
  swingLeftBars: number;
  swingRightBars: number;
  boundaryToleranceFraction: number;
  minimumRangeWidthFraction: number;
  maximumRangeWidthFraction: number;
  stopBeyondRangeSteps: number;
  takerFeeRate: number;
  slippageRate: number;
};

export const RANGE_GRID_CONFIG: Readonly<RangeGridConfig> = Object.freeze({
  initialEquity: 5_000,
  leverageSelection: 20,
  gridCount: 12,
  cumulativeMarginFractionCap: 0.025,
  maximumCycleLossFraction: 0.015,
  swingLeftBars: 2,
  swingRightBars: 2,
  boundaryToleranceFraction: 0.2,
  minimumRangeWidthFraction: 0.03,
  maximumRangeWidthFraction: 0.15,
  stopBeyondRangeSteps: 1,
  takerFeeRate: 0.00045,
  slippageRate: 0.0001,
});

export type RangePoint = {
  lower: number;
  upper: number;
  detectedAt: number;
};

export type RangeGridLeg = {
  id: string;
  symbol: MartingaleGridSymbol;
  side: "long" | "short";
  level: number;
  rangeId: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "grid_profit" | "range_stop";
  quantity: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
};

type OpenLeg = Omit<RangeGridLeg, "exitTime" | "exitPrice" | "exitReason" | "grossPnl" | "fees" | "netPnl"> & {
  entryFee: number;
  targetPrice: number;
};

export type RangeGridCycle = {
  id: string;
  symbol: MartingaleGridSymbol;
  startedAt: number;
  endedAt: number | null;
  lower: number;
  upper: number;
  step: number;
  stopLower: number;
  stopUpper: number;
  status: "running" | "stopped";
  completedLegs: number;
  netPnl: number;
};

export type RangeGridSimulation = {
  completedLegs: RangeGridLeg[];
  completedCycles: RangeGridCycle[];
  activeCycle: RangeGridCycle | null;
  openLegs: Array<Pick<OpenLeg, "id" | "side" | "level" | "entryTime" | "entryPrice" | "targetPrice" | "quantity">>;
  equityCurve: Array<{ time: number; equity: number }>;
  diagnostics: { detectedRanges: number; stoppedCycles: number; fills: number; gridProfits: number };
};

type InternalCycle = Omit<RangeGridCycle, "endedAt" | "status" | "completedLegs" | "netPnl"> & {
  orderNotional: number;
  longLevels: number[];
  shortLevels: number[];
};

export function calculateConfirmedRanges(candles: Candle[], config: RangeGridConfig = RANGE_GRID_CONFIG): Array<RangePoint | null> {
  const fourHour = aggregateCandles(candles, "4h");
  const highs = swings(fourHour, "high", config.swingLeftBars, config.swingRightBars);
  const lows = swings(fourHour, "low", config.swingLeftBars, config.swingRightBars);
  const result: Array<RangePoint | null> = candles.map(() => null);
  const confirmedHighs: Swing[] = [];
  const confirmedLows: Swing[] = [];
  let completed = -1;
  let highCursor = 0;
  let lowCursor = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const closeTime = candles[index].time + 300;
    while (completed + 1 < fourHour.length && fourHour[completed + 1].time + 14_400 <= closeTime) completed += 1;
    while (highCursor < highs.length && highs[highCursor].confirmationIndex <= completed) confirmedHighs.push(highs[highCursor++]);
    while (lowCursor < lows.length && lows[lowCursor].confirmationIndex <= completed) confirmedLows.push(lows[lowCursor++]);
    if (confirmedHighs.length < 2 || confirmedLows.length < 2) continue;
    const recentHighs = confirmedHighs.slice(-2);
    const recentLows = confirmedLows.slice(-2);
    const trendingUp = recentHighs[1].price > recentHighs[0].price && recentLows[1].price > recentLows[0].price;
    const trendingDown = recentHighs[1].price < recentHighs[0].price && recentLows[1].price < recentLows[0].price;
    if (trendingUp || trendingDown) continue;
    const upper = (recentHighs[0].price + recentHighs[1].price) / 2;
    const lower = (recentLows[0].price + recentLows[1].price) / 2;
    const width = upper - lower;
    const midpoint = (upper + lower) / 2;
    if (width <= 0 || midpoint <= 0) continue;
    if (width / midpoint < config.minimumRangeWidthFraction || width / midpoint > config.maximumRangeWidthFraction) continue;
    if (Math.abs(recentHighs[1].price - recentHighs[0].price) / width > config.boundaryToleranceFraction) continue;
    if (Math.abs(recentLows[1].price - recentLows[0].price) / width > config.boundaryToleranceFraction) continue;
    if (candles[index].close <= lower || candles[index].close >= upper) continue;
    result[index] = { lower, upper, detectedAt: candles[index].time + 300 };
  }
  return result;
}

export function simulateExchangeStyleRangeGrid(
  symbol: MartingaleGridSymbol,
  inputCandles: Candle[],
  options: { forwardStart: number; config?: RangeGridConfig },
): RangeGridSimulation {
  const config = options.config ?? RANGE_GRID_CONFIG;
  const candles = normalize(inputCandles).filter((candle) => candle.symbol === symbol);
  const ranges = calculateConfirmedRanges(candles, config);
  const completedLegs: RangeGridLeg[] = [];
  const completedCycles: RangeGridCycle[] = [];
  const equityCurve: Array<{ time: number; equity: number }> = [];
  const open = new Map<string, OpenLeg>();
  let equity = config.initialEquity;
  let cycle: InternalCycle | null = null;
  let detectedRanges = 0;
  let stoppedCycles = 0;
  let fills = 0;
  let gridProfits = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.time < options.forwardStart) continue;
    if (!cycle && ranges[index]) {
      cycle = startCycle(symbol, ranges[index]!, equity, config);
      detectedRanges += 1;
    }
    if (cycle) {
      const stopSide = candle.low <= cycle.stopLower ? "lower" : candle.high >= cycle.stopUpper ? "upper" : null;
      fillTouchedOrders(cycle, open, candle, config, () => { fills += 1; });
      if (stopSide) {
        const stopPrice = stopSide === "lower" ? Math.min(candle.open, cycle.stopLower) : Math.max(candle.open, cycle.stopUpper);
        for (const leg of [...open.values()]) {
          const closed = closeLeg(leg, candle.time, adverseExit(leg.side, stopPrice, config.slippageRate), "range_stop", config);
          completedLegs.push(closed);
          equity += closed.netPnl;
        }
        open.clear();
        completedCycles.push(publicCycle(cycle, candle.time, completedLegs));
        cycle = null;
        stoppedCycles += 1;
      } else {
        for (const leg of [...open.values()]) {
          if (leg.entryTime === candle.time) continue;
          const hit = leg.side === "long" ? candle.high >= leg.targetPrice : candle.low <= leg.targetPrice;
          if (!hit) continue;
          const closed = closeLeg(leg, candle.time, adverseExit(leg.side, leg.targetPrice, config.slippageRate), "grid_profit", config);
          completedLegs.push(closed);
          equity += closed.netPnl;
          open.delete(orderKey(leg.side, leg.level));
          gridProfits += 1;
        }
      }
    }
    const unrealized = [...open.values()].reduce((sum, leg) => sum + legPnl(leg, candle.close, config.takerFeeRate), 0);
    equityCurve.push({ time: candle.time, equity: equity + unrealized });
  }

  return {
    completedLegs,
    completedCycles,
    activeCycle: cycle ? { ...cycle, endedAt: null, status: "running", completedLegs: completedLegs.filter((leg) => leg.rangeId === cycle!.id).length, netPnl: completedLegs.filter((leg) => leg.rangeId === cycle!.id).reduce((sum, leg) => sum + leg.netPnl, 0) } : null,
    openLegs: [...open.values()].map(({ id, side, level, entryTime, entryPrice, targetPrice, quantity }) => ({ id, side, level, entryTime, entryPrice, targetPrice, quantity })),
    equityCurve,
    diagnostics: { detectedRanges, stoppedCycles, fills, gridProfits },
  };
}

function startCycle(symbol: MartingaleGridSymbol, range: RangePoint, equity: number, config: RangeGridConfig): InternalCycle {
  const step = (range.upper - range.lower) / config.gridCount;
  const longLevels = Array.from({ length: config.gridCount / 2 }, (_, index) => range.lower + step * (index + 0.5));
  const shortLevels = Array.from({ length: config.gridCount / 2 }, (_, index) => range.upper - step * (index + 0.5));
  const cappedOrderNotional = equity * config.cumulativeMarginFractionCap * config.leverageSelection / config.gridCount;
  const unitWorstLoss = [...longLevels.map((price) => Math.max(0, price - (range.lower - step * config.stopBeyondRangeSteps)) / price), ...shortLevels.map((price) => Math.max(0, (range.upper + step * config.stopBeyondRangeSteps) - price) / price)]
    .reduce((sum, fraction) => sum + fraction + 2 * config.takerFeeRate + 2 * config.slippageRate, 0);
  const riskOrderNotional = unitWorstLoss > 0 ? equity * config.maximumCycleLossFraction / unitWorstLoss : cappedOrderNotional;
  return {
    id: `range-grid-${symbol}-${range.detectedAt}`,
    symbol,
    startedAt: range.detectedAt,
    lower: range.lower,
    upper: range.upper,
    step,
    stopLower: range.lower - step * config.stopBeyondRangeSteps,
    stopUpper: range.upper + step * config.stopBeyondRangeSteps,
    orderNotional: Math.min(cappedOrderNotional, riskOrderNotional),
    longLevels,
    shortLevels,
  };
}

function fillTouchedOrders(cycle: InternalCycle, open: Map<string, OpenLeg>, candle: Candle, config: RangeGridConfig, onFill: () => void) {
  for (const [side, levels] of [["long", cycle.longLevels], ["short", cycle.shortLevels]] as const) {
    for (let index = 0; index < levels.length; index += 1) {
      const level = levels[index];
      const key = orderKey(side, index + 1);
      if (open.has(key)) continue;
      const touched = side === "long" ? candle.low <= level : candle.high >= level;
      if (!touched) continue;
      const entryPrice = adverseEntry(side, level, config.slippageRate);
      const quantity = cycle.orderNotional / entryPrice;
      open.set(key, {
        id: `${cycle.id}-${side}-${index + 1}-${candle.time}`,
        symbol: cycle.symbol,
        side,
        level: index + 1,
        rangeId: cycle.id,
        entryTime: candle.time,
        entryPrice,
        targetPrice: side === "long" ? level + cycle.step : level - cycle.step,
        quantity,
        entryFee: cycle.orderNotional * config.takerFeeRate,
      });
      onFill();
    }
  }
}

function closeLeg(leg: OpenLeg, exitTime: number, exitPrice: number, exitReason: RangeGridLeg["exitReason"], config: RangeGridConfig): RangeGridLeg {
  const entryValue = leg.entryPrice * leg.quantity;
  const exitValue = exitPrice * leg.quantity;
  const grossPnl = leg.side === "long" ? exitValue - entryValue : entryValue - exitValue;
  const fees = leg.entryFee + exitValue * config.takerFeeRate;
  return { ...leg, exitTime, exitPrice, exitReason, grossPnl, fees, netPnl: grossPnl - fees };
}

function publicCycle(cycle: InternalCycle, endedAt: number, legs: RangeGridLeg[]): RangeGridCycle {
  const own = legs.filter((leg) => leg.rangeId === cycle.id);
  return { id: cycle.id, symbol: cycle.symbol, startedAt: cycle.startedAt, endedAt, lower: cycle.lower, upper: cycle.upper, step: cycle.step, stopLower: cycle.stopLower, stopUpper: cycle.stopUpper, status: "stopped", completedLegs: own.length, netPnl: own.reduce((sum, leg) => sum + leg.netPnl, 0) };
}

type Swing = { confirmationIndex: number; price: number };
function swings(candles: Candle[], field: "high" | "low", left: number, right: number): Swing[] {
  const result: Swing[] = [];
  for (let index = left; index < candles.length - right; index += 1) {
    const value = candles[index][field];
    const neighbors = candles.slice(index - left, index + right + 1);
    const match = field === "high" ? neighbors.every((candle, offset) => offset === left || candle.high < value) : neighbors.every((candle, offset) => offset === left || candle.low > value);
    if (match) result.push({ confirmationIndex: index + right, price: value });
  }
  return result;
}

function orderKey(side: "long" | "short", level: number) { return `${side}-${level}`; }
function adverseEntry(side: "long" | "short", price: number, slippage: number) { return side === "long" ? price * (1 + slippage) : price * (1 - slippage); }
function adverseExit(side: "long" | "short", price: number, slippage: number) { return side === "long" ? price * (1 - slippage) : price * (1 + slippage); }
function legPnl(leg: OpenLeg, price: number, feeRate: number) { const exitValue = price * leg.quantity; const entryValue = leg.entryPrice * leg.quantity; const gross = leg.side === "long" ? exitValue - entryValue : entryValue - exitValue; return gross - leg.entryFee - exitValue * feeRate; }
function normalize(candles: Candle[]) { return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((a, b) => a.time - b.time); }
