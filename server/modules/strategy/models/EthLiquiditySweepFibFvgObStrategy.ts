import crypto from "node:crypto";
import type { Candle } from "../../../types";
import { intervalDurationMs } from "../../market/marketConfig";
import { aggregateCandles } from "../core/candles";
import type {
  Strategy,
  StrategyEvaluationContext,
  StrategyExitPlan,
  StrategySide,
  StrategySignal,
} from "../core/types";
import {
  averageTrueRange,
  confirmedSwings,
  fairValueGap,
  isDisplacement,
  type FairValueGap,
  type SwingPoint,
} from "../ict/priceAction";
import { classifyMarketRegime } from "../ict/regime";
import { isWithinTimeZoneSession } from "../ict/time";

export type EthLiquiditySweepFibFvgObExitMode = "single_2_5r" | "scale_1r_2_5r";

export type EthLiquiditySweepFibFvgObConfig = {
  routeId: string;
  symbol: string;
  riskFraction: number;
  atrPeriod: number;
  swingLeftBars: number;
  swingRightBars: number;
  displacementBodyAtr: number;
  minSweepAtr: number;
  maxSweepAtr: number;
  sweepLookbackBars: number;
  fvgMinAtr: number;
  fvgMaxAtr: number;
  orderBlockLookbackBars: number;
  orderBlockProximityAtr: number;
  stopBufferAtr: number;
  minimumStopPoints: number;
  maximumStopPoints: number;
  rewardRisk: number;
  setupExpiryBars: number;
  sessionTimeZone: string;
  sessionStartMinute: number;
  sessionEndMinute: number;
  allowWeekends: boolean;
  exitMode: EthLiquiditySweepFibFvgObExitMode;
};

const sharedV2Config: Omit<EthLiquiditySweepFibFvgObConfig, "routeId" | "exitMode"> = {
  symbol: "ETHUSDT",
  riskFraction: 0.0025,
  atrPeriod: 14,
  swingLeftBars: 2,
  swingRightBars: 2,
  displacementBodyAtr: 0.3,
  minSweepAtr: 0.02,
  maxSweepAtr: 0.5,
  sweepLookbackBars: 24,
  fvgMinAtr: 0.05,
  fvgMaxAtr: 1,
  orderBlockLookbackBars: 6,
  orderBlockProximityAtr: 0.5,
  stopBufferAtr: 0.1,
  minimumStopPoints: 20,
  maximumStopPoints: 40,
  rewardRisk: 2.5,
  setupExpiryBars: 12,
  sessionTimeZone: "America/New_York",
  sessionStartMinute: 7 * 60,
  sessionEndMinute: 10 * 60,
  allowWeekends: false,
};

export const ethLiquiditySweepFibFvgObV2AConfig: EthLiquiditySweepFibFvgObConfig = {
  ...sharedV2Config,
  routeId: "ict-eth-liquidity-sweep-fib-fvg-ob-v2a-2026-07-16",
  exitMode: "single_2_5r",
};

export const ethLiquiditySweepFibFvgObV2BConfig: EthLiquiditySweepFibFvgObConfig = {
  ...sharedV2Config,
  routeId: "ict-eth-liquidity-sweep-fib-fvg-ob-v2b-2026-07-16",
  exitMode: "scale_1r_2_5r",
};

export type EthLiquiditySweep = {
  index: number;
  level: SwingPoint;
  extreme: number;
  penetrationAtr: number;
};

export type EthOrderBlockNearFvg = {
  index: number;
  low: number;
  high: number;
  distance: number;
  distanceAtr: number;
};

export type EthPointStopResolution = {
  stopPrice: number;
  riskDistance: number;
  structuralRiskDistance: number;
  expandedToMinimum: boolean;
};

export class EthLiquiditySweepFibFvgObStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars = 300;
  private preparedCandles: Candle[] | null = null;
  private lastConfirmedHigh: Array<SwingPoint | null> = [];
  private lastConfirmedLow: Array<SwingPoint | null> = [];
  private biasByFifteenMinuteBucket = new Map<number, "bullish" | "bearish" | "neutral">();

  constructor(readonly config: EthLiquiditySweepFibFvgObConfig = ethLiquiditySweepFibFvgObV2AConfig) {
    this.id = config.routeId;
  }

  prepare(candles: Candle[]) {
    if (this.preparedCandles === candles) return;
    this.preparedCandles = candles;
    const swings = confirmedSwings(
      candles,
      candles.length - 1,
      this.config.swingLeftBars,
      this.config.swingRightBars,
    );
    this.lastConfirmedHigh = buildLastConfirmedSwing(candles.length, swings, "high");
    this.lastConfirmedLow = buildLastConfirmedSwing(candles.length, swings, "low");
    this.biasByFifteenMinuteBucket = buildHigherTimeframeEmaBias(candles, 20);
  }

  release() {
    this.preparedCandles = null;
    this.lastConfirmedHigh = [];
    this.lastConfirmedLow = [];
    this.biasByFifteenMinuteBucket.clear();
  }

  evaluate({ candles, index }: StrategyEvaluationContext): StrategySignal | null {
    if (this.preparedCandles !== candles) this.prepare(candles);
    if (index < this.warmupBars || candles[index]?.symbol !== this.config.symbol) return null;
    const current = candles[index];
    const previous = candles[index - 1];
    if (!previous || !isWithinTimeZoneSession(
      current.time,
      this.config.sessionTimeZone,
      this.config.sessionStartMinute,
      this.config.sessionEndMinute,
    )) return null;

    const regime = classifyMarketRegime(candles, index);
    if (!this.config.allowWeekends && regime.calendar === "weekend") return null;
    const bias = this.getBias(current.time);
    if (bias === "neutral") return null;
    const side: StrategySide = bias === "bullish" ? "long" : "short";

    const atr = averageTrueRange(candles, index, this.config.atrPeriod);
    if (!atr || atr <= 0) return null;
    const sweep = this.findSweep(candles, index, side, atr);
    if (!sweep) return null;

    const structure = side === "long"
      ? this.lastConfirmedHigh[index - 1]
      : this.lastConfirmedLow[index - 1];
    if (!structure) return null;
    const firstMssBreak = side === "long"
      ? previous.close <= structure.price && current.close > structure.price
      : previous.close >= structure.price && current.close < structure.price;
    if (!firstMssBreak) return null;
    if (!isDisplacement(current, atr, side === "long" ? "bullish" : "bearish", this.config.displacementBodyAtr)) {
      return null;
    }

    const fvg = fairValueGap(candles, index);
    const expectedFvgSide = side === "long" ? "bullish" : "bearish";
    if (!fvg || fvg.side !== expectedFvgSide) return null;
    const fvgSizeAtr = (fvg.upper - fvg.lower) / atr;
    if (fvgSizeAtr < this.config.fvgMinAtr || fvgSizeAtr > this.config.fvgMaxAtr) return null;

    const displacementExtreme = side === "long" ? current.high : current.low;
    const equilibriumPrice = (sweep.extreme + displacementExtreme) / 2;
    const entryPrice = fvg.midpoint;
    const inRequiredFibHalf = side === "long"
      ? entryPrice >= sweep.extreme && entryPrice <= equilibriumPrice
      : entryPrice <= sweep.extreme && entryPrice >= equilibriumPrice;
    if (!inRequiredFibHalf) return null;
    if (side === "long" ? entryPrice >= current.close : entryPrice <= current.close) return null;

    const orderBlock = selectOrderBlockNearFvg({
      candles,
      mssIndex: index,
      side,
      fvg,
      atr,
      lookbackBars: this.config.orderBlockLookbackBars,
      maximumDistanceAtr: this.config.orderBlockProximityAtr,
    });
    if (!orderBlock) return null;

    const structuralStopPrice = side === "long"
      ? Math.min(sweep.extreme, orderBlock.low) - atr * this.config.stopBufferAtr
      : Math.max(sweep.extreme, orderBlock.high) + atr * this.config.stopBufferAtr;
    const stop = resolveEthPointStop({
      side,
      entryPrice,
      structuralStopPrice,
      minimumStopPoints: this.config.minimumStopPoints,
      maximumStopPoints: this.config.maximumStopPoints,
    });
    if (!stop) return null;

    const targetPrice = side === "long"
      ? entryPrice + stop.riskDistance * this.config.rewardRisk
      : entryPrice - stop.riskDistance * this.config.rewardRisk;
    const exitPlan = buildEthV2ExitPlan(side, entryPrice, stop.riskDistance, this.config.exitMode);

    return {
      id: crypto.createHash("sha256")
        .update(`${this.id}:${current.symbol}:${current.time}:${side}`)
        .digest("hex")
        .slice(0, 24),
      strategyId: this.id,
      symbol: current.symbol,
      interval: current.interval,
      createdAt: current.time,
      expiresAt: current.time + this.config.setupExpiryBars * intervalDurationMs(current.interval) / 1000,
      side,
      entryPrice,
      stopPrice: stop.stopPrice,
      targetPrice,
      ...(exitPlan ? { exitPlan } : {}),
      riskFraction: this.config.riskFraction,
      entryOrderType: "limit",
      reasonCodes: [
        "15M_EMA_BIAS",
        "CONFIRMED_LIQUIDITY_SWEEP",
        "DISPLACEMENT_FIRST_MSS",
        "DIRECT_FVG",
        "FIBONACCI_DISCOUNT_PREMIUM",
        "ORDER_BLOCK_PROXIMITY",
        "ETH_20_40_POINT_STOP",
        "ICT_NEW_YORK_WINDOW",
      ],
      evidence: {
        routeId: this.config.routeId,
        exitMode: this.config.exitMode,
        atr,
        bias,
        sweepIndex: sweep.index,
        sweepTime: candles[sweep.index].time,
        sweptLiquidity: sweep.level.price,
        sweepExtreme: sweep.extreme,
        sweepPenetrationAtr: sweep.penetrationAtr,
        structurePrice: structure.price,
        structureTime: structure.time,
        displacementExtreme,
        equilibriumPrice,
        fvgLower: fvg.lower,
        fvgUpper: fvg.upper,
        fvgMidpoint: fvg.midpoint,
        fvgSizeAtr,
        orderBlockIndex: orderBlock.index,
        orderBlockLow: orderBlock.low,
        orderBlockHigh: orderBlock.high,
        orderBlockDistanceAtr: orderBlock.distanceAtr,
        structuralStopPrice,
        structuralStopDistance: stop.structuralRiskDistance,
        stopDistance: stop.riskDistance,
        stopExpandedToMinimum: stop.expandedToMinimum,
        rewardRisk: this.config.rewardRisk,
        regimeKey: regime.key,
        volatilityRegime: regime.volatility,
        volatilityRatio: regime.volatilityRatio,
        structureRegime: regime.structure,
        sessionRegime: regime.session,
        calendarRegime: regime.calendar,
      },
    };
  }

  private getBias(timestamp: number) {
    const bucket = Math.floor(timestamp / (15 * 60)) * (15 * 60);
    return this.biasByFifteenMinuteBucket.get(bucket - 15 * 60) ?? "neutral";
  }

  private findSweep(candles: Candle[], index: number, side: StrategySide, atr: number): EthLiquiditySweep | null {
    const earliest = Math.max(0, index - this.config.sweepLookbackBars);
    for (let candleIndex = index - 1; candleIndex >= earliest; candleIndex -= 1) {
      const level = side === "long"
        ? this.lastConfirmedLow[candleIndex - 1]
        : this.lastConfirmedHigh[candleIndex - 1];
      if (!level) continue;
      const candle = candles[candleIndex];
      const penetration = side === "long" ? level.price - candle.low : candle.high - level.price;
      const reclaimed = side === "long" ? candle.close > level.price : candle.close < level.price;
      const penetrationAtr = penetration / atr;
      if (
        reclaimed &&
        penetrationAtr >= this.config.minSweepAtr &&
        penetrationAtr <= this.config.maxSweepAtr
      ) {
        return {
          index: candleIndex,
          level,
          extreme: side === "long" ? candle.low : candle.high,
          penetrationAtr,
        };
      }
    }
    return null;
  }
}

