import { withProviderReconcileAttempt } from "../cex/ProviderRequestTrace";
import {
  ArbitrageExecutionCommandError,
  type ArbitrageLegExecutionConfirmation,
} from "./ArbitrageExecutionCommandService";

export type OnlineReconcileAttempt = Readonly<{
  attempt: number;
  venue: string;
  substage: string | null;
  result: "SUCCESS" | "FAILED";
  retryDecision: "COMPLETE" | "RETRY" | "STOP";
  delayMs: number;
  category: string | null;
  providerCode: string | null;
}>;

export class OnlineReconcileFinalizationError extends Error {
  constructor(
    readonly cause: unknown,
    readonly attempts: readonly OnlineReconcileAttempt[],
  ) {
    super("Online execution finalization stopped.");
  }
}

export async function finalizeExecutionOnline(input: Readonly<{
  venue: string;
  initial: ArbitrageLegExecutionConfirmation;
  budgetMs: number;
  initialPollMs: number;
  maxPollMs: number;
  maxAttempts: number;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  reconcile: () => Promise<ArbitrageLegExecutionConfirmation>;
  assertIdentity: (confirmation: ArbitrageLegExecutionConfirmation) => void;
  isPendingWithoutFill: (confirmation: ArbitrageLegExecutionConfirmation) => boolean;
}>): Promise<Readonly<{
  confirmation: ArbitrageLegExecutionConfirmation;
  attempts: readonly OnlineReconcileAttempt[];
}>> {
  const deadline = input.now() + input.budgetMs;
  const attempts: OnlineReconcileAttempt[] = [];
  let confirmation = input.initial;
  let pollMs = Math.min(input.initialPollMs, input.maxPollMs);

  for (let attempt = 1; attempt <= input.maxAttempts && input.now() < deadline; attempt += 1) {
    try {
      confirmation = await withProviderReconcileAttempt(attempt, input.reconcile);
      input.assertIdentity(confirmation);
      if (!input.isPendingWithoutFill(confirmation)) {
        attempts.push(attemptAudit(attempt, input.venue, "SUCCESS", "COMPLETE", 0, null));
        return Object.freeze({ confirmation, attempts: Object.freeze(attempts) });
      }
      const delayMs = nextDelay(input.now(), deadline, pollMs, attempt, input.maxAttempts);
      attempts.push(attemptAudit(
        attempt, input.venue, "SUCCESS", delayMs > 0 ? "RETRY" : "STOP", delayMs, null,
      ));
      if (delayMs <= 0) break;
      await input.sleep(delayMs);
      pollMs = Math.min(pollMs * 2, input.maxPollMs);
    } catch (error) {
      const failure = error instanceof ArbitrageExecutionCommandError ? error.reconcileFailure : undefined;
      const delayMs = failure?.retryable === true
        ? nextDelay(input.now(), deadline, pollMs, attempt, input.maxAttempts)
        : 0;
      attempts.push(attemptAudit(
        attempt,
        failure?.venue ?? input.venue,
        "FAILED",
        delayMs > 0 ? "RETRY" : "STOP",
        delayMs,
        failure ?? null,
      ));
      if (delayMs <= 0) {
        throw new OnlineReconcileFinalizationError(error, Object.freeze(attempts));
      }
      await input.sleep(delayMs);
      pollMs = Math.min(pollMs * 2, input.maxPollMs);
    }
  }
  return Object.freeze({ confirmation, attempts: Object.freeze(attempts) });
}

function nextDelay(now: number, deadline: number, pollMs: number, attempt: number, maxAttempts: number) {
  if (attempt >= maxAttempts) return 0;
  const remaining = deadline - now;
  return remaining > 0 ? Math.min(pollMs, remaining) : 0;
}

function attemptAudit(
  attempt: number,
  venue: string,
  result: OnlineReconcileAttempt["result"],
  retryDecision: OnlineReconcileAttempt["retryDecision"],
  delayMs: number,
  failure: NonNullable<ArbitrageExecutionCommandError["reconcileFailure"]> | null,
): OnlineReconcileAttempt {
  return Object.freeze({
    attempt,
    venue,
    substage: failure?.substage ?? null,
    result,
    retryDecision,
    delayMs,
    category: failure?.category ?? null,
    providerCode: failure?.providerCode ?? null,
  });
}
