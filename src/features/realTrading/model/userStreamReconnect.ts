export type UserStreamReconnectDecision = {
  delayMs: number;
  exhausted: boolean;
  nextAttempt: number;
};

export function decideUserStreamReconnect(
  currentAttempt: number,
  maxAttempts: number,
): UserStreamReconnectDecision {
  const attempt = Number.isSafeInteger(currentAttempt) && currentAttempt >= 0 ? currentAttempt : 0;
  const maximum = Number.isSafeInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;
  if (attempt >= maximum) return { delayMs: 0, exhausted: true, nextAttempt: attempt };
  return {
    delayMs: Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)),
    exhausted: false,
    nextAttempt: attempt + 1,
  };
}
