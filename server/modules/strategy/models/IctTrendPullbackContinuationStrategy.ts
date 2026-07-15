import crypto from "node:crypto";
import type { Candle } from "../../../types";
import { intervalDurationMs } from "../../market/marketConfig";
import { aggregateCandles } from "../core/candles";
import type { Strategy, StrategyEvaluationContext, StrategySignal, StrategySide } from "../core/types";
import { averageTrueRange, fairValueGap, isDisplacement } from "../ict/priceAction";
import { classifyMarketRegime } from "../ict/regime";
import { isWithinTimeZoneSession } from "../ict/time";

export type IctTrendPullbackContinuationConfig = {
  routeId: string;
  symbol: string;
  riskFraction: number;
  atrPeriod: number;
  fastEmaPeriod: number;
  slowEmaPeriod: number;
  emaSlopeLookbackBars: number;
  displacementBodyAtr: number;
  fvgMinAtr: number;
  fvgMaxAtr: number;
  fvgRetraceFraction: number;
  setupExpiryBars: number;
  stopBufferAtr: number;
  minStopAtr: number;
  maxStopAtr: number;
  rewardRisk: number;
  minimumVolatilityRatio: number;
  sessionStartMinute: number;
  sessionEndMinute: number;
  sessionTimeZone: string;
  allowWeekends: boolean;
};

export const ictRouteATrendPullbackV1Config = Object.freeze({
  routeId: "ict-route-a-trend-pullback-v1",
  symbol: "BTCUSDT",
  riskFraction: 0.0025,
  atrPeriod: 14,
  fastEmaPeriod: 20,
  slowEmaPeriod: 50,
  emaSlopeLookbackBars: 4,
  displacementBodyAtr: 0.8,
  fvgMinAtr: 0.05,
  fvgMaxAtr: 0.75,
  fvgRetraceFraction: 0.5,
  setupExpiryBars: 6,
  stopBufferAtr: 0.25,
  minStopAtr: 0.5,
  maxStopAtr: 3,
  rewardRisk: 2,
  minimumVolatilityRatio: 1,
  sessionStartMinute: 18 * 60,
  sessionEndMinute: 8 * 60,
  sessionTimeZone: "Asia/Shanghai",
  allowWeekends: false,
} satisfies IctTrendPullbackContinuationConfig);

export class IctTrendPullbackContinuationStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars: number;
  private preparedCandles: Candle[] | null = null;
  private biasByFifteenMinuteBucket = new Map<number, "bullish" | "bearish" | "neutral">();

  constructor(readonly config: IctTrendPullbackContinuationConfig = ictRouteATrendPullbackV1Config) {
    this.id = config.routeId;
    this.warmupBars = Math.max(300, (config.slowEmaPeriod + config.emaSlopeLookbackBars) * 3);
  }

  prepare(candles: Candle[]) {
    if (this.preparedCandles === candles) return;
    this.preparedCandles = candles;
    this.biasByFifteenMinuteBucket = buildTrendBias(candles, this.config);
  }

  release() {
    this.preparedCandles = null;
    this.biasByFifteenMinuteBucket.clear();
  }

  evaluate({ candles, index }: StrategyEvaluationContext): StrategySignal | null {
    if (this.preparedCandles !== candles) this.prepare(candles);
    if (index < this.warmupBars || candles[index].symbol !== this.config.symbol) return null;
    const current = candles[index];
    if (!isWithinTimeZoneSession(
      current.time,
      this.config.sessionTimeZone,
      this.config.sessionStartMinute,
      this.config.sessionEndMinute,
    )) return null;

    const fifteenMinuteBucket = Math.floor(current.time / (15 * 60)) * (15 * 60);
    const bias = this.biasByFifteenMinuteBucket.get(fifteenMinuteBucket - 15 * 60) ?? "neutral";
    if (bias === "neutral") return null;
    const side: StrategySide = bias === "bullish" ? "long" : "short";
    const displacementSide = side === "long" ? "bullish" : "bearish";
    const atr = averageTrueRange(candles, index, this.config.atrPeriod);
    if (!atr || atr <= 0 || !isDisplacement(current, atr, displacementSide, this.config.displacementBodyAtr)) return null;

    const gap = fairValueGap(candles, index);
    if (!gap || gap.side !== displacementSide) return null;
    const gapSize = gap.upper - gap.lower;
    if (gapSize < atr * this.config.fvgMinAtr || gapSize > atr * this.config.fvgMaxAtr) return null;

    const regime = classifyMarketRegime(candles, index);
    if (!this.config.allowWeekends && regime.calendar === "weekend") return null;
    if (regime.volatilityRatio < this.config.minimumVolatilityRatio) return null;

    const entryPrice = fvgMidpointEntry(gap.lower, gap.upper, side, this.config.fvgRetraceFraction);
    const origin = side === "long"
      ? Math.min(candles[index - 1].low, current.low)
      : Math.max(candles[index - 1].high, current.high);
    const stopPrice = side === "long"
      ? origin - atr * this.config.stopBufferAtr
      : origin + atr * this.config.stopBufferAtr;
    const riskDistance = Math.abs(entryPrice - stopPrice);
    if (
      (side === "long" ? stopPrice >= entryPrice : stopPrice <= entryPrice) ||
      riskDistance < atr * this.config.minStopAtr ||
      riskDistance > atr * this.config.maxStopAtr
    ) return null;
    const targetPrice = side === "long"
      ? entryPrice + riskDistance * this.config.rewardRisk
      : entryPrice - riskDistance * this.config.rewardRisk;

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
      stopPrice,
      targetPrice,
      riskFraction: this.config.riskFraction,
      entryOrderType: "limit",
      reasonCodes: ["HTF_EMA_TREND", "EMA_SLOPE", "DISPLACEMENT", "FVG_PULLBACK"],
      evidence: {
        routeId: this.config.routeId,
        atr,
        structuralStopPrice: stopPrice,
        stopDistance: riskDistance,
        stopDistanceAtr: riskDistance / atr,
        fvgLower: gap.lower,
        fvgUpper: gap.upper,
        fvgSizeAtr: gapSize / atr,
        volatilityRatio: regime.volatilityRatio,
        volatilityRegime: regime.volatility,
        structureRegime: regime.structure,
        sessionRegime: regime.session,
        calendarRegime: regime.calendar,
        regimeKey: regime.key,
      },
    };
  }
}

function fvgMidpointEntry(lower: number, upper: number, side: StrategySide, retraceFraction: number) {
  const fraction = Math.max(0, Math.min(1, retraceFraction));
  const size = upper - lower;
  return side === "long" ? upper - size * fraction : lower + size * fraction;
}

function buildTrendBias(candles: Candle[], config: IctTrendPullbackContinuationConfig) {
  const higher = aggregateCandles(candles, "15m");
  const fast = emaSeries(higher, config.fastEmaPeriod);
  const slow = emaSeries(higher, config.slowEmaPeriod);
  const result = new Map<number, "bullish" | "bearish" | "neutral">();
  for (let index = 0; index < higher.length; index += 1) {
    let bias: "bullish" | "bearish" | "neutral" = "neutral";
    const slopeIndex = index - config.emaSlopeLookbackBars;
    if (index >= config.slowEmaPeriod - 1 && slopeIndex >= 0) {
      const close = higher[index].close;
      if (fast[index] > slow[index] && close > fast[index] && fast[index] > fast[slopeIndex]) bias = "bullish";
      if (fast[index] < slow[index] && close < fast[index] && fast[index] < fast[slopeIndex]) bias = "bearish";
    }
    result.set(higher[index].time, bias);
  }
  return result;
}

function emaSeries(candles: Candle[], period: number) {
  const multiplier = 2 / (period + 1);
  const values: number[] = [];
  let ema = candles[0]?.close ?? 0;
  for (let index = 0; index < candles.length; index += 1) {
    if (index > 0) ema = (candles[index].close - ema) * multiplier + ema;
    values.push(ema);
  }
  return values;
}
