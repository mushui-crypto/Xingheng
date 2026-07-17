import crypto from "node:crypto";
import type { Candle, CandleInterval } from "../../../types";
import { intervalDurationMs } from "../../market/marketConfig";
import { aggregateCandles } from "../core/candles";
import type {
  Strategy,
  StrategyEvaluationContext,
  StrategySide,
  StrategySignal,
} from "../core/types";
import {
  averageTrueRange,
  confirmedSwings,
  fairValueGap,
  isDisplacement,
  type SwingPoint,
} from "../ict/priceAction";
import { classifyMarketRegime } from "../ict/regime";
import { isWithinTimeZoneSession } from "../ict/time";
import {
  buildEthV2ExitPlan,
  resolveEthPointStop,
  selectOrderBlockNearFvg,
  type EthLiquiditySweep,
} from "./EthLiquiditySweepFibFvgObStrategy";

export type EthHtfAlignedLiquiditySweepConfig = {
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
  maximumHoldingBars: number;
  biasPeriod: number;
  fastBiasInterval: "15m";
  slowBiasInterval: "1h";
  minimumVolatilityRatio: number;
  sessionTimeZone: string;
  sessionStartMinute: number;
  sessionEndMinute: number;
  allowWeekends: boolean;
};

export const ethHtfAlignedLiquiditySweepV3Config: EthHtfAlignedLiquiditySweepConfig = {
  routeId: "ict-eth-htf-aligned-immediate-sweep-fvg-ob-v3-2026-07-16",
  symbol: "ETHUSDT",
  riskFraction: 0.0025,
  atrPeriod: 14,
  swingLeftBars: 2,
  swingRightBars: 2,
  displacementBodyAtr: 0.3,
  minSweepAtr: 0.02,
  maxSweepAtr: 0.5,
  sweepLookbackBars: 6,
  fvgMinAtr: 0.05,
  fvgMaxAtr: 1,
  orderBlockLookbackBars: 6,
  orderBlockProximityAtr: 0.5,
  stopBufferAtr: 0.1,
  minimumStopPoints: 20,
  maximumStopPoints: 40,
  rewardRisk: 2.5,
  setupExpiryBars: 6,
  maximumHoldingBars: 24,
  biasPeriod: 20,
  fastBiasInterval: "15m",
  slowBiasInterval: "1h",
  minimumVolatilityRatio: 1.25,
  sessionTimeZone: "America/New_York",
  sessionStartMinute: 7 * 60,
  sessionEndMinute: 10 * 60,
  allowWeekends: false,
};

type DirectionalBias = "bullish" | "bearish" | "neutral";

export class EthHtfAlignedLiquiditySweepStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars = 300;
  private preparedCandles: Candle[] | null = null;
  private lastConfirmedHigh: Array<SwingPoint | null> = [];
  private lastConfirmedLow: Array<SwingPoint | null> = [];
  private fastBias = new Map<number, DirectionalBias>();
  private slowBias = new Map<number, DirectionalBias>();

  constructor(readonly config: EthHtfAlignedLiquiditySweepConfig = ethHtfAlignedLiquiditySweepV3Config) {
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
    this.fastBias = buildCompletedEmaBias(candles, this.config.fastBiasInterval, this.config.biasPeriod);
    this.slowBias = buildCompletedEmaBias(candles, this.config.slowBiasInterval, this.config.biasPeriod);
  }

  release() {
    this.preparedCandles = null;
    this.lastConfirmedHigh = [];
    this.lastConfirmedLow = [];
    this.fastBias.clear();
    this.slowBias.clear();
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
    if (regime.volatilityRatio < this.config.minimumVolatilityRatio) return null;

    const alignment = this.getAlignedBias(current.time);
    if (alignment.bias === "neutral") return null;
    const side: StrategySide = alignment.bias === "bullish" ? "long" : "short";

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
    const exitPlan = buildEthV2ExitPlan(side, entryPrice, stop.riskDistance, "scale_1r_2_5r");
    if (!exitPlan) return null;
    const candleSeconds = intervalDurationMs(current.interval) / 1000;

    return {
      id: crypto.createHash("sha256")
        .update(`${this.id}:${current.symbol}:${current.time}:${side}`)
        .digest("hex")
        .slice(0, 24),
      strategyId: this.id,
      symbol: current.symbol,
      interval: current.interval,
      createdAt: current.time,
      expiresAt: current.time + this.config.setupExpiryBars * candleSeconds,
      side,
      entryPrice,
      stopPrice: stop.stopPrice,
      targetPrice,
      exitPlan,
      maxHoldingSeconds: this.config.maximumHoldingBars * candleSeconds,
      riskFraction: this.config.riskFraction,
      entryOrderType: "limit",
      reasonCodes: [
        "15M_1H_EMA20_ALIGNMENT",
        "BTC_V5_HIGH_VOLATILITY_FILTER",
        "IMMEDIATE_CONFIRMED_LIQUIDITY_SWEEP",
        "DISPLACEMENT_FIRST_MSS",
        "DIRECT_FVG",
        "FIBONACCI_DISCOUNT_PREMIUM",
        "ORDER_BLOCK_PROXIMITY",
        "ETH_20_40_POINT_STOP",
        "SCALE_1R_2_5R_BREAK_EVEN",
        "MAX_HOLDING_24_BARS",
        "ICT_NEW_YORK_WINDOW",
      ],
      evidence: {
        routeId: this.config.routeId,
        exitMode: "scale_1r_2_5r",
        atr,
        bias: alignment.bias,
        fastBias: alignment.fast,
        slowBias: alignment.slow,
        fastBiasInterval: this.config.fastBiasInterval,
        slowBiasInterval: this.config.slowBiasInterval,
        biasPeriod: this.config.biasPeriod,
        minimumVolatilityRatio: this.config.minimumVolatilityRatio,
        sweepLookbackBars: this.config.sweepLookbackBars,
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
        maximumHoldingBars: this.config.maximumHoldingBars,
        maximumHoldingSeconds: this.config.maximumHoldingBars * candleSeconds,
        regimeKey: regime.key,
        volatilityRegime: regime.volatility,
        volatilityRatio: regime.volatilityRatio,
        structureRegime: regime.structure,
        sessionRegime: regime.session,
        calendarRegime: regime.calendar,
      },
    };
  }

  private getAlignedBias(timestamp: number) {
    const fast = completedBiasAt(timestamp, this.config.fastBiasInterval, this.fastBias);
    const slow = completedBiasAt(timestamp, this.config.slowBiasInterval, this.slowBias);
    return {
      fast,
      slow,
      bias: fast !== "neutral" && fast === slow ? fast : "neutral",
    } as const;
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

export function buildCompletedEmaBias(
  candles: Candle[],
  interval: Extract<CandleInterval, "15m" | "1h">,
  period = 20,
) {
  const higher = aggregateCandles(candles, interval);
  const result = new Map<number, DirectionalBias>();
  if (period <= 0 || !Number.isInteger(period) || higher.length === 0) return result;
  const multiplier = 2 / (period + 1);
  let ema = higher[0].close;
  for (let index = 0; index < higher.length; index += 1) {
    if (index > 0) ema = (higher[index].close - ema) * multiplier + ema;
    const bias: DirectionalBias = index < period - 1
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

export function completedBiasAt(
  timestamp: number,
  interval: Extract<CandleInterval, "15m" | "1h">,
  biasByBucket: Map<number, DirectionalBias>,
): DirectionalBias {
  const seconds = intervalDurationMs(interval) / 1000;
  const currentBucket = Math.floor(timestamp / seconds) * seconds;
  return biasByBucket.get(currentBucket - seconds) ?? "neutral";
}

export function alignDirectionalBias(fast: DirectionalBias, slow: DirectionalBias): DirectionalBias {
  return fast !== "neutral" && fast === slow ? fast : "neutral";
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
