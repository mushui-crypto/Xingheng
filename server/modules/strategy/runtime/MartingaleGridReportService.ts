import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  MARTINGALE_GRID_CONFIG,
  MARTINGALE_GRID_FORWARD_START_ISO,
  MARTINGALE_GRID_ROUTE_ID,
  MARTINGALE_GRID_SYMBOLS,
  type MartingaleGridPaperReport,
} from "./MartingaleGridPaperEngine";
import type { MartingaleGridPaperWorkerStatus } from "./MartingaleGridPaperWorker";

const defaultReportPath = path.resolve("server/data/strategy/research-martingale-grid-paper.json");

export type MartingaleGridReportResponse = {
  routeId: string;
  status: "collecting" | "observation_gate_reached_pending_review" | "unavailable";
  forwardStart: string | null;
  through: string | null;
  elapsedDays: number;
  observationGate: { minimumDays: number; minimumCompletedGroups: number; mode: "either"; reached: boolean };
  assumptions: MartingaleGridPaperReport["assumptions"];
  configuration: MartingaleGridPaperReport["configuration"];
  dataQuality: MartingaleGridPaperReport["dataQuality"];
  metrics: MartingaleGridPaperReport["metrics"];
  diagnostics: MartingaleGridPaperReport["diagnostics"];
  openGroups: Array<Record<string, unknown>>;
  recentCompletedGroups: Array<Record<string, unknown>>;
  worker?: MartingaleGridPaperWorkerStatus;
  warnings: string[];
};

export type MartingaleGridReportReadResult =
  | { ok: true; report: MartingaleGridReportResponse }
  | { ok: false; statusCode: 200 | 503; report: MartingaleGridReportResponse };

export function getMartingaleGridReportPath() {
  return path.resolve(process.env.MARTINGALE_GRID_PAPER_REPORT_PATH ?? defaultReportPath);
}

export async function readMartingaleGridReport(reportPath = getMartingaleGridReportPath()): Promise<MartingaleGridReportReadResult> {
  try {
    await access(reportPath);
  } catch {
    return { ok: false, statusCode: 200, report: unavailableReport("no_report") };
  }
  try {
    const parsed = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    return { ok: true, report: normalizeMartingaleGridReport(parsed) };
  } catch {
    return { ok: false, statusCode: 503, report: unavailableReport("report_unreadable") };
  }
}

