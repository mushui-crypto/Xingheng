import type { Candle } from "../../../types";
import {
  atomicWriteJson,
  buildRouteBForwardReport,
  countMissingBars,
  loadLatestBinanceFuturesClosedKline,
  loadBinanceFuturesClosedKlines,
  ROUTE_B_FORWARD_START,
  ROUTE_B_INTERVAL_SECONDS,
  type RouteBForwardReport,
} from "./RouteBPaperEngine";
import { getForwardReportPath, readForwardReport, type ForwardReportResponse } from "./ForwardReportService";

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

export type ForwardPaperWorkerAlertCode = "consecutive_failures" | "no_first_success" | "closed_candle_stale" | "report_unreadable";

export type ForwardPaperWorkerHealth = {
  status: ForwardPaperWorkerStatus;
  freshness: {
    status: "disabled" | "ok" | "warming_up" | "stale" | "failing" | "report_unreadable";
    closedCandleStaleSeconds: number | null;
    reportReadable: boolean;
  };
  alerts: Array<{
    code: ForwardPaperWorkerAlertCode;
    title: string;
    message: string;
  }>;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type ForwardPaperWorkerOptions = {
  enabled?: boolean;
  pollMs?: number;
  reportPath?: string;
  now?: () => number;
  loadLatestClosedCandle?: (nowSeconds: number) => Promise<Candle | null>;
  loadCandles?: (nowSeconds: number) => Promise<Candle[]>;
  writeReport?: (report: unknown) => Promise<void>;
  notifier?: {
    evaluate(input: { health: ForwardPaperWorkerHealth; report: ForwardReportResponse | null }): Promise<void>;
    sendDailySummary(input: { health: ForwardPaperWorkerHealth; report: ForwardReportResponse | null }): Promise<void>;
  };
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  firstSuccessGraceMs?: number;
  staleAfterMs?: number;
};

export class ForwardPaperWorker {
  private timer: TimerHandle | null = null;
  private inFlight: Promise<ForwardPaperWorkerStatus> | null = null;
  private readonly enabled: boolean;
  private readonly pollMs: number;
  private readonly reportPath: string;
  private readonly now: () => number;
  private readonly loadLatestClosedCandle: (nowSeconds: number) => Promise<Candle | null>;
  private readonly loadCandles: (nowSeconds: number) => Promise<Candle[]>;
  private readonly writeReport: (report: unknown) => Promise<void>;
  private readonly notifier?: ForwardPaperWorkerOptions["notifier"];
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly firstSuccessGraceMs: number;
  private readonly staleAfterMs: number;
  private startedAt: number;
  private lastDailySummaryDate: string | null = null;
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
    this.pollMs = clampPollMs(options.pollMs ?? Number(process.env.STRATEGY_FORWARD_WORKER_POLL_MS ?? 300_000));
    this.reportPath = options.reportPath ?? getForwardReportPath();
    this.now = options.now ?? (() => Date.now());
    this.loadLatestClosedCandle = options.loadLatestClosedCandle ?? defaultLoadLatestClosedCandle;
    this.loadCandles = options.loadCandles ?? defaultLoadCandles;
    this.writeReport = options.writeReport ?? ((report) => atomicWriteJson(this.reportPath, report));
    this.notifier = options.notifier;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.firstSuccessGraceMs = options.firstSuccessGraceMs ?? 15 * 60 * 1000;
    this.staleAfterMs = options.staleAfterMs ?? 15 * 60 * 1000;
    this.startedAt = this.now();
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

  async getHealth(reportReadable?: boolean): Promise<ForwardPaperWorkerHealth> {
    const readable = reportReadable ?? (await readForwardReport(this.reportPath, { includeLegacyFallback: false })).ok;
    return this.makeHealth(readable);
  }

  private async runOnce() {
    this.state.running = true;
    this.state.lastAttemptAt = new Date(this.now()).toISOString();
    let latestReport: ForwardReportResponse | null = null;
    let reportReadable = false;
    try {
      const nowSeconds = Math.floor(this.now() / 1000);
      const latest = await this.loadLatestClosedCandle(nowSeconds);
      if (!latest) throw new Error("Binance forward source returned no latest closed candle.");
      if (this.lastCompletedCandleSeconds !== null && latest.time <= this.lastCompletedCandleSeconds) {
        this.state.lastError = null;
        return this.getStatus();
      }
      const candles = await this.loadCandles(latest.time + ROUTE_B_INTERVAL_SECONDS);
      if (candles.length === 0) throw new Error("Binance forward source returned no closed candles.");
      const missingBarCount = countMissingBars(candles);
      if (missingBarCount > 0) throw new Error(`Binance forward source contains ${missingBarCount} missing 5m bars.`);
      const completedCandle = candles.at(-1)!.time;
      const report = buildRouteBForwardReport(candles, { now: nowSeconds });
      await this.writeReport(report);
      latestReport = reportToForwardResponse(report);
      reportReadable = true;
      this.lastCompletedCandleSeconds = completedCandle;
      this.state.lastCompletedCandleAt = new Date(completedCandle * 1000).toISOString();
      this.state.lastSuccessAt = new Date(this.now()).toISOString();
      this.state.consecutiveFailures = 0;
      this.state.lastError = null;
      console.info(JSON.stringify({
        event: "strategy_forward_worker_success",
        completedCandleAt: this.state.lastCompletedCandleAt,
        candleCount: report.dataQuality.candleCount,
        missingBarCount: report.dataQuality.missingBarCount,
        tradeCount: report.metrics.tradeCount,
        openPosition: Boolean(report.openPosition),
        observationGateReached: report.observationGate.reached,
        automaticOrdersEnabled: report.assumptions.automaticOrdersEnabled,
      }));
    } catch (error) {
      this.state.consecutiveFailures += 1;
      this.state.lastError = sanitizeWorkerError(error);
      console.warn(JSON.stringify({
        event: "strategy_forward_worker_failure",
        error: this.state.lastError,
        consecutiveFailures: this.state.consecutiveFailures,
      }));
    } finally {
      this.state.running = false;
      const readResult = await readForwardReport(this.reportPath, { includeLegacyFallback: false }).catch(() => null);
      if (readResult?.ok) latestReport = latestReport ?? readResult.report;
      reportReadable = reportReadable || Boolean(readResult?.ok);
      await this.notify(latestReport, reportReadable);
    }
    return this.getStatus();
  }

  private async notify(report: ForwardReportResponse | null, reportReadable: boolean) {
    if (!this.notifier) return;
    const health = this.makeHealth(reportReadable);
    await this.notifier.evaluate({ health, report });
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (this.lastDailySummaryDate !== today && report) {
      this.lastDailySummaryDate = today;
      console.info(JSON.stringify({
        event: "strategy_forward_daily_summary",
        completedCandleAt: health.status.lastCompletedCandleAt,
        missingBarCount: report.dataQuality.missingBarCount,
        tradeCount: report.metrics.tradeCount,
        openPosition: Boolean(report.openPosition),
        observationGateReached: report.observationGate.reached,
        automaticOrdersEnabled: report.assumptions.automaticOrdersEnabled,
      }));
      await this.notifier.sendDailySummary({ health, report });
    }
  }

  private makeHealth(reportReadable: boolean): ForwardPaperWorkerHealth {
    const status = this.getStatus();
    const now = this.now();
    const lastSuccess = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : null;
    const lastCompleted = status.lastCompletedCandleAt ? Date.parse(status.lastCompletedCandleAt) : null;
    const closedCandleStaleSeconds = lastCompleted ? Math.max(0, Math.floor((now - lastCompleted) / 1000)) : null;
    const alerts: ForwardPaperWorkerHealth["alerts"] = [];
    if (!status.enabled) {
      return { status, freshness: { status: "disabled", closedCandleStaleSeconds, reportReadable }, alerts };
    }
    if (status.consecutiveFailures >= 3) {
      alerts.push({ code: "consecutive_failures", title: "策略 Paper Worker 连续失败", message: `连续失败 ${status.consecutiveFailures} 次。` });
    }
    if (!lastSuccess && now - this.startedAt >= this.firstSuccessGraceMs) {
      alerts.push({ code: "no_first_success", title: "策略 Paper Worker 尚无首次成功", message: "启用后超过宽限期仍没有成功生成前向报告。" });
    }
    if (closedCandleStaleSeconds !== null && closedCandleStaleSeconds > this.staleAfterMs / 1000) {
      alerts.push({ code: "closed_candle_stale", title: "策略 Paper 数据未推进", message: `最近完成K线已超过 ${Math.floor(closedCandleStaleSeconds / 60)} 分钟未推进。` });
    }
    if (!reportReadable) {
      alerts.push({ code: "report_unreadable", title: "策略 Paper 报告不可读", message: "前向报告不存在或无法解析。" });
    }
    const freshness = !reportReadable
      ? "report_unreadable"
      : status.consecutiveFailures >= 3
        ? "failing"
        : closedCandleStaleSeconds !== null && closedCandleStaleSeconds > this.staleAfterMs / 1000
          ? "stale"
          : lastSuccess
            ? "ok"
            : "warming_up";
    return { status, freshness: { status: freshness, closedCandleStaleSeconds, reportReadable }, alerts };
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

async function defaultLoadLatestClosedCandle(nowSeconds: number) {
  return loadLatestBinanceFuturesClosedKline({ now: nowSeconds });
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
    .replace(/file:\/\/[^\s'")\]}<>]+/g, "[path]")
    .replace(/(['"])(?:[A-Za-z]:\\|\/|\.{1,2}\/|~\/)[^'"]+\1/g, "$1[path]$1")
    .replace(/(^|[\s([{,:>])([A-Za-z]:\\[^\s'")\]}<>]+)/g, "$1[path]")
    .replace(/(^|[\s([{,:>])((?:\/|\.{1,2}\/|~\/)[^\s'")\]}<>]+)/g, "$1[path]")
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]")
    .slice(0, 240);
}

function reportToForwardResponse(report: RouteBForwardReport): ForwardReportResponse {
  return {
    routeId: report.routeId,
    status: report.status,
    forwardStart: report.forwardStartIso,
    through: report.throughIso,
    elapsedDays: report.elapsedDays,
    observationGate: report.observationGate,
    assumptions: report.assumptions,
    dataQuality: {
      source: report.dataQuality.source,
      interval: "5m",
      candleCount: report.dataQuality.candleCount,
      missingBarCount: report.dataQuality.missingBarCount,
      updatedAt: report.dataQuality.updatedAt ?? report.throughIso,
    },
    metrics: report.metrics,
    diagnostics: {
      signals: report.diagnostics.signals,
      filled: report.diagnostics.filledOrders,
      expired: report.diagnostics.expiredOrders,
      costRejected: report.diagnostics.costRejectedOrders,
      byRegime: report.diagnostics.byRegime,
    },
    openPosition: null,
    recentCompletedTrades: [],
    warnings: [],
  };
}
