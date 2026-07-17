import type { Candle } from "../../../types";
import {
  buildMartingaleGridPaperReport,
  countMissingBars,
  loadBinanceMartingaleClosedKlines,
  loadLatestBinanceMartingaleClosedKline,
  MARTINGALE_GRID_FORWARD_START,
  MARTINGALE_GRID_INTERVAL_SECONDS,
  MARTINGALE_GRID_SYMBOLS,
  type MartingaleGridPaperReport,
  type MartingaleGridSymbol,
  writeMartingaleGridReport,
} from "./MartingaleGridPaperEngine";
import { getMartingaleGridReportPath, readMartingaleGridReport } from "./MartingaleGridReportService";

export type MartingaleGridPaperWorkerStatus = {
  enabled: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextCheckAt: string | null;
  consecutiveFailures: number;
  lastError: "source_unavailable" | "data_gap" | "report_write_failed" | "worker_failed" | null;
  lastCompletedCandleAt: Record<MartingaleGridSymbol, string | null>;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type MartingaleGridPaperWorkerOptions = {
  enabled?: boolean;
  pollMs?: number;
  reportPath?: string;
  now?: () => number;
  loadLatestClosedCandle?: (symbol: MartingaleGridSymbol, nowSeconds: number) => Promise<Candle | null>;
  loadCandles?: (symbol: MartingaleGridSymbol, nowSeconds: number) => Promise<Candle[]>;
  buildReport?: (candles: Record<MartingaleGridSymbol, Candle[]>) => MartingaleGridPaperReport;
  writeReport?: (report: MartingaleGridPaperReport) => Promise<void>;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export class MartingaleGridPaperWorker {
  private timer: TimerHandle | null = null;
  private inFlight: Promise<MartingaleGridPaperWorkerStatus> | null = null;
  private readonly enabled: boolean;
  private readonly pollMs: number;
  private readonly reportPath: string;
  private readonly now: () => number;
  private readonly loadLatestClosedCandle: NonNullable<MartingaleGridPaperWorkerOptions["loadLatestClosedCandle"]>;
  private readonly loadCandles: NonNullable<MartingaleGridPaperWorkerOptions["loadCandles"]>;
  private readonly buildReport: NonNullable<MartingaleGridPaperWorkerOptions["buildReport"]>;
  private readonly writeReport: NonNullable<MartingaleGridPaperWorkerOptions["writeReport"]>;
  private readonly setTimer: NonNullable<MartingaleGridPaperWorkerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<MartingaleGridPaperWorkerOptions["clearTimer"]>;
  private readonly lastCompletedSeconds: Record<MartingaleGridSymbol, number | null> = { BTCUSDT: null, ETHUSDT: null };
  private state: MartingaleGridPaperWorkerStatus;

  constructor(options: MartingaleGridPaperWorkerOptions = {}) {
    this.enabled = options.enabled ?? process.env.MARTINGALE_GRID_PAPER_WORKER_ENABLED !== "false";
    this.pollMs = clampPollMs(options.pollMs ?? Number(process.env.MARTINGALE_GRID_PAPER_WORKER_POLL_MS ?? 300_000));
    this.reportPath = options.reportPath ?? getMartingaleGridReportPath();
    this.now = options.now ?? (() => Date.now());
    this.loadLatestClosedCandle = options.loadLatestClosedCandle ?? defaultLoadLatest;
    this.loadCandles = options.loadCandles ?? defaultLoadCandles;
    this.buildReport = options.buildReport ?? ((candles) => buildMartingaleGridPaperReport(candles));
    this.writeReport = options.writeReport ?? ((report) => writeMartingaleGridReport(this.reportPath, report));
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.state = {
      enabled: this.enabled,
      running: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextCheckAt: null,
      consecutiveFailures: 0,
      lastError: null,
      lastCompletedCandleAt: { BTCUSDT: null, ETHUSDT: null },
    };
  }

  start() {
    if (!this.enabled) return;
    void this.checkNow();
    this.scheduleNext();
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.state.nextCheckAt = null;
  }

  checkNow() {
    if (!this.enabled) return Promise.resolve(this.getStatus());
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  getStatus(): MartingaleGridPaperWorkerStatus {
    return { ...this.state, lastCompletedCandleAt: { ...this.state.lastCompletedCandleAt } };
  }

  async getHealth() {
    const report = await readMartingaleGridReport(this.reportPath);
    return { reportReadable: report.ok, status: this.getStatus() };
  }

  private async runOnce() {
    this.state.running = true;
    this.state.lastAttemptAt = new Date(this.now()).toISOString();
    let stage: "latest" | "candles" | "write" = "latest";
    try {
      const nowSeconds = Math.floor(this.now() / 1000);
      const latestEntries = await Promise.all(MARTINGALE_GRID_SYMBOLS.map(async (symbol) => [symbol, await this.loadLatestClosedCandle(symbol, nowSeconds)] as const));
      const latest = Object.fromEntries(latestEntries) as Record<MartingaleGridSymbol, Candle | null>;
      if (MARTINGALE_GRID_SYMBOLS.some((symbol) => !latest[symbol])) throw new Error("source");
      const advanced = MARTINGALE_GRID_SYMBOLS.some((symbol) => this.lastCompletedSeconds[symbol] === null || latest[symbol]!.time > this.lastCompletedSeconds[symbol]!);
      if (!advanced) {
        this.state.lastError = null;
        return this.getStatus();
      }
      stage = "candles";
      const candleEntries = await Promise.all(MARTINGALE_GRID_SYMBOLS.map(async (symbol) => [symbol, await this.loadCandles(symbol, latest[symbol]!.time + MARTINGALE_GRID_INTERVAL_SECONDS)] as const));
      const candles = Object.fromEntries(candleEntries) as Record<MartingaleGridSymbol, Candle[]>;
      for (const symbol of MARTINGALE_GRID_SYMBOLS) {
        if (candles[symbol].length === 0) throw new Error("source");
        if (countMissingBars(candles[symbol]) > 0) throw new Error("gap");
      }
      const report = this.buildReport(candles);
      stage = "write";
      await this.writeReport(report);
      for (const symbol of MARTINGALE_GRID_SYMBOLS) {
        const completed = candles[symbol].at(-1)!.time;
        this.lastCompletedSeconds[symbol] = completed;
        this.state.lastCompletedCandleAt[symbol] = new Date(completed * 1000).toISOString();
      }
      this.state.lastSuccessAt = new Date(this.now()).toISOString();
      this.state.consecutiveFailures = 0;
      this.state.lastError = null;
      console.info(JSON.stringify({
        event: "martingale_grid_paper_worker_success",
        through: report.throughIso,
        completedGroups: report.metrics.completedGroups,
        openGroups: report.openGroups.length,
        automaticOrdersEnabled: false,
      }));
    } catch (error) {
      this.state.consecutiveFailures += 1;
      this.state.lastError = stage === "write" ? "report_write_failed" : error instanceof Error && error.message === "gap" ? "data_gap" : stage === "latest" || stage === "candles" ? "source_unavailable" : "worker_failed";
      console.warn(JSON.stringify({ event: "martingale_grid_paper_worker_failure", code: this.state.lastError, consecutiveFailures: this.state.consecutiveFailures }));
    } finally {
      this.state.running = false;
    }
    return this.getStatus();
  }

  private scheduleNext() {
    if (!this.enabled) return;
    if (this.timer) this.clearTimer(this.timer);
    this.state.nextCheckAt = new Date(this.now() + this.pollMs).toISOString();
    this.timer = this.setTimer(() => void this.checkNow().finally(() => this.scheduleNext()), this.pollMs);
    if (typeof this.timer === "object" && "unref" in this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }
}

async function defaultLoadLatest(symbol: MartingaleGridSymbol, nowSeconds: number) {
  return loadLatestBinanceMartingaleClosedKline({ symbol, now: nowSeconds });
}

async function defaultLoadCandles(symbol: MartingaleGridSymbol, endTime: number) {
  const warmupStart = MARTINGALE_GRID_FORWARD_START - 7 * 24 * 60 * 60;
  return loadBinanceMartingaleClosedKlines({
    symbol,
    startTime: Math.floor(warmupStart / (15 * 60)) * 15 * 60,
    endTime: Math.floor(endTime / MARTINGALE_GRID_INTERVAL_SECONDS) * MARTINGALE_GRID_INTERVAL_SECONDS,
  });
}

function clampPollMs(value: number) {
  if (!Number.isFinite(value)) return 300_000;
  return Math.max(5_000, Math.min(value, 300_000));
}