export function normalizeMartingaleGridReport(value: unknown): MartingaleGridReportResponse {
  const root = record(value);
  if (root.routeId !== MARTINGALE_GRID_ROUTE_ID) throw new Error("unexpected martingale grid report route");
  const gate = record(root.observationGate);
  const dataQuality = record(root.dataQuality);
  const metrics = record(root.metrics);
  const diagnostics = record(root.diagnostics);
  const config = record(root.configuration);
  const symbolQuality = record(dataQuality.symbols);
  const bySymbol = record(diagnostics.bySymbol);
  return {
    routeId: MARTINGALE_GRID_ROUTE_ID,
    status: root.status === "observation_gate_reached_pending_review" ? root.status : "collecting",
    forwardStart: isoFromSeconds(root.forwardStart) ?? stringOrNull(root.forwardStartIso),
    through: isoFromSeconds(root.through) ?? stringOrNull(root.throughIso),
    elapsedDays: numberOr(root.elapsedDays, 0),
    observationGate: {
      minimumDays: numberOr(gate.minimumDays, 60),
      minimumCompletedGroups: numberOr(gate.minimumCompletedGroups, 100),
      mode: "either",
      reached: Boolean(gate.reached),
    },
    assumptions: defaultAssumptions(),
    configuration: {
      ...MARTINGALE_GRID_CONFIG,
      initialEquityPerSymbol: numberOr(config.initialEquityPerSymbol, MARTINGALE_GRID_CONFIG.initialEquityPerSymbol),
      leverageSelection: numberOr(config.leverageSelection, MARTINGALE_GRID_CONFIG.leverageSelection),
      baseMarginFraction: numberOr(config.baseMarginFraction, MARTINGALE_GRID_CONFIG.baseMarginFraction),
      sizeMultiplier: numberOr(config.sizeMultiplier, MARTINGALE_GRID_CONFIG.sizeMultiplier),
      maximumLayers: numberOr(config.maximumLayers, MARTINGALE_GRID_CONFIG.maximumLayers),
      directionMode: "trend_filtered_bidirectional",
      entryModel: "15m_ema_trend_plus_5m_rsi_cross",
      gridModel: "atr_or_fraction_whichever_is_wider",
      exitModel: "weighted_average_group_target_with_hard_group_stop",
      oneGroupPerSymbol: true,
    },
    dataQuality: {
      source: "binance_futures_public_rest",
      interval: "5m",
      updatedAt: stringOrNull(dataQuality.updatedAt),
      symbols: {
        BTCUSDT: normalizeSymbolQuality(symbolQuality.BTCUSDT),
        ETHUSDT: normalizeSymbolQuality(symbolQuality.ETHUSDT),
      },
    },
    metrics: {
      completedGroups: numberOr(metrics.completedGroups, 0),
      totalFills: numberOr(metrics.totalFills, 0),
      realizedNetPnl: numberOr(metrics.realizedNetPnl, 0),
      unrealizedPnl: numberOr(metrics.unrealizedPnl, 0),
      profitFactor: nullableNumber(metrics.profitFactor),
      averageR: numberOr(metrics.averageR, 0),
      maxMarkToMarketDrawdownFraction: numberOr(metrics.maxMarkToMarketDrawdownFraction, 0),
      initialEquity: numberOr(metrics.initialEquity, 10_000),
      currentEquity: numberOr(metrics.currentEquity, 10_000),
      fees: numberOr(metrics.fees, 0),
    },
    diagnostics: {
      signals: numberOr(diagnostics.signals, 0),
      startedGroups: numberOr(diagnostics.startedGroups, 0),
      takeProfits: numberOr(diagnostics.takeProfits, 0),
      groupStops: numberOr(diagnostics.groupStops, 0),
      timeouts: numberOr(diagnostics.timeouts, 0),
      dailyLossLocks: numberOr(diagnostics.dailyLossLocks, 0),
      bySymbol: {
        BTCUSDT: normalizeSymbolDiagnostics(bySymbol.BTCUSDT),
        ETHUSDT: normalizeSymbolDiagnostics(bySymbol.ETHUSDT),
      },
    },
    openGroups: Array.isArray(root.openGroups) ? root.openGroups.slice(-2).map(normalizeOpenGroup) : [],
    recentCompletedGroups: Array.isArray(root.recentCompletedGroups) ? root.recentCompletedGroups.slice(-50).map(normalizeCompletedGroup) : [],
    warnings: [],
  };
}

function unavailableReport(reason: "no_report" | "report_unreadable"): MartingaleGridReportResponse {
  return {
    routeId: MARTINGALE_GRID_ROUTE_ID,
    status: "unavailable",
    forwardStart: MARTINGALE_GRID_FORWARD_START_ISO,
    through: null,
    elapsedDays: 0,
    observationGate: { minimumDays: 60, minimumCompletedGroups: 100, mode: "either", reached: false },
    assumptions: defaultAssumptions(),
    configuration: {
      ...MARTINGALE_GRID_CONFIG,
      directionMode: "trend_filtered_bidirectional",
      entryModel: "15m_ema_trend_plus_5m_rsi_cross",
      gridModel: "atr_or_fraction_whichever_is_wider",
      exitModel: "weighted_average_group_target_with_hard_group_stop",
      oneGroupPerSymbol: true,
    },
    dataQuality: {
      source: "binance_futures_public_rest",
      interval: "5m",
      updatedAt: null,
      symbols: {
        BTCUSDT: { candleCount: 0, missingBarCount: 0, through: null },
        ETHUSDT: { candleCount: 0, missingBarCount: 0, through: null },
      },
    },
    metrics: { completedGroups: 0, totalFills: 0, realizedNetPnl: 0, unrealizedPnl: 0, profitFactor: null, averageR: 0, maxMarkToMarketDrawdownFraction: 0, initialEquity: 10_000, currentEquity: 10_000, fees: 0 },
    diagnostics: {
      signals: 0,
      startedGroups: 0,
      takeProfits: 0,
      groupStops: 0,
      timeouts: 0,
      dailyLossLocks: 0,
      bySymbol: {
        BTCUSDT: { signals: 0, completedGroups: 0, totalFills: 0, realizedNetPnl: 0, openGroup: false },
        ETHUSDT: { signals: 0, completedGroups: 0, totalFills: 0, realizedNetPnl: 0, openGroup: false },
      },
    },
    openGroups: [],
    recentCompletedGroups: [],
    warnings: [reason],
  };
}

