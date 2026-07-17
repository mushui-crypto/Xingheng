import crypto from "node:crypto";
import type { Candle } from "../../../types";
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
import { newYorkTime } from "../ict/time";
import { selectOrderBlockNearFvg } from "./EthLiquiditySweepFibFvgObStrategy";

export type XauRewardRisk = 1.5 | 2 | 2.5;
export type XauDirection = "bullish" | "bearish" | "neutral";
export type XauSession = "london" | "new_york";

export type XauTrendSnapshot = {
  direction: XauDirection;
  strengthAtr: number;
  close: number;
  ema: number;
  atr: number;
};

export type XauMultiTimeframeSmcIctConfig = {
  routeId: string;
  symbol: "XAUUSD";
  riskFraction: number;
  atrPeriod: number;
  trendEmaPeriod: number;
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
  minimumStopAtr: number;
  maximumStopAtr: number;
  setupExpiryBars: number;
  maximumStrongCounterTrendAtr: number;
  finalRewardRisk: XauRewardRisk;
};

const sharedConfig: Omit<XauMultiTimeframeSmcIctConfig, "routeId" | "finalRewardRisk"> = {
  symbol: "XAUUSD",
  riskFraction: 0.0025,
  atrPeriod: 14,
  trendEmaPeriod: 20,
  swingLeftBars: 2,
  swingRightBars: 2,
  displacementBodyAtr: 0.2,
  minSweepAtr: 0.01,
  maxSweepAtr: 0.8,
  sweepLookbackBars: 12,
  fvgMinAtr: 0.02,
  fvgMaxAtr: 1.25,
  orderBlockLookbackBars: 8,
  orderBlockProximityAtr: 1,
  stopBufferAtr: 0.1,
  minimumStopAtr: 0.35,
  maximumStopAtr: 1.75,
  setupExpiryBars: 12,
  maximumStrongCounterTrendAtr: 0.75,
};

export const xauMultiTimeframeSmcIctConfigs: readonly XauMultiTimeframeSmcIctConfig[] = [
  { ...sharedConfig, routeId: "ict-xau-mtf-session-sweep-fvg-ob-q1-1p5r-2026-07-16", finalRewardRisk: 1.5 },
  { ...sharedConfig, routeId: "ict-xau-mtf-session-sweep-fvg-ob-q1-2r-2026-07-16", finalRewardRisk: 2 },
  { ...sharedConfig, routeId: "ict-xau-mtf-session-sweep-fvg-ob-q1-2p5r-2026-07-16", finalRewardRisk: 2.5 },
];

type LiquiditySweep = {
  index: number;
  level: SwingPoint;
  extreme: number;
  penetrationAtr: number;
};

export class XauMultiTimeframeSmcIctStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars = 1_200;
  private preparedCandles: Candle[] | null = null;
  private lastConfirmedHigh: Array<SwingPoint | null> = [];
  private lastConfirmedLow: Array<SwingPoint | null> = [];
  private fifteenMinuteTrend = new Map<number, XauTrendSnapshot>();
  private oneHourTrend = new Map<number, XauTrendSnapshot>();
  private fourHourTrend = new Map<number, XauTrendSnapshot>();

  constructor(readonly config: XauMultiTimeframeSmcIctConfig = xauMultiTimeframeSmcIctConfigs[0]) {
    this.id = config.routeId;
  }

  prepare(candles: Candle[]) {
    if (this.preparedCandles === candles) return;
    this.preparedCandles = candles;
    const swings = confirmedSwings(candles, candles.length - 1, this.config.swingLeftBars, this.config.swingRightBars);
    this.lastConfirmedHigh = buildLastConfirmedSwing(candles.length, swings, "high");
    this.lastConfirmedLow = buildLastConfirmedSwing(candles.length, swings, "low");
    this.fifteenMinuteTrend = buildCompletedTrendSnapshots(candles, 15 * 60, this.config.trendEmaPeriod, this.config.atrPeriod);
    this.oneHourTrend = buildCompletedTrendSnapshots(candles, 60 * 60, this.config.trendEmaPeriod, this.config.atrPeriod);
    this.fourHourTrend = buildCompletedTrendSnapshots(candles, 4 * 60 * 60, this.config.trendEmaPeriod, this.config.atrPeriod);
  }

  release() {
    this.preparedCandles = null;
    this.lastConfirmedHigh = [];
    this.lastConfirmedLow = [];
    this.fifteenMinuteTrend.clear();
    this.oneHourTrend.clear();
    this.fourHourTrend.clear();
  }

  evaluate({ candles, index }: StrategyEvaluationContext): StrategySignal | null {
    if (this.preparedCandles !== candles) this.prepare(candles);
    if (index < this.warmupBars || candles[index]?.symbol !== this.config.symbol) return null;
    const current = candles[index];
    const previous = candles[index - 1];
    if (!previous) return null;

    const entryWindow = getXauEntryWindow(current.time);
    if (!entryWindow) return null;
    const expiryBars = Math.min(this.config.setupExpiryBars, entryWindow.remainingFutureBars);
    if (expiryBars < 1) return null;

    const trend15m = completedTrendAt(current.time, 15 * 60, this.fifteenMinuteTrend);
    const trend1h = completedTrendAt(current.time, 60 * 60, this.oneHourTrend);
    const trend4h = completedTrendAt(current.time, 4 * 60 * 60, this.fourHourTrend);
    const direction = resolveDirection(trend15m, trend1h, trend4h, this.config.maximumStrongCounterTrendAtr);
    if (direction === "neutral") return null;
    const side: StrategySide = direction === "bullish" ? "long" : "short";

    const atr = averageTrueRange(candles, index, this.config.atrPeriod);
    if (!atr || atr <= 0) return null;
    const sweep = this.findSweep(candles, index, side, atr);
    if (!sweep) return null;

    const structure = side === "long" ? this.lastConfirmedHigh[index - 1] : this.lastConfirmedLow[index - 1];
    if (!structure) return null;
    const firstMssBreak = side === "long"
      ? previous.close <= structure.price && current.close > structure.price
      : previous.close >= structure.price && current.close < structure.price;
    if (!firstMssBreak) return null;
    if (!isDisplacement(current, atr, side === "long" ? "bullish" : "bearish", this.config.displacementBodyAtr)) return null;

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
    const stop = resolveAtrStop({
      side,
      entryPrice,
      structuralStopPrice,
      atr,
      minimumStopAtr: this.config.minimumStopAtr,
      maximumStopAtr: this.config.maximumStopAtr,
    });
    if (!stop) return null;

    const directionFactor = side === "long" ? 1 : -1;
    const targetPrice = entryPrice + directionFactor * stop.riskDistance * this.config.finalRewardRisk;
    const regime = classifyMarketRegime(candles, index);
    const expiresAt = current.time + expiryBars * 300;
    const signalId = crypto.createHash("sha256")
      .update(`${this.id}:${current.time}:${side}:${entryPrice}:${stop.stopPrice}:${targetPrice}`)
      .digest("hex")
      .slice(0, 24);

    return {
      id: signalId,
      strategyId: this.id,
      symbol: current.symbol,
      interval: "5m",
      createdAt: current.time,
      expiresAt,
      side,
      entryPrice,
      stopPrice: stop.stopPrice,
      targetPrice,
      riskFraction: this.config.riskFraction,
      entryOrderType: "limit",
      reasonCodes: [
        "XAU_Q1_MTF_DIRECTION",
        "XAU_Q1_LIQUIDITY_SWEEP",
        "XAU_Q1_MSS_DISPLACEMENT",
        "XAU_Q1_FVG_FIB_DISCOUNT_PREMIUM",
        "XAU_Q1_ORDER_BLOCK_NEARBY",
        "XAU_Q1_ATR_NORMALIZED_STRUCTURE_STOP",
        "XAU_Q1_SINGLE_TARGET_FINAL_R",
      ],
      evidence: {
        routeId: this.id,
        entrySession: entryWindow.session,
        nyDateKey: entryWindow.dateKey,
        nyWeekday: entryWindow.weekday,
        finalRewardRisk: this.config.finalRewardRisk,
        trend15m: trend15m.direction,
        trend1h: trend1h.direction,
        trend4h: trend4h.direction,
        sweepIndex: sweep.index,
        sweptLiquidity: sweep.level.price,
        sweepExtreme: sweep.extreme,
        sweepPenetrationAtr: sweep.penetrationAtr,
        structurePrice: structure.price,
        equilibriumPrice,
        fvgLower: fvg.lower,
        fvgUpper: fvg.upper,
        fvgMidpoint: fvg.midpoint,
        fvgSizeAtr,
        orderBlockIndex: orderBlock.index,
        orderBlockLow: orderBlock.low,
        orderBlockHigh: orderBlock.high,
        structuralStopPrice,
        structuralStopDistance: stop.structuralRiskDistance,
        stopDistance: stop.riskDistance,
        stopDistanceAtr: stop.riskDistance / atr,
        stopExpandedToMinimum: stop.expandedToMinimum,
        expiryBars,
        regimeKey: regime.key,
      },
    };
  }

  private findSweep(candles: Candle[], index: number, side: StrategySide, atr: number): LiquiditySweep | null {
    const earliest = Math.max(0, index - this.config.sweepLookbackBars);
    for (let candleIndex = index - 1; candleIndex >= earliest; candleIndex -= 1) {
      const level = side === "long" ? this.lastConfirmedLow[candleIndex - 1] : this.lastConfirmedHigh[candleIndex - 1];
      if (!level) continue;
      const candle = candles[candleIndex];
      const penetration = side === "long" ? level.price - candle.low : candle.high - level.price;
      const reclaimed = side === "long" ? candle.close > level.price : candle.close < level.price;
      const penetrationAtr = penetration / atr;
      if (reclaimed && penetrationAtr >= this.config.minSweepAtr && penetrationAtr <= this.config.maxSweepAtr) {
        return { index: candleIndex, level, extreme: side === "long" ? candle.low : candle.high, penetrationAtr };
      }
    }
    return null;
  }
}

