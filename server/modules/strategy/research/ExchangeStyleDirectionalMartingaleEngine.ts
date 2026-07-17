import type { Candle } from "../../../types";
import {
  calculateFixedGridDirections,
  FIXED_GRID_CONFIG,
} from "../runtime/FixedGridPaperEngine";
import type { MartingaleGridSymbol } from "../runtime/MartingaleGridPaperEngine";

export type ExchangeMartingaleConfig = {
  initialEquity: number;
  leverageSelection: number;
  marginMode: "isolated";
  maximumLayers: 12;
  amountMultiplier: number;
  initialPriceStepFractionBySymbol: Record<MartingaleGridSymbol, number>;
  priceStepMultiplier: number;
  takeProfitPriceFraction: number;
  cumulativeMarginFractionCap: number;
  maximumCycleLossFraction: number;
  stopBeyondLastStepMultiplier: number;
  takerFeeRate: number;
  slippageRate: number;
};

export const EXCHANGE_MARTINGALE_CONFIG: Readonly<ExchangeMartingaleConfig> = Object.freeze({
  initialEquity: 5_000,
  leverageSelection: 20,
  marginMode: "isolated",
  maximumLayers: 12,
  amountMultiplier: 1.08,
  initialPriceStepFractionBySymbol: { BTCUSDT: 0.004, ETHUSDT: 0.006 },
  priceStepMultiplier: 1.08,
  takeProfitPriceFraction: 0.006,
  cumulativeMarginFractionCap: 0.025,
  maximumCycleLossFraction: 0.015,
  stopBeyondLastStepMultiplier: 1,
  takerFeeRate: 0.00045,
  slippageRate: 0.0001,
});

export type ExchangeMartingaleFill = {
  level: number;
  time: number;
  triggerPrice: number;
  price: number;
  quantity: number;
  notional: number;
  fee: number;
};

export type ExchangeMartingaleCycle = {
  id: string;
  symbol: MartingaleGridSymbol;
  side: "long" | "short";
  signalTime: number;
  entryTime: number;
  exitTime: number;
  exitReason: "cycle_take_profit" | "cycle_stop";
  referencePrice: number;
  averageEntryPrice: number;
  targetPrice: number;
  stopPrice: number;
  fills: ExchangeMartingaleFill[];
  quantity: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  plannedRisk: number;
  rMultiple: number;
  holdingMinutes: number;
};

type OpenCycle = Omit<ExchangeMartingaleCycle,
  "exitTime" | "exitReason" | "exitTime" | "grossPnl" | "fees" | "netPnl" | "rMultiple" | "holdingMinutes"
> & {
  baseNotional: number;
  feesPaid: number;
  lastFillTime: number;
};

export type ExchangeMartingaleSimulation = {
  completed: ExchangeMartingaleCycle[];
  open: null | {
    id: string;
    side: "long" | "short";
    entryTime: number;
    fills: ExchangeMartingaleFill[];
    averageEntryPrice: number;
    targetPrice: number;
    stopPrice: number;
    unrealizedPnl: number;
  };
  selectedMode: "long" | "short" | "waiting";
  equityCurve: Array<{ time: number; equity: number }>;
  diagnostics: {
    longConfirmations: number;
    shortConfirmations: number;
    startedCycles: number;
    takeProfits: number;
    stops: number;
    maximumLayerCycles: number;
    modeSwitches: number;
  };
};

