import crypto from "node:crypto";
import type { Candle, CandleInterval } from "../../../types";
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
  type SwingPoint,
} from "../ict/priceAction";
import { classifyMarketRegime } from "../ict/regime";
import { newYorkTime } from "../ict/time";
import {
  resolveEthPointStop,
  selectOrderBlockNearFvg,
  type EthLiquiditySweep,
} from "./EthLiquiditySweepFibFvgObStrategy";

export type EthV4FinalRewardRisk = 1.5 | 2 | 2.5;
export type EthV4ExitMode = "scale_out_1r" | "single_target";
export type EthV4Direction = "bullish" | "bearish" | "neutral";
export type EthV4Session = "london" | "new_york";

export type EthV4TrendSnapshot = {
  direction: EthV4Direction;
  strengthAtr: number;
  close: number;
  ema: number;
  atr: number;
};

export type EthMultiTimeframeSmcIctConfig = {
  routeId: string;
  symbol: "ETHUSDT";
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
  minimumStopPoints: number;
  maximumStopPoints: number;
  setupExpiryBars: number;
  maximumStrongCounterTrendAtr: number;
  finalRewardRisk: EthV4FinalRewardRisk;
  exitMode: EthV4ExitMode;
};

const sharedV4Config: Omit<EthMultiTimeframeSmcIctConfig, "routeId" | "finalRewardRisk" | "exitMode"> = {
  symbol: "ETHUSDT",
  riskFraction: 0.0025,
  atrPeriod: 14,
  trendEmaPeriod: 20,
  swingLeftBars: 2,
  swingRightBars: 2,
  displacementBodyAtr: 0.2,
  minSweepAtr: 0.01,
  maxSweepAtr: 0.75,
  sweepLookbackBars: 12,
  fvgMinAtr: 0.02,
  fvgMaxAtr: 1.25,
  orderBlockLookbackBars: 8,
  orderBlockProximityAtr: 1,
  stopBufferAtr: 0.1,
  minimumStopPoints: 20,
  maximumStopPoints: 40,
  setupExpiryBars: 12,
  maximumStrongCounterTrendAtr: 0.75,
};

export const ethMultiTimeframeSmcIctV4AConfig: EthMultiTimeframeSmcIctConfig = {
  ...sharedV4Config,
  routeId: "ict-eth-mtf-session-sweep-fvg-ob-v4a-2026-07-16",
  finalRewardRisk: 1.5,
  exitMode: "scale_out_1r",
};

export const ethMultiTimeframeSmcIctV4BConfig: EthMultiTimeframeSmcIctConfig = {
  ...sharedV4Config,
  routeId: "ict-eth-mtf-session-sweep-fvg-ob-v4b-2026-07-16",
  finalRewardRisk: 2,
  exitMode: "scale_out_1r",
};

export const ethMultiTimeframeSmcIctV4CConfig: EthMultiTimeframeSmcIctConfig = {
  ...sharedV4Config,
  routeId: "ict-eth-mtf-session-sweep-fvg-ob-v4c-2026-07-16",
  finalRewardRisk: 2.5,
  exitMode: "scale_out_1r",
};

export const ethMultiTimeframeSmcIctV4Configs = [
  ethMultiTimeframeSmcIctV4AConfig,
  ethMultiTimeframeSmcIctV4BConfig,
  ethMultiTimeframeSmcIctV4CConfig,
] as const;

export const ethMultiTimeframeSmcIctV4NormalTpAConfig: EthMultiTimeframeSmcIctConfig = {
  ...sharedV4Config,
  routeId: "ict-eth-mtf-session-sweep-fvg-ob-v4n-a-2026-07-16",
  finalRewardRisk: 1.5,
  exitMode: "single_target",
};

export const ethMultiTimeframeSmcIctV4NormalTpBConfig: EthMultiTimeframeSmcIctConfig = {
  ...sharedV4Config,
  routeId: "ict-eth-mtf-session-sweep-fvg-ob-v4n-b-2026-07-16",
  finalRewardRisk: 2,
  exitMode: "single_target",
};