export function resolveEthPointStop(input: {
  side: StrategySide;
  entryPrice: number;
  structuralStopPrice: number;
  minimumStopPoints: number;
  maximumStopPoints: number;
}): EthPointStopResolution | null {
  const { side, entryPrice, structuralStopPrice, minimumStopPoints, maximumStopPoints } = input;
  if (
    !Number.isFinite(entryPrice) || entryPrice <= 0 ||
    !Number.isFinite(structuralStopPrice) ||
    !Number.isFinite(minimumStopPoints) || minimumStopPoints <= 0 ||
    !Number.isFinite(maximumStopPoints) || maximumStopPoints < minimumStopPoints ||
    (side === "long" ? structuralStopPrice >= entryPrice : structuralStopPrice <= entryPrice)
  ) return null;
  const structuralRiskDistance = Math.abs(entryPrice - structuralStopPrice);
  if (structuralRiskDistance > maximumStopPoints) return null;
  const riskDistance = Math.max(structuralRiskDistance, minimumStopPoints);
  return {
    stopPrice: side === "long" ? entryPrice - riskDistance : entryPrice + riskDistance,
    riskDistance,
    structuralRiskDistance,
    expandedToMinimum: structuralRiskDistance < minimumStopPoints,
  };
}

export function selectOrderBlockNearFvg(input: {
  candles: Candle[];
  mssIndex: number;
  side: StrategySide;
  fvg: FairValueGap;
  atr: number;
  lookbackBars: number;
  maximumDistanceAtr: number;
}): EthOrderBlockNearFvg | null {
  const { candles, mssIndex, side, fvg, atr, lookbackBars, maximumDistanceAtr } = input;
  if (!Number.isFinite(atr) || atr <= 0 || lookbackBars <= 0 || maximumDistanceAtr < 0) return null;
  const firstIndex = Math.max(0, mssIndex - lookbackBars);
  for (let index = mssIndex - 1; index >= firstIndex; index -= 1) {
    const candle = candles[index];
    const isOpposite = side === "long" ? candle.close < candle.open : candle.close > candle.open;
    if (!isOpposite) continue;
    const distance = distanceBetweenRanges(fvg.lower, fvg.upper, candle.low, candle.high);
    const distanceAtr = distance / atr;
    if (distanceAtr > maximumDistanceAtr) return null;
    return { index, low: candle.low, high: candle.high, distance, distanceAtr };
  }
  return null;
}