export function getXauEntryWindow(timestamp: number): {
  session: XauSession;
  dateKey: string;
  weekday: string;
  remainingFutureBars: number;
} | null {
  const local = newYorkTime(timestamp);
  if (local.isWeekend) return null;
  const session = local.minuteOfDay >= 2 * 60 && local.minuteOfDay < 5 * 60
    ? { name: "london" as const, endMinute: 5 * 60 }
    : local.minuteOfDay >= 7 * 60 && local.minuteOfDay < 11 * 60
      ? { name: "new_york" as const, endMinute: 11 * 60 }
      : null;
  if (!session) return null;
  return {
    session: session.name,
    dateKey: local.dateKey,
    weekday: local.weekday,
    remainingFutureBars: Math.floor((session.endMinute - local.minuteOfDay - 1) / 5),
  };
}

export function resolveAtrStop(input: {
  side: StrategySide;
  entryPrice: number;
  structuralStopPrice: number;
  atr: number;
  minimumStopAtr: number;
  maximumStopAtr: number;
}) {
  const structuralRiskDistance = input.side === "long"
    ? input.entryPrice - input.structuralStopPrice
    : input.structuralStopPrice - input.entryPrice;
  if (!(structuralRiskDistance > 0) || !(input.atr > 0)) return null;
  const maximumDistance = input.atr * input.maximumStopAtr;
  if (structuralRiskDistance > maximumDistance) return null;
  const minimumDistance = input.atr * input.minimumStopAtr;
  const riskDistance = Math.max(structuralRiskDistance, minimumDistance);
  return {
    structuralRiskDistance,
    riskDistance,
    stopPrice: input.side === "long" ? input.entryPrice - riskDistance : input.entryPrice + riskDistance,
    expandedToMinimum: structuralRiskDistance < minimumDistance,
  };
}

function resolveDirection(
  fifteenMinute: XauTrendSnapshot,
  oneHour: XauTrendSnapshot,
  fourHour: XauTrendSnapshot,
  maximumStrongCounterTrendAtr: number,
): XauDirection {
  const direction = fifteenMinute.direction;
  if (direction === "neutral") return "neutral";
  const higher = [oneHour, fourHour];
  if (!higher.some((snapshot) => snapshot.direction === direction)) return "neutral";
  const opposite = direction === "bullish" ? "bearish" : "bullish";
  if (higher.some((snapshot) => snapshot.direction === opposite && snapshot.strengthAtr >= maximumStrongCounterTrendAtr)) {
    return "neutral";
  }
  return direction;
}

function buildCompletedTrendSnapshots(candles: Candle[], intervalSeconds: number, emaPeriod: number, atrPeriod: number) {
  const interval = intervalSeconds === 15 * 60 ? "15m" : intervalSeconds === 60 * 60 ? "1h" : "4h";
  const higher = aggregateCandles(candles, interval);
  const result = new Map<number, XauTrendSnapshot>();
  if (higher.length === 0) return result;
  const multiplier = 2 / (emaPeriod + 1);
  let ema = higher[0].close;
  for (let index = 0; index < higher.length; index += 1) {
    if (index > 0) ema = (higher[index].close - ema) * multiplier + ema;
    const atr = averageTrueRange(higher, index, atrPeriod);
    const warmed = index >= emaPeriod - 1 && atr !== null && atr > 0;
    const direction: XauDirection = !warmed
      ? "neutral"
      : higher[index].close > ema
        ? "bullish"
        : higher[index].close < ema
          ? "bearish"
          : "neutral";
    result.set(higher[index].time, {
      direction,
      strengthAtr: warmed ? Math.abs(higher[index].close - ema) / atr! : 0,
      close: higher[index].close,
      ema,
      atr: atr ?? 0,
    });
  }
  return result;
}

function completedTrendAt(timestamp: number, intervalSeconds: number, snapshots: Map<number, XauTrendSnapshot>) {
  const currentBucket = Math.floor(timestamp / intervalSeconds) * intervalSeconds;
  return snapshots.get(currentBucket - intervalSeconds) ?? neutralTrendSnapshot();
}

function neutralTrendSnapshot(): XauTrendSnapshot {
  return { direction: "neutral", strengthAtr: 0, close: 0, ema: 0, atr: 0 };
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
