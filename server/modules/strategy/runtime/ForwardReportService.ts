import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { ForwardPaperWorkerStatus } from "./ForwardPaperWorker";

const defaultReportPath = path.resolve("server/data/strategy/research-ict-route-b-forward.json");
const legacyReportPath = path.resolve("research-ict-route-b-forward.json");

export type ForwardReportStatus = "collecting" | "observation_gate_reached_pending_review" | "unavailable";

export type ForwardReportResponse = {
  routeId: string;
  status: ForwardReportStatus;
  forwardStart: string | null;
  through: string | null;
  elapsedDays: number;
  observationGate: {
    minimumDays: number;
    minimumCompletedTrades: number;
    mode: "either";
    reached: boolean;
  };
  assumptions: {
    venue: "binance_usdm_btcusdt_perpetual";
    symbol: "BTCUSDT";
    leverageSelection: 100;
    marginMode: "cross";
    marginFraction: number;
    effectiveNotionalEquityMultiple: 2;
    onePositionAtATime: true;
    fundingIgnored: true;
    markPriceAndDynamicBracketIgnored: true;
    automaticOrdersEnabled: false;
  };
  dataQuality: {
    source: string;
    interval: "5m";
    candleCount: number;
    missingBarCount: number;
    updatedAt: string | null;
  };
  metrics: {
    tradeCount: number;
    netPnl: number;
    profitFactor: number | null;
    averageR: number;
    maxDrawdownFraction: number;
    initialEquity: number;
    finalEquity: number;
    fees: number;
  };
  diagnostics: {
    signals: number;
    filled: number;
    expired: number;
    costRejected: number;
    byRegime: Record<string, unknown>;
  };
  openPosition: PublicForwardTrade | null;
  recentCompletedTrades: PublicForwardTrade[];
  worker?: ForwardPaperWorkerStatus;
  warnings: string[];
};

export type PublicForwardTrade = {
  side: "long" | "short" | null;
  signalTime: string | null;
  entryTime: string | null;
  exitTime: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  quantity: number | null;
  netPnl: number | null;
  rMultiple: number | null;
  fees: number | null;
  exitReason: string | null;
};

export type ForwardReportReadResult =
  | { ok: true; report: ForwardReportResponse }
  | { ok: false; statusCode: 200 | 503; report: ForwardReportResponse };

export function getForwardReportPath() {
  return path.resolve(process.env.STRATEGY_FORWARD_REPORT_PATH ?? defaultReportPath);
}