export function simulateExchangeStyleDirectionalMartingale(
  symbol: MartingaleGridSymbol,
  inputCandles: Candle[],
  options: { forwardStart: number; config?: ExchangeMartingaleConfig },
): ExchangeMartingaleSimulation {
  const config = options.config ?? EXCHANGE_MARTINGALE_CONFIG;
  const candles = normalize(inputCandles).filter((candle) => candle.symbol === symbol);
  const directions = calculateFixedGridDirections(candles, FIXED_GRID_CONFIG);
  const completed: ExchangeMartingaleCycle[] = [];
  const equityCurve: Array<{ time: number; equity: number }> = [];
  let equity = config.initialEquity;
  let selectedSide: "long" | "short" | null = null;
  let pending: { side: "long" | "short"; signalTime: number; startAfter: number } | null = null;
  let open: OpenCycle | null = null;
  let longConfirmations = 0;
  let shortConfirmations = 0;
  let startedCycles = 0;
  let takeProfits = 0;
  let stops = 0;
  let maximumLayerCycles = 0;
  let modeSwitches = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.time < options.forwardStart) continue;

    if (!open && pending && candle.time > pending.startAfter) {
      open = startCycle(symbol, pending.side, pending.signalTime, candle, equity, config);
      pending = null;
      startedCycles += 1;
    }

    if (open) {
      const closed = processCycle(open, candle, config);
      if (closed) {
        completed.push(closed);
        equity += closed.netPnl;
        if (closed.fills.length === config.maximumLayers) maximumLayerCycles += 1;
        if (closed.exitReason === "cycle_take_profit") {
          takeProfits += 1;
          if (selectedSide === closed.side) pending = { side: closed.side, signalTime: candle.time + 300, startAfter: candle.time };
        } else {
          stops += 1;
          selectedSide = null;
          pending = null;
        }
        open = null;
      }
    }

    const direction = directions[index];
    if (direction.confirmation !== "none" && direction.confirmedAt !== null) {
      const nextSide = direction.confirmation === "long_break" ? "long" : "short";
      if (selectedSide && selectedSide !== nextSide) modeSwitches += 1;
      selectedSide = nextSide;
      if (nextSide === "long") longConfirmations += 1;
      else shortConfirmations += 1;
      if (!open) pending = { side: nextSide, signalTime: direction.confirmedAt, startAfter: candle.time };
    }

    const unrealizedPnl = open ? cyclePnl(open, candle.close, config.takerFeeRate) : 0;
    equityCurve.push({ time: candle.time, equity: equity + unrealizedPnl });
  }

  const last = candles.at(-1);
  return {
    completed,
    open: open && last ? {
      id: open.id,
      side: open.side,
      entryTime: open.entryTime,
      fills: open.fills.map((fill) => ({ ...fill })),
      averageEntryPrice: open.averageEntryPrice,
      targetPrice: open.targetPrice,
      stopPrice: open.stopPrice,
      unrealizedPnl: cyclePnl(open, last.close, config.takerFeeRate),
    } : null,
    selectedMode: selectedSide ?? "waiting",
    equityCurve,
    diagnostics: { longConfirmations, shortConfirmations, startedCycles, takeProfits, stops, maximumLayerCycles, modeSwitches },
  };
}

function startCycle(
  symbol: MartingaleGridSymbol,
  side: "long" | "short",
  signalTime: number,
  candle: Candle,
  equity: number,
  config: ExchangeMartingaleConfig,
): OpenCycle {
  const referencePrice = candle.open;
  const baseNotional = resolveBaseNotional(symbol, side, referencePrice, equity, config);
  const entryPrice = adverseEntry(side, referencePrice, config.slippageRate);
  const first = makeFill(1, candle.time, referencePrice, entryPrice, baseNotional, config.takerFeeRate);
  const stopPrice = safetyTrigger(symbol, side, referencePrice, config.maximumLayers + 1, config);
  const planned = Array.from({ length: config.maximumLayers }, (_, index) => {
    const level = index + 1;
    const trigger = level === 1 ? referencePrice : safetyTrigger(symbol, side, referencePrice, level, config);
    return makeFill(level, 0, trigger, adverseEntry(side, trigger, config.slippageRate), baseNotional * config.amountMultiplier ** index, config.takerFeeRate);
  });
  const stopExit = adverseExit(side, stopPrice, config.slippageRate);
  const plannedRisk = Math.max(0.01, -fillsPnl(side, planned, stopExit, config.takerFeeRate));
  return {
    id: `exchange-martingale-${symbol}-${side}-${signalTime}`,
    symbol,
    side,
    signalTime,
    entryTime: candle.time,
    referencePrice,
    averageEntryPrice: entryPrice,
    targetPrice: target(side, entryPrice, config.takeProfitPriceFraction),
    stopPrice,
    fills: [first],
    quantity: first.quantity,
    plannedRisk,
    baseNotional,
    feesPaid: first.fee,
    lastFillTime: candle.time,
  };
}

function processCycle(group: OpenCycle, candle: Candle, config: ExchangeMartingaleConfig): ExchangeMartingaleCycle | null {
  while (group.fills.length < config.maximumLayers) {
    const level = group.fills.length + 1;
    const trigger = safetyTrigger(group.symbol, group.side, group.referencePrice, level, config);
    const touched = group.side === "long" ? candle.low <= trigger : candle.high >= trigger;
    if (!touched) break;
    const fill = makeFill(level, candle.time, trigger, adverseEntry(group.side, trigger, config.slippageRate), group.baseNotional * config.amountMultiplier ** (level - 1), config.takerFeeRate);
    group.fills.push(fill);
    group.feesPaid += fill.fee;
    group.quantity += fill.quantity;
    group.averageEntryPrice = weightedAverage(group.fills);
    group.targetPrice = target(group.side, group.averageEntryPrice, config.takeProfitPriceFraction);
    group.lastFillTime = candle.time;
  }
  const stopped = group.side === "long" ? candle.low <= group.stopPrice : candle.high >= group.stopPrice;
  if (stopped) {
    const gapPrice = group.side === "long" ? Math.min(candle.open, group.stopPrice) : Math.max(candle.open, group.stopPrice);
    return closeCycle(group, candle.time, adverseExit(group.side, gapPrice, config.slippageRate), "cycle_stop", config);
  }
  if (candle.time === group.lastFillTime) return null;
  const targeted = group.side === "long" ? candle.high >= group.targetPrice : candle.low <= group.targetPrice;
  return targeted ? closeCycle(group, candle.time, adverseExit(group.side, group.targetPrice, config.slippageRate), "cycle_take_profit", config) : null;
}

