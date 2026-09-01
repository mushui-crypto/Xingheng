export const ARBITRAGE_DASHBOARD_REFRESH_INTERVAL_MS = 25_000;

export type VisibilityPollingRuntime = {
  isVisible: () => boolean;
  setInterval: (callback: () => void, intervalMs: number) => number;
  clearInterval: (timer: number) => void;
  addVisibilityChangeListener: (listener: () => void) => void;
  removeVisibilityChangeListener: (listener: () => void) => void;
};

const browserVisibilityPollingRuntime: VisibilityPollingRuntime = {
  isVisible: () => document.visibilityState === "visible",
  setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
  clearInterval: (timer) => window.clearInterval(timer),
  addVisibilityChangeListener: (listener) => document.addEventListener("visibilitychange", listener),
  removeVisibilityChangeListener: (listener) => document.removeEventListener("visibilitychange", listener),
};

export function startVisibilityAwarePolling(
  refresh: () => void,
  intervalMs: number,
  runtime: VisibilityPollingRuntime = browserVisibilityPollingRuntime,
): () => void {
  let timer: number | undefined;

  const stopTimer = () => {
    if (timer === undefined) return;
    runtime.clearInterval(timer);
    timer = undefined;
  };

  const startTimer = () => {
    stopTimer();
    if (!runtime.isVisible()) return;
    timer = runtime.setInterval(refresh, intervalMs);
  };

  const handleVisibilityChange = () => {
    stopTimer();
    if (!runtime.isVisible()) return;
    refresh();
    startTimer();
  };

  runtime.addVisibilityChangeListener(handleVisibilityChange);
  startTimer();

  return () => {
    stopTimer();
    runtime.removeVisibilityChangeListener(handleVisibilityChange);
  };
}
