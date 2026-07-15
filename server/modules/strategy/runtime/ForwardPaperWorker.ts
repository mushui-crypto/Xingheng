import type { Candle } from "../../../types";
import {
  atomicWriteJson,
  buildRouteBForwardReport,
  countMissingBars,
  loadBinanceFuturesClosedKlines,
  ROUTE_B_FORWARD_START,
  ROUTE_B_INTERVAL_SECONDS,
} from "./RouteBPaperEngine";
import { getForwardReportPath } from "./ForwardReportService";

export type ForwardPaperWorkerStatus = {
  enabled: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCompletedCandleAt: string | null;
  nextCheckAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type ForwardPaperWorkerOptions = {
  enabled?: boolean;
  pollMs?: number;
  reportPath?: string;
  now?: () => number;
  loadCandles?: (nowSeconds: number) => Promise<Candle[]>;
  writeReport?: (report: unknown) => Promise<void>;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export class ForwardPaperWorker {
  private timer: TimerHandle | null = null;
  private inFlight: Promise<ForwardPaperWorkerStatus> | null = null;
  private readonly enabled: boolean;
  private readonly pollMs: number;
  private readonly reportPath: string;
  private readonly now: () => number;
  private readonly loadCandles: (nowSeconds: number) => Promise<Candle[]>;
  private readonly writeReport: (report: unknown) => Promise<void>;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private state: ForwardPaperWorkerStatus = {
    enabled: true,
    running: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastCompletedCandleAt: null,
    nextCheckAt: null,
    consecutiveFailures: 0,
    lastError: null,
  };
  private lastCompletedCandleSeconds: number | null = null;

  constructor(options: ForwardPaperWorkerOptions = {}) {
    this.enabled = options.enabled ?? process.env.STRATEGY_FORWARD_WORKER_ENABLED !== "false";
    this.pollMs = clampPollMs(options.pollMs ?? Number(process.env.STRATEGY_FORWARD_WORKER_POLL_MS ?? 30_000));
    this.reportPath = options.reportPath ?? getForwardReportPath();
    this.now = options.now ?? (() => Date.now());
    this.loadCandles = options.loadCandles ?? defaultLoadCandles;
    this.writeReport = options.writeReport ?? ((report) => atomicWriteJson(this.reportPath, report));
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.state.enabled = this.enabled;
  }

  start() {
    if (!this.enabled) return;
    void this.checkNow();
    this.scheduleNext();
  }

  stop() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.state.nextCheckAt = null;
  }

  checkNow() {
    if (!this.enabled) return Promise.resolve(this.getStatus());
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  getStatus(): ForwardPaperWorkerStatus {
    return { ...this.state };
  }

  private async runOnce() {
    this.state.running = true;
    this.state.lastAttemptAt = new Date(this.now()).toISOString();
    try {
      const nowSeconds = Math.floor(this.now() / 1000);
      const candles = await this.loadCandles(nowSeconds);
      if (candles.length === 0) throw new Error("Binance forward source returned no closed candles.");
      const missingBarCount = countMissingBars(candles);
      if (missingBarCount > 0) throw new Error(`Binance forward source contains ${missingBarCount} missing 5m bars.`);
      const completedCandle = candles.at(-1)!.time;
      if (this.lastCompletedCandleSeconds !== null && completedCandle <= this.lastCompletedCandleSeconds) {
        this.state.lastError = null;
        return this.getStatus();
      }
      const report = buildRouteBForwardReport(candles, { now: nowSeconds });
      await this.writeReport(report);
      this.lastCompletedCandleSeconds = completedCandle;
      this.state.lastCompletedCandleAt = new Date(completedCandle * 1000).toISOString();
      this.state.lastSuccessAt = new Date(this.now()).toISOString();
      this.state.consecutiveFailures = 0;
      this.state.lastError = null;
    } catch (error) {
      this.state.consecutiveFailures += 1;
      this.state.lastError = sanitizeWorkerError(error);
      console.warn("[strategy] forward paper worker check failed", this.state.lastError);
    } finally {
      this.state.running = false;
    }
    return this.getStatus();
  }

  private scheduleNext() {
    if (!this.enabled) return;
    if (this.timer) this.clearTimer(this.timer);
    this.state.nextCheckAt = new Date(this.now() + this.pollMs).toISOString();
    this.timer = this.setTimer(() => {
      void this.checkNow().finally(() => this.scheduleNext());
    }, this.pollMs);
    if (typeof this.timer === "object" && "unref" in this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }
}

async function defaultLoadCandles(nowSeconds: number) {
  const startTime = ROUTE_B_FORWARD_START - 7 * 24 * 60 * 60;
  const endTime = Math.floor(nowSeconds / ROUTE_B_INTERVAL_SECONDS) * ROUTE_B_INTERVAL_SECONDS;
  return loadBinanceFuturesClosedKlines({ startTime, endTime });
}

function clampPollMs(value: number) {
  if (!Number.isFinite(value)) return 30_000;
  return Math.max(5_000, Math.min(value, 5 * 60_000));
}

function sanitizeWorkerError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]")
    .slice(0, 240);
}