function closeCycle(group: OpenCycle, exitTime: number, exitPrice: number, exitReason: ExchangeMartingaleCycle["exitReason"], config: ExchangeMartingaleConfig): ExchangeMartingaleCycle {
  const entryValue = group.fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
  const exitValue = exitPrice * group.quantity;
  const grossPnl = group.side === "long" ? exitValue - entryValue : entryValue - exitValue;
  const fees = group.feesPaid + exitValue * config.takerFeeRate;
  const netPnl = grossPnl - fees;
  return {
    id: group.id, symbol: group.symbol, side: group.side, signalTime: group.signalTime,
    entryTime: group.entryTime, exitTime, exitReason, referencePrice: group.referencePrice,
    averageEntryPrice: group.averageEntryPrice, targetPrice: group.targetPrice, stopPrice: group.stopPrice,
    fills: group.fills.map((fill) => ({ ...fill })), quantity: group.quantity, grossPnl, fees, netPnl,
    plannedRisk: group.plannedRisk, rMultiple: netPnl / group.plannedRisk,
    holdingMinutes: (exitTime - group.entryTime) / 60,
  };
}

function resolveBaseNotional(symbol: MartingaleGridSymbol, side: "long" | "short", reference: number, equity: number, config: ExchangeMartingaleConfig) {
  const weights = Array.from({ length: config.maximumLayers }, (_, index) => config.amountMultiplier ** index);
  const capped = equity * config.cumulativeMarginFractionCap * config.leverageSelection / weights.reduce((sum, weight) => sum + weight, 0);
  const unitFills = weights.map((weight, index) => {
    const level = index + 1;
    const trigger = level === 1 ? reference : safetyTrigger(symbol, side, reference, level, config);
    return makeFill(level, 0, trigger, adverseEntry(side, trigger, config.slippageRate), weight, config.takerFeeRate);
  });
  const stop = adverseExit(side, safetyTrigger(symbol, side, reference, config.maximumLayers + 1, config), config.slippageRate);
  const unitRisk = -fillsPnl(side, unitFills, stop, config.takerFeeRate);
  const riskScaled = unitRisk > 0 ? equity * config.maximumCycleLossFraction / unitRisk : capped;
  return Math.min(capped, riskScaled);
}

function safetyTrigger(symbol: MartingaleGridSymbol, side: "long" | "short", reference: number, level: number, config: ExchangeMartingaleConfig) {
  const additionCount = Math.max(0, level - 1);
  let cumulative = 0;
  const safetyOrders = Math.min(additionCount, config.maximumLayers - 1);
  for (let index = 0; index < safetyOrders; index += 1) cumulative += config.initialPriceStepFractionBySymbol[symbol] * config.priceStepMultiplier ** index;
  if (additionCount > safetyOrders) cumulative += config.initialPriceStepFractionBySymbol[symbol] * config.priceStepMultiplier ** safetyOrders * config.stopBeyondLastStepMultiplier;
  return side === "long" ? reference * (1 - cumulative) : reference * (1 + cumulative);
}

function makeFill(level: number, time: number, triggerPrice: number, price: number, notional: number, feeRate: number): ExchangeMartingaleFill { const quantity = notional / price; return { level, time, triggerPrice, price, quantity, notional, fee: notional * feeRate }; }
function weightedAverage(fills: ExchangeMartingaleFill[]) { const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0); return fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) / quantity; }
function target(side: "long" | "short", average: number, fraction: number) { return side === "long" ? average * (1 + fraction) : average * (1 - fraction); }
function adverseEntry(side: "long" | "short", price: number, slippage: number) { return side === "long" ? price * (1 + slippage) : price * (1 - slippage); }
function adverseExit(side: "long" | "short", price: number, slippage: number) { return side === "long" ? price * (1 - slippage) : price * (1 + slippage); }
function cyclePnl(group: OpenCycle, price: number, exitFeeRate: number) { return fillsPnl(group.side, group.fills, price, exitFeeRate); }
function fillsPnl(side: "long" | "short", fills: ExchangeMartingaleFill[], price: number, exitFeeRate: number) { const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0); const entry = fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0); const exit = price * quantity; const gross = side === "long" ? exit - entry : entry - exit; return gross - fills.reduce((sum, fill) => sum + fill.fee, 0) - exit * exitFeeRate; }
function normalize(candles: Candle[]) { return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((a, b) => a.time - b.time); }
