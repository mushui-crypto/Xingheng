import type { Candle } from "../../../types";
import {
  calculateFixedGridDirections,
  FIXED_GRID_CONFIG,
} from "../runtime/FixedGridPaperEngine";
import type { MartingaleGridSymbol } from "../runtime/MartingaleGridPaperEngine";

export type ExchangeMartingaleV2Config = {
  id: string;
  initialEquity: number;
  leverageSelection: number;
  marginMode: "isolated";
  maximumLayers: 6 | 8;
  amountMultiplier: number;
  priceStepMultiplier: number;
  stepMode: "fixed_fraction" | "completed_1h_atr";
  fixedStepFractionBySymbol: Record<MartingaleGridSymbol, number>;
  atrStepMultiplier: number;
  minimumStepFraction: number;
  maximumStepFraction: number;
  takeProfitPriceFraction: 0.008 | 0.012;
  reentryPolicy: "cooldown_4h" | "new_confirmation";
  cooldownMinutes: number;
  entryPolicy?: "immediate" | "confirmation_retracement";
  entryRetracementStepMultiple?: number;
  cumulativeMarginFractionCap: number;
  maximumCycleLossFraction: number;
  stopBeyondLastStepMultiplier: number;
  maintenanceMarginRateStress: number;
  takerFeeRate: number;
  slippageRate: number;
};

export type ExchangeMartingaleV2Fill = {
  level: number;
  time: number;
  triggerPrice: number;
  price: number;
  quantity: number;
  notional: number;
  fee: number;
};

export type ExchangeMartingaleV2Cycle = {
  id: string;
  symbol: MartingaleGridSymbol;
  side: "long" | "short";
  signalTime: number;
  entryTime: number;
  exitTime: number;
  exitReason: "cycle_take_profit" | "cycle_stop" | "approx_liquidation";
  referencePrice: number;
  stepFraction: number;
  averageEntryPrice: number;
  targetPrice: number;
  stopPrice: number;
  approximateLiquidationPrice: number;
  fills: ExchangeMartingaleV2Fill[];
  quantity: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  plannedRisk: number;
  rMultiple: number;
  holdingMinutes: number;
};

type OpenCycle = Omit<ExchangeMartingaleV2Cycle,
  "exitTime" | "exitReason" | "grossPnl" | "fees" | "netPnl" | "rMultiple" | "holdingMinutes"
> & {
  baseNotional: number;
  feesPaid: number;
  lastFillTime: number;
};

export type ExchangeMartingaleV2Simulation = {
  completed: ExchangeMartingaleV2Cycle[];
  equityCurve: Array<{ time: number; equity: number }>;
  diagnostics: {
    longConfirmations: number;
    shortConfirmations: number;
    startedCycles: number;
    takeProfits: number;
    stops: number;
    approximateLiquidations: number;
    maximumLayerCycles: number;
    modeSwitches: number;
  };
};