export const ethMultiTimeframeSmcIctV4NormalTpCConfig: EthMultiTimeframeSmcIctConfig = {
  ...sharedV4Config,
  routeId: "ict-eth-mtf-session-sweep-fvg-ob-v4n-c-2026-07-16",
  finalRewardRisk: 2.5,
  exitMode: "single_target",
};

export const ethMultiTimeframeSmcIctV4NormalTpConfigs = [
  ethMultiTimeframeSmcIctV4NormalTpAConfig,
  ethMultiTimeframeSmcIctV4NormalTpBConfig,
  ethMultiTimeframeSmcIctV4NormalTpCConfig,
] as const;

export class EthMultiTimeframeSmcIctStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars = 1_200;
  private preparedCandles: Candle[] | null = null;
  private lastConfirmedHigh: Array<SwingPoint | null> = [];
  private lastConfirmedLow: Array<SwingPoint | null> = [];
  private fifteenMinuteTrend = new Map<number, EthV4TrendSnapshot>();
  private oneHourTrend = new Map<number, EthV4TrendSnapshot>();
  private fourHourTrend = new Map<number, EthV4TrendSnapshot>();

  constructor(readonly config: EthMultiTimeframeSmcIctConfig = ethMultiTimeframeSmcIctV4AConfig) {
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
    this.fifteenMinuteTrend = buildCompletedTrendSnapshots(candles, "15m", this.config.trendEmaPeriod, this.config.atrPeriod);
    this.oneHourTrend = buildCompletedTrendSnapshots(candles, "1h", this.config.trendEmaPeriod, this.config.atrPeriod);
    this.fourHourTrend = buildCompletedTrendSnapshots(candles, "4h", this.config.trendEmaPeriod, this.config.atrPeriod);
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

    const entryWindow = getEthV4EntryWindow(current.time);
    if (!entryWindow) return null;
    const expiryBars = Math.min(this.config.setupExpiryBars, entryWindow.remainingFutureBars);
    if (expiryBars < 1) return null;

    const trend15m = completedTrendAt(current.time, "15m", this.fifteenMinuteTrend);
    const trend1h = completedTrendAt(current.time, "1h", this.oneHourTrend);
    const trend4h = completedTrendAt(current.time, "4h", this.fourHourTrend);
    const direction = resolveEthV4Direction({
      fifteenMinute: trend15m,
      oneHour: trend1h,
      fourHour: trend4h,
      strongCounterTrendAtr: this.config.maximumStrongCounterTrendAtr,
    });
    if (direction === "neutral") return null;
    const side: StrategySide = direction === "bullish" ? "long" : "short";

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

    const targetPrice = buildEthV4SingleTargetPrice(
      side,
      entryPrice,
      stop.riskDistance,
      this.config.finalRewardRisk,
    );
    const exitPlan = this.config.exitMode === "scale_out_1r"
      ? buildEthV4ExitPlan(side, entryPrice, stop.riskDistance, this.config.finalRewardRisk)
      : undefined;
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
      ...(exitPlan ? { exitPlan } : {}),
      riskFraction: this.config.riskFraction,
      entryOrderType: "limit",
      reasonCodes: [
        "ETH_V4_MTF_DIRECTION",
        "ETH_V4_LIQUIDITY_SWEEP",
        "ETH_V4_MSS_DISPLACEMENT",
        "ETH_V4_FVG_FIB_DISCOUNT_PREMIUM",
        "ETH_V4_ORDER_BLOCK_NEARBY",
        "ETH_V4_20_40_POINT_STRUCTURE_STOP",
        this.config.exitMode === "single_target"
          ? "ETH_V4_SINGLE_TARGET_FINAL_R"
          : "ETH_V4_SCALE_OUT_1R_FINAL_R",
      ],
      evidence: {
        routeId: this.id,
        entrySession: entryWindow.session,
        nyDateKey: entryWindow.dateKey,
        nyWeekday: entryWindow.weekday,
        finalRewardRisk: this.config.finalRewardRisk,
        exitMode: this.config.exitMode,
        trend15m: trend15m.direction,
        trend15mStrengthAtr: trend15m.strengthAtr,
        trend1h: trend1h.direction,
        trend1hStrengthAtr: trend1h.strengthAtr,
        trend4h: trend4h.direction,
        trend4hStrengthAtr: trend4h.strengthAtr,
        sweepIndex: sweep.index,
        sweepTime: candles[sweep.index].time,
        sweptLiquidity: sweep.level.price,
        sweepExtreme: sweep.extreme,
        sweepPenetrationAtr: sweep.penetrationAtr,
        structurePrice: structure.price,
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
        expiryBars,
        regimeKey: regime.key,
        volatilityRegime: regime.volatility,
        volatilityRatio: regime.volatilityRatio,
        structureRegime: regime.structure,
        sessionRegime: regime.session,
        calendarRegime: regime.calendar,
      },
    };
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