function defaultAssumptions(): MartingaleGridPaperReport["assumptions"] {
  return {
    venue: "binance_usdm_public_market_data",
    symbols: [...MARTINGALE_GRID_SYMBOLS],
    interval: "5m",
    trendInterval: "15m",
    paperOnly: true,
    automaticPaperEnabled: true,
    automaticOrdersEnabled: false,
    exchangeCredentialsRequired: false,
    fundingIgnored: true,
    markPriceAndLiquidationIgnored: true,
  };
}

function normalizeSymbolQuality(value: unknown) {
  const item = record(value);
  return { candleCount: numberOr(item.candleCount, 0), missingBarCount: numberOr(item.missingBarCount, 0), through: stringOrNull(item.through) };
}

function normalizeSymbolDiagnostics(value: unknown) {
  const item = record(value);
  return {
    signals: numberOr(item.signals, 0),
    completedGroups: numberOr(item.completedGroups, 0),
    totalFills: numberOr(item.totalFills, 0),
    realizedNetPnl: numberOr(item.realizedNetPnl, 0),
    openGroup: Boolean(item.openGroup),
  };
}

function normalizeOpenGroup(value: unknown): Record<string, unknown> {
  const item = record(value);
  return {
    id: stringOrNull(item.id), symbol: normalizeSymbol(item.symbol), side: normalizeSide(item.side),
    signalTime: isoFromSeconds(item.signalTime), entryTime: isoFromSeconds(item.entryTime),
    fills: normalizeFills(item.fills), averageEntryPrice: nullableNumber(item.averageEntryPrice),
    stopPrice: nullableNumber(item.stopPrice), targetPrice: nullableNumber(item.targetPrice), nextGridPrice: nullableNumber(item.nextGridPrice),
    quantity: nullableNumber(item.quantity), plannedRisk: nullableNumber(item.plannedRisk), markPrice: nullableNumber(item.markPrice),
    unrealizedPnl: nullableNumber(item.unrealizedPnl), feesPaid: nullableNumber(item.feesPaid),
  };
}

function normalizeCompletedGroup(value: unknown): Record<string, unknown> {
  const item = record(value);
  return {
    id: stringOrNull(item.id), symbol: normalizeSymbol(item.symbol), side: normalizeSide(item.side),
    signalTime: isoFromSeconds(item.signalTime), entryTime: isoFromSeconds(item.entryTime), exitTime: isoFromSeconds(item.exitTime),
    exitPrice: nullableNumber(item.exitPrice), exitReason: stringOrNull(item.exitReason), fills: normalizeFills(item.fills),
    averageEntryPrice: nullableNumber(item.averageEntryPrice), stopPrice: nullableNumber(item.stopPrice), targetPrice: nullableNumber(item.targetPrice),
    quantity: nullableNumber(item.quantity), grossPnl: nullableNumber(item.grossPnl), netPnl: nullableNumber(item.netPnl), fees: nullableNumber(item.fees),
    plannedRisk: nullableNumber(item.plannedRisk), rMultiple: nullableNumber(item.rMultiple), holdingMinutes: nullableNumber(item.holdingMinutes),
  };
}

function normalizeFills(value: unknown) {
  return Array.isArray(value) ? value.slice(0, MARTINGALE_GRID_CONFIG.maximumLayers).map((fill) => {
    const item = record(fill);
    return { level: nullableNumber(item.level), time: isoFromSeconds(item.time), price: nullableNumber(item.price), quantity: nullableNumber(item.quantity), notional: nullableNumber(item.notional), fee: nullableNumber(item.fee) };
  }) : [];
}

function normalizeSymbol(value: unknown) { return value === "BTCUSDT" || value === "ETHUSDT" ? value : null; }
function normalizeSide(value: unknown) { return value === "long" || value === "short" ? value : null; }
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringOrNull(value: unknown) { return typeof value === "string" ? value : null; }
function nullableNumber(value: unknown) { const parsed = Number(value); return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : null; }
function numberOr(value: unknown, fallback: number) { return nullableNumber(value) ?? fallback; }
function isoFromSeconds(value: unknown) { const parsed = nullableNumber(value); return parsed !== null && parsed > 0 ? new Date(parsed * 1000).toISOString() : null; }