export function simulateExchangeStyleDirectionalMartingaleV2(
  symbol: MartingaleGridSymbol,
  inputCandles: Candle[],
  options: { forwardStart: number; config: ExchangeMartingaleV2Config },
): ExchangeMartingaleV2Simulation {
  const config = options.config;
  const candles = normalize(inputCandles).filter((candle) => candle.symbol === symbol);
  const directions = calculateFixedGridDirections(candles, FIXED_GRID_CONFIG);
  const atrStepFractions = completedOneHourAtrStepFractions(candles, config);
  const completed: ExchangeMartingaleV2Cycle[] = [];
  const equityCurve: Array<{ time: number; equity: number }> = [];
  let equity = config.initialEquity;
  let selectedSide: "long" | "short" | null = null;
  let pending: {
    side: "long" | "short";
    signalTime: number;
    eligibleAt: number;
    stepFraction?: number;
    triggerPrice?: number;
    touchedAt?: number;
  } | null = null;
  let open: OpenCycle | null = null;
  let longConfirmations = 0;
  let shortConfirmations = 0;
  let startedCycles = 0;
  let takeProfits = 0;
  let stops = 0;
  let approximateLiquidations = 0;
  let maximumLayerCycles = 0;
  let modeSwitches = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.time < options.forwardStart) continue;

    if (!open && pending && shouldStartPending(pending, candle, config)) {
      const stepFraction = pending.stepFraction ?? (config.stepMode === "completed_1h_atr"
        ? atrStepFractions[index]
        : config.fixedStepFractionBySymbol[symbol]);
      open = startCycle(symbol, pending.side, pending.signalTime, candle, equity, stepFraction, config);
      pending = null;
      startedCycles += 1;
    } else if (!open && pending && shouldMarkRetracementTouched(pending, candle, config)) {
      pending.touchedAt = candle.time;
    }

    if (open) {
      const closed = processCycle(open, candle, config);
      if (closed) {
        completed.push(closed);
        equity += closed.netPnl;
        if (closed.fills.length === config.maximumLayers) maximumLayerCycles += 1;
        if (closed.exitReason === "cycle_take_profit") {
          takeProfits += 1;
          if (config.reentryPolicy === "cooldown_4h" && selectedSide === closed.side) {
            const stepFraction = config.stepMode === "completed_1h_atr"
              ? atrStepFractions[index]
              : config.fixedStepFractionBySymbol[symbol];
            pending = {
              side: closed.side,
              signalTime: candle.time,
              eligibleAt: candle.time + config.cooldownMinutes * 60,
              ...(config.entryPolicy === "confirmation_retracement" ? {
                stepFraction,
                triggerPrice: retracementTrigger(closed.side, candle.close, stepFraction, config.entryRetracementStepMultiple ?? 1),
              } : {}),
            };
          }
        } else {
          if (closed.exitReason === "approx_liquidation") approximateLiquidations += 1;
          else stops += 1;
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
      if (!open) {
        const stepFraction = config.stepMode === "completed_1h_atr"
          ? atrStepFractions[index]
          : config.fixedStepFractionBySymbol[symbol];
        pending = {
          side: nextSide,
          signalTime: direction.confirmedAt,
          eligibleAt: candle.time + 300,
          ...(config.entryPolicy === "confirmation_retracement" ? {
            stepFraction,
            triggerPrice: retracementTrigger(nextSide, direction.anchorPrice ?? candle.close, stepFraction, config.entryRetracementStepMultiple ?? 1),
          } : {}),
        };
      }
    }

    const unrealizedPnl = open ? fillsPnl(open.side, open.fills, candle.close, config.takerFeeRate) : 0;
    equityCurve.push({ time: candle.time, equity: equity + unrealizedPnl });
  }

  return {
    completed,
    equityCurve,
    diagnostics: {
      longConfirmations,
      shortConfirmations,
      startedCycles,
      takeProfits,
      stops,
      approximateLiquidations,
      maximumLayerCycles,
      modeSwitches,
    },
  };
}

function startCycle(
  symbol: MartingaleGridSymbol,
  side: "long" | "short",
  signalTime: number,
  candle: Candle,
  equity: number,
  stepFraction: number,
  config: ExchangeMartingaleV2Config,
): OpenCycle {
  const referencePrice = candle.open;
  const baseNotional = resolveBaseNotional(side, referencePrice, stepFraction, equity, config);
  const entryPrice = adverseEntry(side, referencePrice, config.slippageRate);
  const first = makeFill(1, candle.time, referencePrice, entryPrice, baseNotional, config.takerFeeRate);
  const stopPrice = safetyTrigger(side, referencePrice, stepFraction, config.maximumLayers + 1, config);
  const plannedRisk = Math.max(0.01, plannedUnitRisk(side, referencePrice, stepFraction, config) * baseNotional);
  return {
    id: `exchange-martingale-v2-${config.id}-${symbol}-${side}-${signalTime}`,
    symbol,
    side,
    signalTime,
    entryTime: candle.time,
    referencePrice,
    stepFraction,
    averageEntryPrice: entryPrice,
    targetPrice: target(side, entryPrice, config.takeProfitPriceFraction),
    stopPrice,
    approximateLiquidationPrice: approximateLiquidationPrice(side, entryPrice, config),
    fills: [first],
    quantity: first.quantity,
    plannedRisk,
    baseNotional,
    feesPaid: first.fee,
    lastFillTime: candle.time,
  };
}

