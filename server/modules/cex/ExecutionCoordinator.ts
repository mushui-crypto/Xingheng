import { createExecutionIntent, type ExecutionIntent } from "./ExecutionIntent";
import {
  createExecutionState,
  transitionExecutionState,
  type ExecutionState,
  type ExecutionStatus,
} from "./ExecutionState";
import type { ExecutionCapability } from "./ExecutionCapability";

export type ExecutionStep<TResult> = Readonly<{
  stepId: "execution-capability";
  status: "SUCCEEDED" | "CALL_FAILED" | "SKIPPED_EXPIRED";
  result: TResult | null;
}>;

export type CoordinatedExecutionResult<TResult> = Readonly<{
  intentId: string;
  arbitrageId?: string;
  legId?: string;
  userId: string;
  venue: ExecutionIntent["venue"];
  accountId: string;
  status: "SUCCEEDED" | "CALL_FAILED" | "REMOTE_FAILED" | "REMOTE_UNKNOWN" | "EXPIRED";
  executionState: ExecutionState;
  step: ExecutionStep<TResult>;
}>;

export class ExecutionCoordinator<TResult> {
  constructor(
    private readonly capability: ExecutionCapability<TResult>,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(input: ExecutionIntent): Promise<CoordinatedExecutionResult<TResult>> {
    const intent = createExecutionIntent(input);
    let executionState = createExecutionState(intent);
    const startedAt = this.now();
    if (startedAt >= intent.expiresAt) {
      return result(intent, "EXPIRED", executionState, {
        stepId: "execution-capability",
        status: "SKIPPED_EXPIRED",
        result: null,
      });
    }

    executionState = transitionExecutionState(executionState, {
      type: "SUBMISSION_STARTED",
      occurredAt: startedAt,
    });
    try {
      const capabilityResult = await this.capability.execute(intent);
      const outcome = capabilityOutcome(capabilityResult);
      executionState = transitionExecutionState(executionState, {
        type: outcome.eventType,
        occurredAt: this.nowAtOrAfter(executionState.updatedAt),
      });
      return result(intent, outcome.status, executionState, {
        stepId: "execution-capability",
        status: "SUCCEEDED",
        result: capabilityResult,
      });
    } catch {
      executionState = transitionExecutionState(executionState, {
        type: "REMOTE_UNKNOWN",
        occurredAt: this.nowAtOrAfter(executionState.updatedAt),
      });
      return result(intent, "CALL_FAILED", executionState, {
        stepId: "execution-capability",
        status: "CALL_FAILED",
        result: null,
      });
    }
  }

  private now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("ExecutionCoordinator clock must return a non-negative integer timestamp.");
    }
    return value;
  }

  private nowAtOrAfter(timestamp: number) {
    return Math.max(timestamp, this.now());
  }
}

function capabilityOutcome(value: unknown): Readonly<{
  eventType: "SUBMISSION_ACCEPTED" | "REMOTE_CONFIRMED" | "REMOTE_FAILED" | "REMOTE_UNKNOWN";
  status: CoordinatedExecutionResult<unknown>["status"];
}> {
  const state = capabilityState(value);
  if (state === "CONFIRMED") return Object.freeze({ eventType: "REMOTE_CONFIRMED", status: "SUCCEEDED" });
  if (state === "FAILED") return Object.freeze({ eventType: "REMOTE_FAILED", status: "REMOTE_FAILED" });
  if (state === "UNKNOWN") return Object.freeze({ eventType: "REMOTE_UNKNOWN", status: "REMOTE_UNKNOWN" });
  return Object.freeze({ eventType: "SUBMISSION_ACCEPTED", status: "SUCCEEDED" });
}

function capabilityState(value: unknown): ExecutionStatus | null {
  if (!value || typeof value !== "object" || !("state" in value)) return null;
  const state = (value as { state?: unknown }).state;
  if (
    state === "CREATED"
    || state === "SUBMITTED"
    || state === "PENDING_CONFIRMATION"
    || state === "CONFIRMED"
    || state === "FAILED"
    || state === "UNKNOWN"
  ) {
    return state;
  }
  return null;
}

function result<TResult>(
  intent: ExecutionIntent,
  status: CoordinatedExecutionResult<TResult>["status"],
  executionState: ExecutionState,
  step: ExecutionStep<TResult>,
): CoordinatedExecutionResult<TResult> {
  return Object.freeze({
    intentId: intent.intentId,
    ...(intent.arbitrageId === undefined
      ? {}
      : { arbitrageId: intent.arbitrageId, legId: intent.legId }),
    userId: intent.userId,
    venue: intent.venue,
    accountId: intent.accountId,
    status,
    executionState,
    step: Object.freeze(step),
  });
}
