export const realAccountLoadTimeoutMs = 35_000;

export type RealAccountRequestGenerationEvent =
  | "request_started"
  | "wallet_session_changed"
  | "realtime_recovering";

export function transitionRealAccountRequestGeneration(
  currentGeneration: number,
  event: RealAccountRequestGenerationEvent,
) {
  return event === "realtime_recovering" ? currentGeneration : currentGeneration + 1;
}

export function withRealAccountLoadTimeout<T>(
  request: Promise<T>,
  resourceLabel: string,
  timeoutMs = realAccountLoadTimeoutMs,
) {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error(`${resourceLabel}加载超时，请重试。`));
    }, timeoutMs);

    request.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