export async function readForwardReport(
  reportPath = getForwardReportPath(),
  options: { includeLegacyFallback?: boolean } = {},
): Promise<ForwardReportReadResult> {
  const resolvedPath = await resolveReadableReportPath(reportPath, options.includeLegacyFallback ?? true);
  if (!resolvedPath) {
    return {
      ok: false,
      statusCode: 200,
      report: makeUnavailableReport("no_report"),
    };
  }
  try {
    const raw = await readFile(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return { ok: true, report: normalizeForwardReport(parsed) };
  } catch {
    return {
      ok: false,
      statusCode: 503,
      report: makeUnavailableReport("report_unreadable"),
    };
  }
}

async function resolveReadableReportPath(primaryPath: string, includeLegacyFallback: boolean) {
  for (const candidate of includeLegacyFallback ? [primaryPath, legacyReportPath] : [primaryPath]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function normalizeForwardReport(value: unknown): ForwardReportResponse {
  const report = isRecord(value) ? value : {};
  const observationGate = isRecord(report.observationGate) ? report.observationGate : {};
  const assumptions = isRecord(report.assumptions) ? report.assumptions : {};
  const dataQuality = isRecord(report.dataQuality) ? report.dataQuality : {};
  const metrics = isRecord(report.metrics) ? report.metrics : {};
  const diagnostics = isRecord(report.diagnostics) ? report.diagnostics : {};
  const completedTrades = Array.isArray(report.recentCompletedTrades) ? report.recentCompletedTrades : [];

  return {
    routeId: stringOr(report.routeId, "ict-route-b-100x-cross-margin-2pct"),
    status: normalizeStatus(report.status),
    forwardStart: isoFromSeconds(report.forwardStart) ?? stringOrNull(report.forwardStartIso),
    through: isoFromSeconds(report.through) ?? stringOrNull(report.throughIso),
    elapsedDays: finiteNumber(report.elapsedDays, 0),
    observationGate: {
      minimumDays: finiteNumber(observationGate.minimumDays, 60),
      minimumCompletedTrades: finiteNumber(observationGate.minimumCompletedTrades, 50),
      mode: "either",
      reached: Boolean(observationGate.reached),
    },
    assumptions: {
      venue: "binance_usdm_btcusdt_perpetual",
      symbol: "BTCUSDT",
      leverageSelection: 100,
      marginMode: "cross",
      marginFraction: finiteNumber(assumptions.marginFraction ?? assumptions.initialMarginFraction, 0.02),
      effectiveNotionalEquityMultiple: 2,
      onePositionAtATime: true,
      fundingIgnored: true,
      markPriceAndDynamicBracketIgnored: true,
      automaticOrdersEnabled: false,
    },
    dataQuality: {
      source: stringOr(dataQuality.source, "binance_futures_public_rest"),
      interval: "5m",
      candleCount: finiteNumber(dataQuality.candleCount, 0),
      missingBarCount: finiteNumber(dataQuality.missingBarCount, 0),
      updatedAt: isoFromSeconds(report.through) ?? stringOrNull(report.throughIso),
    },
    metrics: {
      tradeCount: finiteNumber(metrics.tradeCount, 0),
      netPnl: finiteNumber(metrics.netPnl, 0),
      profitFactor: normalizeProfitFactor(metrics.profitFactor, completedTrades),
      averageR: finiteNumber(metrics.averageR, 0),
      maxDrawdownFraction: finiteNumber(metrics.maxDrawdownFraction, 0),
      initialEquity: finiteNumber(metrics.initialEquity, 10_000),
      finalEquity: finiteNumber(metrics.finalEquity, 10_000),
      fees: finiteNumber(metrics.fees ?? metrics.totalFees, 0),
    },
    diagnostics: {
      signals: finiteNumber(diagnostics.signals, 0),
      filled: finiteNumber(diagnostics.filled ?? diagnostics.filledOrders, 0),
      expired: finiteNumber(diagnostics.expired ?? diagnostics.expiredOrders, 0),
      costRejected: finiteNumber(diagnostics.costRejected ?? diagnostics.costRejectedOrders, 0),
      byRegime: isRecord(diagnostics.byRegime) ? diagnostics.byRegime : {},
    },
    openPosition: report.openPosition ? normalizePublicTrade(report.openPosition) : null,
    recentCompletedTrades: completedTrades.slice(-20).map(normalizePublicTrade),
    warnings: [],
  };
}

function makeUnavailableReport(reason: "no_report" | "report_unreadable"): ForwardReportResponse {
  return {
    routeId: "ict-route-b-100x-cross-margin-2pct",
    status: "unavailable",
    forwardStart: null,
    through: null,
    elapsedDays: 0,
    observationGate: { minimumDays: 60, minimumCompletedTrades: 50, mode: "either", reached: false },
    assumptions: {
      venue: "binance_usdm_btcusdt_perpetual",
      symbol: "BTCUSDT",
      leverageSelection: 100,
      marginMode: "cross",
      marginFraction: 0.02,
      effectiveNotionalEquityMultiple: 2,
      onePositionAtATime: true,
      fundingIgnored: true,
      markPriceAndDynamicBracketIgnored: true,
      automaticOrdersEnabled: false,
    },
    dataQuality: { source: "binance_futures_public_rest", interval: "5m", candleCount: 0, missingBarCount: 0, updatedAt: null },
    metrics: { tradeCount: 0, netPnl: 0, profitFactor: null, averageR: 0, maxDrawdownFraction: 0, initialEquity: 10_000, finalEquity: 10_000, fees: 0 },
    diagnostics: { signals: 0, filled: 0, expired: 0, costRejected: 0, byRegime: {} },
    openPosition: null,
    recentCompletedTrades: [],
    warnings: [reason],
  };
}

export function normalizePublicTrade(value: unknown): PublicForwardTrade {
  const trade = isRecord(value) ? value : {};
  return {
    side: trade.side === "long" || trade.side === "short" ? trade.side : null,
    signalTime: isoFromSeconds(trade.signalTime),
    entryTime: isoFromSeconds(trade.entryTime),
    exitTime: isoFromSeconds(trade.exitTime),
    entryPrice: nullableNumber(trade.entryPrice),
    exitPrice: nullableNumber(trade.exitPrice),
    stopPrice: nullableNumber(trade.stopPrice),
    targetPrice: nullableNumber(trade.targetPrice),
    quantity: nullableNumber(trade.quantity),
    netPnl: nullableNumber(trade.netPnl),
    rMultiple: nullableNumber(trade.rMultiple),
    fees: nullableNumber(trade.fees),
    exitReason: stringOrNull(trade.exitReason),
  };
}

function normalizeProfitFactor(value: unknown, trades: unknown[]) {
  const number = nullableNumber(value);
  if (number !== null && number > 0) return number;
  const hasLoss = trades.some((trade) => isRecord(trade) && nullableNumber(trade.netPnl) !== null && nullableNumber(trade.netPnl)! < 0);
  return hasLoss ? number : null;
}

function normalizeStatus(value: unknown): ForwardReportStatus {
  if (value === "collecting" || value === "observation_gate_reached_pending_review") return value;
  return "unavailable";
}

function isoFromSeconds(value: unknown) {
  const number = nullableNumber(value);
  if (number === null || number <= 0) return null;
  return new Date(number * 1000).toISOString();
}

function finiteNumber(value: unknown, fallback: number) {
  const number = nullableNumber(value);
  return number ?? fallback;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
