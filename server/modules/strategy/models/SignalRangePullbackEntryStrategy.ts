import crypto from "node:crypto";
import type { Strategy, StrategyEvaluationContext } from "../core/types";

export type SignalRangeEntryMode =
  | { kind: "next_bar_market" }
  | { kind: "signal_range_pullback"; fraction: 0.25 | 0.5; expiryBars: 3 | 6 };

export class SignalRangePullbackEntryStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars: number;

  constructor(
    private readonly base: Strategy,
    readonly mode: SignalRangeEntryMode,
  ) {
    this.id = `${base.id}-${modeId(mode)}`;
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
    if (!candle) return null;
    const signal = this.base.evaluate(context);
    if (!signal) return null;
    const baseRisk = Math.abs(signal.entryPrice - signal.stopPrice);
    const rewardRisk = signal.targetRewardRisk ?? (
      baseRisk > 0 ? Math.abs(signal.targetPrice - signal.entryPrice) / baseRisk : Number.NaN
    );
    if (!Number.isFinite(rewardRisk) || rewardRisk <= 0) return null;

    let entryPrice = signal.entryPrice;
    let entryOrderType: "market" | "limit" = "market";
    let expiresAt = signal.createdAt + 300;
    if (this.mode.kind === "signal_range_pullback") {
      const adverseRange = signal.side === "long"
        ? candle.close - candle.low
        : candle.high - candle.close;
      if (!Number.isFinite(adverseRange) || adverseRange <= 0) return null;
      entryPrice = signal.side === "long"
        ? candle.close - adverseRange * this.mode.fraction
        : candle.close + adverseRange * this.mode.fraction;
      entryOrderType = "limit";
      expiresAt = signal.createdAt + this.mode.expiryBars * 300;
    }
    if (
      entryPrice <= 0 ||
      (signal.side === "long" ? entryPrice <= signal.stopPrice : entryPrice >= signal.stopPrice)
    ) return null;
    const distance = Math.abs(entryPrice - signal.stopPrice);
    const targetPrice = signal.side === "long"
      ? entryPrice + distance * rewardRisk
      : entryPrice - distance * rewardRisk;
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) return null;

    return {
      ...signal,
      id: crypto.createHash("sha256")
        .update(`${this.id}:${signal.id}:${signal.createdAt}`)
        .digest("hex")
        .slice(0, 24),
      strategyId: this.id,
      entryPrice,
      entryOrderType,
      expiresAt,
      targetPrice,
      targetRewardRisk: rewardRisk,
      reasonCodes: [...signal.reasonCodes, "SIGNAL_RANGE_ENTRY_EXECUTION", modeId(this.mode).toUpperCase()],
      evidence: {
        ...signal.evidence,
        entryExecution: modeId(this.mode),
        entryReferenceClose: candle.close,
        entryRewardRisk: rewardRisk,
        ...(this.mode.kind === "signal_range_pullback" ? {
          entryPullbackFraction: this.mode.fraction,
          entryExpiryBars: this.mode.expiryBars,
        } : {}),
      },
    };
  }
}

export function modeId(mode: SignalRangeEntryMode) {
  return mode.kind === "next_bar_market"
    ? "next-bar-market"
    : `pullback-${Math.round(mode.fraction * 100)}-expiry-${mode.expiryBars}`;
}