export function buildHigherTimeframeEmaBias(candles: Candle[], period = 20) {
  const higher = aggregateCandles(candles, "15m");
  const result = new Map<number, "bullish" | "bearish" | "neutral">();
  if (period <= 0 || !Number.isInteger(period) || higher.length === 0) return result;
  const multiplier = 2 / (period + 1);
  let ema = higher[0].close;
  for (let index = 0; index < higher.length; index += 1) {
    if (index > 0) ema = (higher[index].close - ema) * multiplier + ema;
    const bias = index < period - 1
      ? "neutral"
      : higher[index].close > ema
        ? "bullish"
        : higher[index].close < ema
          ? "bearish"
          : "neutral";
    result.set(higher[index].time, bias);
  }
  return result;
}

export function buildEthV2ExitPlan(
  side: StrategySide,
  entryPrice: number,
  riskDistance: number,
  exitMode: EthLiquiditySweepFibFvgObExitMode,
): StrategyExitPlan | null {
  if (exitMode === "single_2_5r") return null;
  const direction = side === "long" ? 1 : -1;
  return {
    targets: [
      {
        price: entryPrice + direction * riskDistance,
        quantityFraction: 0.5,
        moveStopToBreakEvenAfterFill: true,
        label: "tp1_1r",
      },
      {
        price: entryPrice + direction * riskDistance * 2.5,
        quantityFraction: 0.5,
        label: "tp2_2_5r",
      },
    ],
  };
}

function buildLastConfirmedSwing(length: number, swings: SwingPoint[], kind: SwingPoint["kind"]) {
  const byConfirmation = new Map<number, SwingPoint[]>();
  for (const swing of swings.filter((item) => item.kind === kind)) {
    const list = byConfirmation.get(swing.confirmedAtIndex) ?? [];
    list.push(swing);
    byConfirmation.set(swing.confirmedAtIndex, list);
  }
  const result: Array<SwingPoint | null> = Array.from({ length }, () => null);
  let latest: SwingPoint | null = null;
  for (let index = 0; index < length; index += 1) {
    for (const swing of byConfirmation.get(index) ?? []) latest = swing;
    result[index] = latest;
  }
  return result;
}

function distanceBetweenRanges(firstLow: number, firstHigh: number, secondLow: number, secondHigh: number) {
  if (firstHigh < secondLow) return secondLow - firstHigh;
  if (secondHigh < firstLow) return firstLow - secondHigh;
  return 0;
}
