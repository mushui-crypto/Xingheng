import crypto from "node:crypto";
import type { Strategy, StrategyEvaluationContext } from "../core/types";

export class RewardRiskBreakEvenStrategy implements Strategy {
  readonly id: string;
  readonly warmupBars: number;

  constructor(
    private readonly base: Strategy,
    readonly activationRewardRisk: number,
  ) {
    if (!Number.isFinite(activationRewardRisk) || activationRewardRisk <= 0) {
      throw new Error("Break-even activation reward-risk must be positive.");
    }
    this.id = `${base.id}-break-even-${activationRewardRisk}r`;
    this.warmupBars = base.warmupBars;
  }

  prepare(candles: Parameters<NonNullable<Strategy["prepare"]>>[0]) {
    this.base.prepare?.(candles);
  }

  release() {
    this.base.release?.();
  }

  evaluate(context: StrategyEvaluationContext) {
    const signal = this.base.evaluate(context);
    if (!signal) return null;
    return {
      ...signal,
      id: crypto.createHash("sha256")
        .update(`${this.id}:${signal.id}:${signal.createdAt}`)
        .digest("hex")
        .slice(0, 24),
      strategyId: this.id,
      moveStopToBreakEvenAtRewardRisk: this.activationRewardRisk,
      reasonCodes: [...signal.reasonCodes, "MOVE_STOP_TO_ACTUAL_ENTRY_AFTER_REWARD_RISK"],
      evidence: {
        ...signal.evidence,
        breakEvenActivationRewardRisk: this.activationRewardRisk,
      },
    };
  }
}
