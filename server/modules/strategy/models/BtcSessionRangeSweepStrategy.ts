import crypto from "node:crypto";
import type { Candle } from "../../../types";
import type { Strategy, StrategyEvaluationContext, StrategySignal, StrategySide } from "../core/types";
import { averageTrueRange } from "../ict/priceAction";
import { timeInZone } from "../ict/time";

export type BtcSessionRangeSweepConfig = {
  routeId: string;
  symbol: string;
  riskFraction: number;
  atrPeriod: number;
  referenceStartMinute: number;
  referenceEndMinute: number;
  tradeStartMinute: number;
  tradeEndMinute: number;
  timeZone: string;
  minimumSweepAtr: number;
  maximumSweepAtr: number;
  minimumBodyAtr: number;
  closeLocationThreshold: number;
  stopBufferAtr: number;
  minimumStopAtr: number;
  maximumStopAtr: number;
  rewardRisk: number;
};

export const btcSessionRangeSweepV1Config = Object.freeze({
  routeId: "ict-btc-session-range-sweep-reclaim-v1-2026-07-17",
  symbol: "BTCUSDT",
  riskFraction: 0.0025,
  atrPeriod: 14,
  referenceStartMinute: 8 * 60,
  referenceEndMinute: 18 * 60,
  tradeStartMinute: 18 * 60,
  tradeEndMinute: 8 * 60,
  timeZone: "Asia/Shanghai",
  minimumSweepAtr: 0.05,
  maximumSweepAtr: 0.75,
  minimumBodyAtr: 0.2,
  closeLocationThreshold: 0.6,
  stopBufferAtr: 0.1,
  minimumStopAtr: 0.25,
  maximumStopAtr: 1.5,
  rewardRisk: 2,
} satisfies BtcSessionRangeSweepConfig);

type ReferenceRange = { high: number; low: number; count: number };

export class BtcSessionRangeSweepStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars: number;
  private ranges = new Map<string, ReferenceRange>();
  private emitted = new Set<string>();

  constructor(readonly config: BtcSessionRangeSweepConfig = btcSessionRangeSweepV1Config) {
    this.id = config.routeId;
    this.warmupBars = config.atrPeriod;
  }

  prepare(candles: Candle[]) {
    this.ranges.clear();
    this.emitted.clear();
    for (const candle of candles) {
      if (candle.symbol !== this.config.symbol) continue;
      const local = timeInZone(candle.time, this.config.timeZone);
      if (local.minuteOfDay < this.config.referenceStartMinute || local.minuteOfDay >= this.config.referenceEndMinute) continue;
      const range = this.ranges.get(local.dateKey) ?? { high: Number.NEGATIVE_INFINITY, low: Number.POSITIVE_INFINITY, count: 0 };
      range.high = Math.max(range.high, candle.high);
      range.low = Math.min(range.low, candle.low);
      range.count += 1;
      this.ranges.set(local.dateKey, range);
    }
  }

  release() {
    this.ranges.clear();
    this.emitted.clear();
  }

  evaluate({ candles, index }: StrategyEvaluationContext): StrategySignal | null {
    if (index < this.warmupBars) return null;
    const current = candles[index];
    if (!current || current.symbol !== this.config.symbol) return null;
    const local = timeInZone(current.time, this.config.timeZone);
    if (local.isWeekend || !isCrossMidnightSession(local.minuteOfDay, this.config.tradeStartMinute, this.config.tradeEndMinute)) return null;
    const referenceDate = local.minuteOfDay >= this.config.tradeStartMinute ? local.dateKey : previousDateKey(local.dateKey);
    const range = this.ranges.get(referenceDate);
    const requiredReferenceBars = (this.config.referenceEndMinute - this.config.referenceStartMinute) / 5;
    if (!range || range.count < requiredReferenceBars) return null;

    const atr = averageTrueRange(candles, index, this.config.atrPeriod);
    if (!atr || atr <= 0) return null;
    const longPenetration = range.low - current.low;
    const shortPenetration = current.high - range.high;
    const longSweep = longPenetration >= atr * this.config.minimumSweepAtr &&
      longPenetration <= atr * this.config.maximumSweepAtr && current.close > range.low;
    const shortSweep = shortPenetration >= atr * this.config.minimumSweepAtr &&
      shortPenetration <= atr * this.config.maximumSweepAtr && current.close < range.high;
    if (longSweep === shortSweep) return null;

    const side: StrategySide = longSweep ? "long" : "short";
    const rangeSize = current.high - current.low;
    const body = Math.abs(current.close - current.open);
    const closeLocation = rangeSize > 0 ? (current.close - current.low) / rangeSize : 0.5;
    const confirms = side === "long"
      ? current.close > current.open && body >= atr * this.config.minimumBodyAtr && closeLocation >= this.config.closeLocationThreshold
      : current.close < current.open && body >= atr * this.config.minimumBodyAtr && closeLocation <= 1 - this.config.closeLocationThreshold;
    if (!confirms) return null;
    const emissionKey = `${referenceDate}:${side}`;
    if (this.emitted.has(emissionKey)) return null;

    const stopPrice = side === "long"
      ? current.low - atr * this.config.stopBufferAtr
      : current.high + atr * this.config.stopBufferAtr;
    const riskDistance = Math.abs(current.close - stopPrice);
    const riskAtr = riskDistance / atr;
    if (riskAtr < this.config.minimumStopAtr || riskAtr > this.config.maximumStopAtr) return null;
    const targetPrice = side === "long"
      ? current.close + riskDistance * this.config.rewardRisk
      : current.close - riskDistance * this.config.rewardRisk;
    if (targetPrice <= 0) return null;

    this.emitted.add(emissionKey);
    return this.signal(current, side, stopPrice, targetPrice, atr, range, referenceDate, riskAtr, closeLocation);
  }

  private signal(
    candle: Candle,
    side: StrategySide,
    stopPrice: number,
    targetPrice: number,
    atr: number,
    range: ReferenceRange,
    referenceDate: string,
    stopDistanceAtr: number,
    closeLocation: number,
  ): StrategySignal {
    return {
      id: crypto.createHash("sha256").update(`${this.id}:${candle.symbol}:${candle.time}:${side}`).digest("hex").slice(0, 24),
      strategyId: this.id,
      symbol: candle.symbol,
      interval: candle.interval,
      createdAt: candle.time,
      expiresAt: candle.time + 300,
      side,
      entryPrice: candle.close,
      stopPrice,
      targetPrice,
      targetRewardRisk: this.config.rewardRisk,
      riskFraction: this.config.riskFraction,
      entryOrderType: "market",
      reasonCodes: ["ASIA_DAY_RANGE", "LIQUIDITY_SWEEP", "RANGE_RECLAIM", "5M_REJECTION"],
      evidence: {
        routeId: this.id,
        referenceDate,
        referenceHigh: range.high,
        referenceLow: range.low,
        referenceBars: range.count,
        atr,
        stopDistanceAtr,
        closeLocation,
        regimeKey: `session_range_sweep:${side}`,
      },
    };
  }
}

function isCrossMidnightSession(minute: number, start: number, end: number) {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function previousDateKey(dateKey: string) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