export function buildEthV4ExitPlan(
  side: StrategySide,
  entryPrice: number,
  riskDistance: number,
  finalRewardRisk: EthV4FinalRewardRisk,
): StrategyExitPlan {
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
        price: entryPrice + direction * riskDistance * finalRewardRisk,
        quantityFraction: 0.5,
        label: `tp2_${String(finalRewardRisk).replace(".", "_")}r`,
      },
    ],
  };
}

export function buildEthV4SingleTargetPrice(
  side: StrategySide,
  entryPrice: number,
  riskDistance: number,
  finalRewardRisk: EthV4FinalRewardRisk,
) {
  const direction = side === "long" ? 1 : -1;
  return entryPrice + direction * riskDistance * finalRewardRisk;
}

export function getEthV4EntryWindow(timestamp: number): {
  session: EthV4Session;
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

export function resolveEthV4Direction(input: {
  fifteenMinute: EthV4TrendSnapshot;
  oneHour: EthV4TrendSnapshot;
  fourHour: EthV4TrendSnapshot;
  strongCounterTrendAtr: number;
}): EthV4Direction {
  const direction = input.fifteenMinute.direction;
  if (direction === "neutral") return "neutral";
  const higher = [input.oneHour, input.fourHour];
  if (!higher.some((snapshot) => snapshot.direction === direction)) return "neutral";
  const opposite = direction === "bullish" ? "bearish" : "bullish";
  if (higher.some((snapshot) => (
    snapshot.direction === opposite && snapshot.strengthAtr >= input.strongCounterTrendAtr
  ))) return "neutral";
  return direction;
}

export function buildCompletedTrendSnapshots(
  candles: Candle[],
  interval: Extract<CandleInterval, "15m" | "1h" | "4h">,
  emaPeriod = 20,
  atrPeriod = 14,
) {
  const higher = aggregateCandles(candles, interval);
  const result = new Map<number, EthV4TrendSnapshot>();
  if (emaPeriod <= 0 || atrPeriod <= 0 || higher.length === 0) return result;
  const multiplier = 2 / (emaPeriod + 1);
  let ema = higher[0].close;
  for (let index = 0; index < higher.length; index += 1) {
    if (index > 0) ema = (higher[index].close - ema) * multiplier + ema;
    const atr = averageTrueRange(higher, index, atrPeriod);
    const warmed = index >= emaPeriod - 1 && atr !== null && atr > 0;
    const direction: EthV4Direction = !warmed
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

export function completedTrendAt(
  timestamp: number,
  interval: Extract<CandleInterval, "15m" | "1h" | "4h">,
  snapshots: Map<number, EthV4TrendSnapshot>,
): EthV4TrendSnapshot {
  const seconds = intervalDurationMs(interval) / 1_000;
  const currentBucket = Math.floor(timestamp / seconds) * seconds;
  return snapshots.get(currentBucket - seconds) ?? neutralTrendSnapshot();
}

function neutralTrendSnapshot(): EthV4TrendSnapshot {
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