function processCycle(group: OpenCycle, candle: Candle, config: ExchangeMartingaleV2Config): ExchangeMartingaleV2Cycle | null {
  while (group.fills.length < config.maximumLayers) {
    group.approximateLiquidationPrice = approximateLiquidationPrice(group.side, group.averageEntryPrice, config);
    const nextLevel = group.fills.length + 1;
    const nextTrigger = safetyTrigger(group.side, group.referencePrice, group.stepFraction, nextLevel, config);
    if (adverseBoundaryComesFirst(group.side, group.approximateLiquidationPrice, nextTrigger)
      && touchedAdverse(group.side, candle, group.approximateLiquidationPrice)) {
      return closeCycle(group, candle.time, gapAdjustedExit(group.side, candle, group.approximateLiquidationPrice, config.slippageRate), "approx_liquidation", config);
    }
    if (!touchedAdverse(group.side, candle, nextTrigger)) break;
    const fill = makeFill(
      nextLevel,
      candle.time,
      nextTrigger,
      adverseEntry(group.side, nextTrigger, config.slippageRate),
      group.baseNotional * config.amountMultiplier ** (nextLevel - 1),
      config.takerFeeRate,
    );
    group.fills.push(fill);
    group.feesPaid += fill.fee;
    group.quantity += fill.quantity;
    group.averageEntryPrice = weightedAverage(group.fills);
    group.targetPrice = target(group.side, group.averageEntryPrice, config.takeProfitPriceFraction);
    group.approximateLiquidationPrice = approximateLiquidationPrice(group.side, group.averageEntryPrice, config);
    group.lastFillTime = candle.time;
  }

  const liquidationFirst = adverseBoundaryComesFirst(group.side, group.approximateLiquidationPrice, group.stopPrice);
  const boundary = liquidationFirst ? group.approximateLiquidationPrice : group.stopPrice;
  if (touchedAdverse(group.side, candle, boundary)) {
    return closeCycle(
      group,
      candle.time,
      gapAdjustedExit(group.side, candle, boundary, config.slippageRate),
      liquidationFirst ? "approx_liquidation" : "cycle_stop",
      config,
    );
  }
  if (candle.time === group.lastFillTime) return null;
  const targeted = group.side === "long" ? candle.high >= group.targetPrice : candle.low <= group.targetPrice;
  return targeted
    ? closeCycle(group, candle.time, adverseExit(group.side, group.targetPrice, config.slippageRate), "cycle_take_profit", config)
    : null;
}

function closeCycle(
  group: OpenCycle,
  exitTime: number,
  exitPrice: number,
  exitReason: ExchangeMartingaleV2Cycle["exitReason"],
  config: ExchangeMartingaleV2Config,
): ExchangeMartingaleV2Cycle {
  const entryValue = group.fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
  const exitValue = exitPrice * group.quantity;
  const grossPnl = group.side === "long" ? exitValue - entryValue : entryValue - exitValue;
  const fees = group.feesPaid + exitValue * config.takerFeeRate;
  const netPnl = grossPnl - fees;
  return {
    id: group.id,
    symbol: group.symbol,
    side: group.side,
    signalTime: group.signalTime,
    entryTime: group.entryTime,
    exitTime,
    exitReason,
    referencePrice: group.referencePrice,
    stepFraction: group.stepFraction,
    averageEntryPrice: group.averageEntryPrice,
    targetPrice: group.targetPrice,
    stopPrice: group.stopPrice,
    approximateLiquidationPrice: group.approximateLiquidationPrice,
    fills: group.fills.map((fill) => ({ ...fill })),
    quantity: group.quantity,
    grossPnl,
    fees,
    netPnl,
    plannedRisk: group.plannedRisk,
    rMultiple: netPnl / group.plannedRisk,
    holdingMinutes: (exitTime - group.entryTime) / 60,
  };
}

