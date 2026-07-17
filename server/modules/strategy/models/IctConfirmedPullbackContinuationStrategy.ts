import crypto from "node:crypto";
import type { Candle } from "../../../types";
import { intervalDurationMs } from "../../market/marketConfig";
import type { Strategy, StrategyEvaluationContext, StrategySignal, StrategySide } from "../core/types";
import { averageTrueRange } from "../ict/priceAction";
import {
  IctTrendPullbackContinuationStrategy,
  ictRouteATrendPullbackV1Config,
  type IctTrendPullbackContinuationConfig,
} from "./IctTrendPullbackContinuationStrategy";

export type IctConfirmedPullbackContinuationConfig = IctTrendPullbackContinuationConfig & {
  confirmationBodyAtr: number;
  confirmationCloseLocation: number;
  confirmedStopBufferAtr: number;
  confirmedMinStopAtr: number;
  confirmedMaxStopAtr: number;
};

export const ictRouteAConfirmedPullbackV2Config = Object.freeze({
  ...ictRouteATrendPullbackV1Config,
  routeId: "ict-route-a-confirmed-pullback-v2-2026-07-17",
  confirmationBodyAtr: 0.2,
  confirmationCloseLocation: 0.6,
  confirmedStopBufferAtr: 0.15,
  confirmedMinStopAtr: 0.35,
  confirmedMaxStopAtr: 2,
} satisfies IctConfirmedPullbackContinuationConfig);

type ActiveSetup = {
  source: StrategySignal;
  midpoint: number;
  originalInvalidation: number;
  touchedAt: number | null;
  pullbackExtreme: number | null;
};

/**
 * Converts the rejected V7 blind FVG limit into a two-stage setup:
 * first observe the midpoint touch, then require a closed 5m rejection/MSS
 * candle before emitting a next-bar market signal.
 */
export class IctConfirmedPullbackContinuationStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars: number;
  private active: ActiveSetup | null = null;

  constructor(
    readonly config: IctConfirmedPullbackContinuationConfig = ictRouteAConfirmedPullbackV2Config,
    private readonly setupSource: Strategy = new IctTrendPullbackContinuationStrategy(config),
  ) {
    this.id = config.routeId;
    this.warmupBars = setupSource.warmupBars;
  }

  prepare(candles: Candle[]) {
    this.active = null;
    this.setupSource.prepare?.(candles);
  }

  release() {
    this.active = null;
    this.setupSource.release?.();
  }

  evaluate(context: StrategyEvaluationContext): StrategySignal | null {
    const { candles, index } = context;
    const current = candles[index];
    if (!current || index < this.warmupBars || current.symbol !== this.config.symbol) return null;

    const fresh = this.setupSource.evaluate(context);
    if (fresh) {
      this.active = {
        source: fresh,
        midpoint: fresh.entryPrice,
        originalInvalidation: fresh.stopPrice,
        touchedAt: null,
        pullbackExtreme: null,
      };
      return null;
    }

    const active = this.active;
    if (!active || current.time <= active.source.createdAt) return null;
    if (current.time > active.source.expiresAt || invalidates(current, active.source.side, active.originalInvalidation)) {
      this.active = null;
      return null;
    }

    if (touchesMidpoint(current, active.source.side, active.midpoint)) {
      active.touchedAt ??= current.time;
      active.pullbackExtreme = updateExtreme(active.pullbackExtreme, current, active.source.side);
    } else if (active.touchedAt !== null) {
      active.pullbackExtreme = updateExtreme(active.pullbackExtreme, current, active.source.side);
    }
    if (active.touchedAt === null || active.pullbackExtreme === null || index < 1) return null;

    const atr = averageTrueRange(candles, index, this.config.atrPeriod);
    if (!atr || atr <= 0 || !confirms(candles[index - 1], current, active.source.side, atr, this.config)) return null;

    const stopPrice = active.source.side === "long"
      ? active.pullbackExtreme - atr * this.config.confirmedStopBufferAtr
      : active.pullbackExtreme + atr * this.config.confirmedStopBufferAtr;
    const referenceEntry = current.close;
    const stopDistanceAtr = Math.abs(referenceEntry - stopPrice) / atr;
    if (
      (active.source.side === "long" ? stopPrice >= referenceEntry : stopPrice <= referenceEntry) ||
      stopDistanceAtr < this.config.confirmedMinStopAtr ||
      stopDistanceAtr > this.config.confirmedMaxStopAtr
    ) {
      this.active = null;
      return null;
    }

    const side = active.source.side;
    const targetPrice = side === "long"
      ? referenceEntry + Math.abs(referenceEntry - stopPrice) * this.config.rewardRisk
      : referenceEntry - Math.abs(referenceEntry - stopPrice) * this.config.rewardRisk;
    const signal: StrategySignal = {
      id: crypto.createHash("sha256")
        .update(`${this.id}:${current.symbol}:${current.time}:${side}`)
        .digest("hex")
        .slice(0, 24),
      strategyId: this.id,
      symbol: current.symbol,
      interval: current.interval,
      createdAt: current.time,
      expiresAt: current.time + intervalDurationMs(current.interval) / 1000,
      side,
      entryPrice: referenceEntry,
      stopPrice,
      targetPrice,
      targetRewardRisk: this.config.rewardRisk,
      riskFraction: this.config.riskFraction,
      entryOrderType: "market",
      reasonCodes: ["HTF_EMA_TREND", "DISPLACEMENT_FVG", "FVG_MIDPOINT_TOUCH", "5M_REJECTION_MSS"],
      evidence: {
        routeId: this.id,
        setupCreatedAt: active.source.createdAt,
        midpointTouchedAt: active.touchedAt,
        fvgMidpoint: active.midpoint,
        originalInvalidation: active.originalInvalidation,
        pullbackExtreme: active.pullbackExtreme,
        atr,
        stopDistanceAtr,
        confirmationBodyAtr: Math.abs(current.close - current.open) / atr,
        confirmationCloseLocation: closeLocation(current),
        regimeKey: String(active.source.evidence.regimeKey ?? "confirmed_pullback"),
      },
    };
    this.active = null;
    return signal;
  }
}

function invalidates(candle: Candle, side: StrategySide, stopPrice: number) {
  return side === "long" ? candle.low <= stopPrice : candle.high >= stopPrice;
}

function touchesMidpoint(candle: Candle, side: StrategySide, midpoint: number) {
  return side === "long" ? candle.low <= midpoint : candle.high >= midpoint;
}

function updateExtreme(previous: number | null, candle: Candle, side: StrategySide) {
  if (side === "long") return previous === null ? candle.low : Math.min(previous, candle.low);
  return previous === null ? candle.high : Math.max(previous, candle.high);
}

function confirms(
  previous: Candle,
  current: Candle,
  side: StrategySide,
  atr: number,
  config: Pick<IctConfirmedPullbackContinuationConfig, "confirmationBodyAtr" | "confirmationCloseLocation">,
) {
  const bodyAtr = Math.abs(current.close - current.open) / atr;
  const location = closeLocation(current);
  if (bodyAtr < config.confirmationBodyAtr) return false;
  return side === "long"
    ? current.close > current.open && current.close > previous.high && location >= config.confirmationCloseLocation
    : current.close < current.open && current.close < previous.low && location <= 1 - config.confirmationCloseLocation;
}

function closeLocation(candle: Candle) {
  const range = candle.high - candle.low;
  return range > 0 ? (candle.close - candle.low) / range : 0.5;
}
