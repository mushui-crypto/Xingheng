import path from "node:path";
import type { Candle } from "../../../types";
import { BinanceVisionHistoricalDataSource, dayRange } from "../backtest/BinanceVisionHistoricalDataSource";
import {
  buildFixedGridPaperReport,
  FIXED_GRID_FORWARD_START,
  loadFixedGridClosedKlines,
  loadLatestFixedGridClosedKline,
  type FixedGridPaperReport,
  writeFixedGridReport,
} from "./FixedGridPaperEngine";
import { MARTINGALE_GRID_INTERVAL_SECONDS, MARTINGALE_GRID_SYMBOLS, type MartingaleGridSymbol } from "./MartingaleGridPaperEngine";
import { getFixedGridReportPath, readFixedGridReport } from "./FixedGridReportService";

export type FixedGridPaperWorkerStatus = {
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
export type FixedGridPaperWorkerOptions = {
  enabled?: boolean;
  pollMs?: number;
  reportPath?: string;
  now?: () => number;
  loadLatestClosedCandle?: (symbol: MartingaleGridSymbol, nowSeconds: number) => Promise<Candle | null>;
  loadCandles?: (symbol: MartingaleGridSymbol, nowSeconds: number) => Promise<Candle[]>;
  loadLatestArchiveCandle?: (symbol: MartingaleGridSymbol, nowSeconds: number) => Promise<Candle | null>;
  loadArchiveCandles?: (symbol: MartingaleGridSymbol, throughSeconds: number) => Promise<Candle[]>;
  buildReport?: (
    candles: Record<MartingaleGridSymbol, Candle[]>,
    source: FixedGridPaperReport["dataQuality"]["source"],
  ) => FixedGridPaperReport;
  writeReport?: (report: FixedGridPaperReport) => Promise<void>;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export class FixedGridPaperWorker {
  private timer: TimerHandle | null = null;
  private inFlight: Promise<FixedGridPaperWorkerStatus> | null = null;
  private readonly enabled: boolean;
  private readonly pollMs: number;
  private readonly reportPath: string;
  private readonly now: () => number;
  private readonly loadLatestClosedCandle: NonNullable<FixedGridPaperWorkerOptions["loadLatestClosedCandle"]>;
  private readonly loadCandles: NonNullable<FixedGridPaperWorkerOptions["loadCandles"]>;
  private readonly loadLatestArchiveCandle: NonNullable<FixedGridPaperWorkerOptions["loadLatestArchiveCandle"]>;
  private readonly loadArchiveCandles: NonNullable<FixedGridPaperWorkerOptions["loadArchiveCandles"]>;
  private readonly buildReport: NonNullable<FixedGridPaperWorkerOptions["buildReport"]>;
  private readonly writeReport: NonNullable<FixedGridPaperWorkerOptions["writeReport"]>;
  private readonly setTimer: NonNullable<FixedGridPaperWorkerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<FixedGridPaperWorkerOptions["clearTimer"]>;
  private readonly lastCompletedSeconds: Record<MartingaleGridSymbol, number | null> = { BTCUSDT: null, ETHUSDT: null };
  private state: FixedGridPaperWorkerStatus;

  constructor(options: FixedGridPaperWorkerOptions = {}) {
    this.enabled = options.enabled ?? process.env.FIXED_GRID_PAPER_WORKER_ENABLED !== "false";
    this.pollMs = clampPollMs(options.pollMs ?? Number(process.env.FIXED_GRID_PAPER_WORKER_POLL_MS ?? 300_000));
    this.reportPath = options.reportPath ?? getFixedGridReportPath();
    this.now = options.now ?? (() => Date.now());
    this.loadLatestClosedCandle = options.loadLatestClosedCandle ?? ((symbol, now) => loadLatestFixedGridClosedKline({ symbol, now }));
    this.loadCandles = options.loadCandles ?? defaultLoadCandles;
    this.loadLatestArchiveCandle = options.loadLatestArchiveCandle ?? defaultLoadLatestArchiveCandle;
    this.loadArchiveCandles = options.loadArchiveCandles ?? defaultLoadArchiveCandles;
    this.buildReport = options.buildReport ?? ((candles, source) => buildFixedGridPaperReport(candles, { source }));
    this.writeReport = options.writeReport ?? ((report) => writeFixedGridReport(this.reportPath, report));
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

  start() { if (this.enabled) { void this.checkNow(); this.scheduleNext(); } }
  stop() { if (this.timer) this.clearTimer(this.timer); this.timer = null; this.state.nextCheckAt = null; }
  checkNow() { if (!this.enabled) return Promise.resolve(this.getStatus()); if (this.inFlight) return this.inFlight; this.inFlight = this.runOnce().finally(() => { this.inFlight = null; }); return this.inFlight; }
  getStatus(): FixedGridPaperWorkerStatus { return { ...this.state, lastCompletedCandleAt: { ...this.state.lastCompletedCandleAt } }; }
  async getHealth() { const report = await readFixedGridReport(this.reportPath); return { reportReadable: report.ok, status: this.getStatus() }; }

  private async runOnce() {
    this.state.running = true;
    this.state.lastAttemptAt = new Date(this.now()).toISOString();
    let stage: "latest" | "candles" | "write" = "latest";
    try {
      const nowSeconds = Math.floor(this.now() / 1000);
      let source: FixedGridPaperReport["dataQuality"]["source"] = "binance_futures_public_rest";
      let latest: Record<MartingaleGridSymbol, Candle | null>;
      try {
        latest = Object.fromEntries(await Promise.all(MARTINGALE_GRID_SYMBOLS.map(async (symbol) => [symbol, await this.loadLatestClosedCandle(symbol, nowSeconds)] as const))) as Record<MartingaleGridSymbol, Candle | null>;
        if (MARTINGALE_GRID_SYMBOLS.some((symbol) => !latest[symbol])) throw new Error("source");
      } catch {
        source = "binance_vision_usdm_archive";
        latest = Object.fromEntries(await Promise.all(MARTINGALE_GRID_SYMBOLS.map(async (symbol) => [symbol, await this.loadLatestArchiveCandle(symbol, nowSeconds)] as const))) as Record<MartingaleGridSymbol, Candle | null>;
        if (MARTINGALE_GRID_SYMBOLS.some((symbol) => !latest[symbol])) throw new Error("source");
      }
      const advanced = MARTINGALE_GRID_SYMBOLS.some((symbol) => this.lastCompletedSeconds[symbol] === null || latest[symbol]!.time > this.lastCompletedSeconds[symbol]!);
      if (!advanced) { this.state.lastError = null; return this.getStatus(); }
      stage = "candles";
      const candles = Object.fromEntries(await Promise.all(MARTINGALE_GRID_SYMBOLS.map(async (symbol) => [
        symbol,
        source === "binance_vision_usdm_archive"
          ? await this.loadArchiveCandles(symbol, latest[symbol]!.time)
          : await this.loadCandles(symbol, latest[symbol]!.time + MARTINGALE_GRID_INTERVAL_SECONDS),
      ] as const))) as Record<MartingaleGridSymbol, Candle[]>;
      for (const symbol of MARTINGALE_GRID_SYMBOLS) {
        if (!candles[symbol].length) throw new Error("source");
        if (missingBars(candles[symbol]) > 0) throw new Error("gap");
      }
      const report = this.buildReport(candles, source);
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
      console.info(JSON.stringify({ event: "fixed_grid_paper_worker_success", source, through: report.throughIso, completedGroups: report.metrics.completedGroups, workingPlans: report.workingPlans.length, openGroups: report.openGroups.length, automaticOrdersEnabled: false }));
    } catch (error) {
      this.state.consecutiveFailures += 1;
      this.state.lastError = stage === "write" ? "report_write_failed" : error instanceof Error && error.message === "gap" ? "data_gap" : stage === "latest" || stage === "candles" ? "source_unavailable" : "worker_failed";
      console.warn(JSON.stringify({ event: "fixed_grid_paper_worker_failure", code: this.state.lastError, consecutiveFailures: this.state.consecutiveFailures }));
    } finally { this.state.running = false; }
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

async function defaultLoadCandles(symbol: MartingaleGridSymbol, endTime: number) {
  const warmupStart = FIXED_GRID_FORWARD_START - 30 * 24 * 3600;
  return loadFixedGridClosedKlines({ symbol, startTime: Math.floor(warmupStart / (4 * 3600)) * 4 * 3600, endTime: Math.floor(endTime / 300) * 300 });
}
const archiveSource = new BinanceVisionHistoricalDataSource(
  undefined,
  path.resolve(process.env.FIXED_GRID_ARCHIVE_CACHE_PATH ?? "server/data/strategy/fixed-grid-archive-cache"),
);
async function defaultLoadLatestArchiveCandle(symbol: MartingaleGridSymbol, nowSeconds: number) {
  for (let lagDays = 1; lagDays <= 7; lagDays += 1) {
    const date = new Date((nowSeconds - lagDays * 86_400) * 1000).toISOString().slice(0, 10);
    try {
      return (await archiveSource.loadDay({ symbol, date })).candles.at(-1) ?? null;
    } catch {
      // Binance Vision daily archives are published with a delay; try the prior day.
    }
  }
  return null;
}
async function defaultLoadArchiveCandles(symbol: MartingaleGridSymbol, throughSeconds: number) {
  const start = new Date((FIXED_GRID_FORWARD_START - 30 * 86_400) * 1000).toISOString().slice(0, 10);
  const end = new Date(throughSeconds * 1000).toISOString().slice(0, 10);
  return (await archiveSource.loadDays(dayRange(start, end, symbol))).candles.filter((candle) => candle.time <= throughSeconds);
}
function missingBars(candles: Candle[]) { let missing = 0; for (let index = 1; index < candles.length; index += 1) { const delta = candles[index].time - candles[index - 1].time; if (delta > 300) missing += Math.floor(delta / 300) - 1; } return missing; }
function clampPollMs(value: number) { return Number.isFinite(value) ? Math.max(5_000, Math.min(value, 300_000)) : 300_000; }