function resolveBaseNotional(
  side: "long" | "short",
  referencePrice: number,
  stepFraction: number,
  equity: number,
  config: ExchangeMartingaleV2Config,
) {
  const weights = Array.from({ length: config.maximumLayers }, (_, index) => config.amountMultiplier ** index);
  const marginCapped = equity * config.cumulativeMarginFractionCap * config.leverageSelection
    / weights.reduce((sum, weight) => sum + weight, 0);
  const unitRisk = plannedUnitRisk(side, referencePrice, stepFraction, config);
  const riskCapped = unitRisk > 0 ? equity * config.maximumCycleLossFraction / unitRisk : marginCapped;
  return Math.min(marginCapped, riskCapped);
}

function plannedUnitRisk(
  side: "long" | "short",
  referencePrice: number,
  stepFraction: number,
  config: ExchangeMartingaleV2Config,
) {
  const fills: ExchangeMartingaleV2Fill[] = [];
  for (let index = 0; index < config.maximumLayers; index += 1) {
    const level = index + 1;
    const triggerPrice = level === 1
      ? referencePrice
      : safetyTrigger(side, referencePrice, stepFraction, level, config);
    if (fills.length > 0) {
      const currentAverage = weightedAverage(fills);
      const liquidation = approximateLiquidationPrice(side, currentAverage, config);
      if (adverseBoundaryComesFirst(side, liquidation, triggerPrice)) {
        return Math.max(0.000001, -fillsPnl(side, fills, liquidation, config.takerFeeRate));
      }
    }
    fills.push(makeFill(
      level,
      0,
      triggerPrice,
      adverseEntry(side, triggerPrice, config.slippageRate),
      config.amountMultiplier ** index,
      config.takerFeeRate,
    ));
  }
  const average = weightedAverage(fills);
  const liquidation = approximateLiquidationPrice(side, average, config);
  const stop = safetyTrigger(side, referencePrice, stepFraction, config.maximumLayers + 1, config);
  const boundary = adverseBoundaryComesFirst(side, liquidation, stop) ? liquidation : stop;
  return Math.max(0.000001, -fillsPnl(side, fills, adverseExit(side, boundary, config.slippageRate), config.takerFeeRate));
}

export function approximateLiquidationPrice(
  side: "long" | "short",
  averageEntryPrice: number,
  config: Pick<ExchangeMartingaleV2Config, "leverageSelection" | "maintenanceMarginRateStress">,
) {
  const adverseFraction = 1 / config.leverageSelection - config.maintenanceMarginRateStress;
  return side === "long"
    ? averageEntryPrice * (1 - adverseFraction)
    : averageEntryPrice * (1 + adverseFraction);
}

function completedOneHourAtrStepFractions(candles: Candle[], config: ExchangeMartingaleV2Config) {
  const buckets = new Map<number, Candle>();
  for (const candle of candles) {
    const time = Math.floor(candle.time / 3600) * 3600;
    const existing = buckets.get(time);
    if (!existing) buckets.set(time, { ...candle, interval: "1h", time });
    else {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume += candle.volume;
    }
  }
  const hourly = [...buckets.values()].sort((left, right) => left.time - right.time);
  const atrFractionByBucket = new Map<number, number>();
  const trueRanges: number[] = [];
  for (let index = 0; index < hourly.length; index += 1) {
    const candle = hourly[index];
    const previousClose = hourly[index - 1]?.close ?? candle.open;
    trueRanges.push(Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose)));
    if (trueRanges.length >= 14) {
      const atr = trueRanges.slice(-14).reduce((sum, value) => sum + value, 0) / 14;
      atrFractionByBucket.set(candle.time, clamp(atr / candle.close * config.atrStepMultiplier, config.minimumStepFraction, config.maximumStepFraction));
    }
  }
  return candles.map((candle) => {
    const previousCompletedHour = Math.floor(candle.time / 3600) * 3600 - 3600;
    return atrFractionByBucket.get(previousCompletedHour)
      ?? config.fixedStepFractionBySymbol[candle.symbol as MartingaleGridSymbol];
  });
}

