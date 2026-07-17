import crypto from "node:crypto";
import type { Strategy, StrategyEvaluationContext } from "../core/types";
import { isWithinTimeZoneSession, timeInZone } from "../ict/time";

export type FixedPointExecutionConfig = {
  stopPoints: number;
  targetPoints: number;
  sessionTimeZone: string;
  sessionStartMinute: number;
  sessionEndMinute: number;
  excludeWeekends: boolean;
};

export class FixedPointExecutionStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars: number;

  constructor(
    private readonly base: Strategy,
    readonly config: FixedPointExecutionConfig,
  ) {
    this.id = `${base.id}-fixed-${config.stopPoints}-${config.targetPoints}`;
    this.warmupBars = base.warmupBars;
  }

  prepare(candles: Parameters<NonNullable<Strategy["prepare"]>>[0]) {
    this.base.prepare?.(candles);
  }

  release() {
    this.base.release?.();
  }

  evaluate(context: StrategyEvaluationContext) {
    const candle = context.candles[context.index];
    if (!candle || !isWithinTimeZoneSession(
      candle.time,
      this.config.sessionTimeZone,
      this.config.sessionStartMinute,
      this.config.sessionEndMinute,
    )) return null;
    if (this.config.excludeWeekends && timeInZone(candle.time, this.config.sessionTimeZone).isWeekend) return null;
    const baseSignal = this.base.evaluate(context);
    if (!baseSignal) return null;
    const entryReference = candle.close;
    const stopPrice = baseSignal.side === "long"
      ? entryReference - this.config.stopPoints
      : entryReference + this.config.stopPoints;
    const targetPrice = baseSignal.side === "long"
      ? entryReference + this.config.targetPoints
      : entryReference - this.config.targetPoints;
    if (stopPrice <= 0 || targetPrice <= 0) return null;
    return {
      ...baseSignal,
      id: crypto.createHash("sha256")
        .update(`${this.id}:${baseSignal.id}:${candle.time}`)
        .digest("hex")
        .slice(0, 24),
      strategyId: this.id,
      entryPrice: entryReference,
      stopPrice,
      targetPrice,
      maxHoldingSeconds: undefined,
      reasonCodes: [...baseSignal.reasonCodes, "USER_FIXED_40_100_EXECUTION"],
      evidence: {
        ...baseSignal.evidence,
        executionModel: "user_fixed_points",
        stopPoints: this.config.stopPoints,
        targetPoints: this.config.targetPoints,
        grossRewardRisk: this.config.targetPoints / this.config.stopPoints,
        entryReference,
        stopDistanceFraction: this.config.stopPoints / entryReference,
      },
    };
  }
}
