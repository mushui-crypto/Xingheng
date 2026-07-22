export type FundingClockRuntime = {
  now: () => number;
  isVisible: () => boolean;
  setInterval: (callback: () => void, delayMs: number) => number;
  clearInterval: (timer: number) => void;
};

export function createFundingClock(runtime: FundingClockRuntime) {
  const listeners = new Set<() => void>();
  let currentTime = runtime.now();
  let timer: number | null = null;

  const getSnapshot = () => currentTime;

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (timer === null) {
      currentTime = runtime.now();
      timer = runtime.setInterval(() => {
        if (!runtime.isVisible()) return;
        currentTime = runtime.now();
        listeners.forEach((notify) => notify());
      }, 1_000);
    }

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && timer !== null) {
        runtime.clearInterval(timer);
        timer = null;
      }
    };
  };

  return { getSnapshot, subscribe };
}

export const fundingClock = createFundingClock({
  now: () => Date.now(),
  isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
  clearInterval: (timer) => window.clearInterval(timer),
});