function safetyTrigger(
  side: "long" | "short",
  referencePrice: number,
  stepFraction: number,
  level: number,
  config: ExchangeMartingaleV2Config,
) {
  const additionCount = Math.max(0, level - 1);
  let cumulative = 0;
  const safetyOrders = Math.min(additionCount, config.maximumLayers - 1);
  for (let index = 0; index < safetyOrders; index += 1) cumulative += stepFraction * config.priceStepMultiplier ** index;
  if (additionCount > safetyOrders) {
    cumulative += stepFraction * config.priceStepMultiplier ** safetyOrders * config.stopBeyondLastStepMultiplier;
  }
  return side === "long" ? referencePrice * (1 - cumulative) : referencePrice * (1 + cumulative);
}

function makeFill(level: number, time: number, triggerPrice: number, price: number, notional: number, feeRate: number): ExchangeMartingaleV2Fill {
  const quantity = notional / price;
  return { level, time, triggerPrice, price, quantity, notional, fee: notional * feeRate };
}
function weightedAverage(fills: ExchangeMartingaleV2Fill[]) {
  const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  return fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) / quantity;
}
function target(side: "long" | "short", average: number, fraction: number) {
  return side === "long" ? average * (1 + fraction) : average * (1 - fraction);
}
function adverseEntry(side: "long" | "short", price: number, slippage: number) {
  return side === "long" ? price * (1 + slippage) : price * (1 - slippage);
}
function adverseExit(side: "long" | "short", price: number, slippage: number) {
  return side === "long" ? price * (1 - slippage) : price * (1 + slippage);
}
function gapAdjustedExit(side: "long" | "short", candle: Candle, boundary: number, slippage: number) {
  const gapPrice = side === "long" ? Math.min(candle.open, boundary) : Math.max(candle.open, boundary);
  return adverseExit(side, gapPrice, slippage);
}
function adverseBoundaryComesFirst(side: "long" | "short", left: number, right: number) {
  return side === "long" ? left >= right : left <= right;
}
function touchedAdverse(side: "long" | "short", candle: Candle, price: number) {
  return side === "long" ? candle.low <= price : candle.high >= price;
}
function shouldStartPending(
  pending: { eligibleAt: number; touchedAt?: number },
  candle: Candle,
  config: ExchangeMartingaleV2Config,
) {
  if (config.entryPolicy !== "confirmation_retracement") return candle.time >= pending.eligibleAt;
  return pending.touchedAt !== undefined && candle.time > pending.touchedAt;
}
function shouldMarkRetracementTouched(
  pending: { side: "long" | "short"; eligibleAt: number; triggerPrice?: number; touchedAt?: number },
  candle: Candle,
  config: ExchangeMartingaleV2Config,
) {
  return config.entryPolicy === "confirmation_retracement"
    && pending.touchedAt === undefined
    && pending.triggerPrice !== undefined
    && candle.time >= pending.eligibleAt
    && touchedAdverse(pending.side, candle, pending.triggerPrice);
}
function retracementTrigger(side: "long" | "short", reference: number, stepFraction: number, multiple: number) {
  return side === "long"
    ? reference * (1 - stepFraction * multiple)
    : reference * (1 + stepFraction * multiple);
}
function fillsPnl(side: "long" | "short", fills: ExchangeMartingaleV2Fill[], price: number, exitFeeRate: number) {
  const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  const entryValue = fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
  const exitValue = price * quantity;
  const gross = side === "long" ? exitValue - entryValue : entryValue - exitValue;
  return gross - fills.reduce((sum, fill) => sum + fill.fee, 0) - exitValue * exitFeeRate;
}
function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
function normalize(candles: Candle[]) {
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((left, right) => left.time - right.time);
}
