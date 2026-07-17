import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  FIXED_GRID_CONFIG,
  FIXED_GRID_FORWARD_START_ISO,
  FIXED_GRID_ROUTE_ID,
  type FixedGridCompletedGroup,
  type FixedGridDirectionState,
  type FixedGridFill,
  type FixedGridOpenGroup,
  type FixedGridOrder,
  type FixedGridPaperReport,
  type FixedGridWorkingPlan,
} from "./FixedGridPaperEngine";
import type { FixedGridPaperWorkerStatus } from "./FixedGridPaperWorker";

const defaultReportPath = path.resolve("server/data/strategy/research-fixed-grid-paper.json");
export type PublicFixedGridFill = Omit<FixedGridFill, "time"> & { time: string | null };
export type PublicFixedGridOrder = Omit<FixedGridOrder, "filledAt"> & { filledAt: string | null };
export type PublicFixedGridDirection = Omit<FixedGridDirectionState, "confirmedAt" | "expiresAt"> & {
  confirmedAt: string | null;
  expiresAt: string | null;
};
export type PublicFixedGridWorkingPlan = Omit<FixedGridWorkingPlan, "confirmedAt" | "expiresAt" | "orders"> & {
  confirmedAt: string | null;
  expiresAt: string | null;
  orders: PublicFixedGridOrder[];
};
export type PublicFixedGridOpenGroup = Omit<FixedGridOpenGroup, "confirmedAt" | "entryTime" | "fills" | "orders"> & {
  confirmedAt: string | null;
  entryTime: string | null;
  fills: PublicFixedGridFill[];
  orders: PublicFixedGridOrder[];
};
export type PublicFixedGridCompletedGroup = Omit<FixedGridCompletedGroup, "confirmedAt" | "entryTime" | "exitTime" | "fills" | "orders"> & {
  confirmedAt: string | null;
  entryTime: string | null;
  exitTime: string | null;
  fills: PublicFixedGridFill[];
  orders: PublicFixedGridOrder[];
};
export type FixedGridReportResponse = Omit<FixedGridPaperReport,
  | "status"
  | "forwardStart"
  | "forwardStartIso"
  | "through"
  | "throughIso"
  | "directions"
  | "workingPlans"
  | "openGroups"
  | "recentCompletedGroups"
> & {
  status: FixedGridPaperReport["status"] | "unavailable";
  forwardStart: string | null;
  through: string | null;
  directions: Record<"BTCUSDT" | "ETHUSDT", PublicFixedGridDirection>;
  workingPlans: PublicFixedGridWorkingPlan[];
  openGroups: PublicFixedGridOpenGroup[];
  recentCompletedGroups: PublicFixedGridCompletedGroup[];
  worker?: FixedGridPaperWorkerStatus;
  warnings: string[];
};
export type FixedGridReportReadResult = { ok: true; report: FixedGridReportResponse } | { ok: false; statusCode: 200 | 503; report: FixedGridReportResponse };

export function getFixedGridReportPath() { return path.resolve(process.env.FIXED_GRID_PAPER_REPORT_PATH ?? defaultReportPath); }

export async function readFixedGridReport(reportPath = getFixedGridReportPath()): Promise<FixedGridReportReadResult> {
  try { await access(reportPath); } catch { return { ok: false, statusCode: 200, report: unavailable("no_report") }; }
  try { return { ok: true, report: normalizeFixedGridReport(JSON.parse(await readFile(reportPath, "utf8"))) }; }
  catch { return { ok: false, statusCode: 503, report: unavailable("report_unreadable") }; }
}

export function normalizeFixedGridReport(value: unknown): FixedGridReportResponse {
  const report = value as FixedGridPaperReport;
  if (!report || report.routeId !== FIXED_GRID_ROUTE_ID || report.assumptions?.automaticOrdersEnabled !== false) throw new Error("unexpected fixed grid report");
  const { forwardStart, forwardStartIso, through, throughIso, ...publicReport } = report;
  return {
    ...publicReport,
    forwardStart: iso(forwardStart) ?? forwardStartIso ?? null,
    through: iso(through) ?? throughIso ?? null,
    assumptions: {
      venue: "binance_usdm_public_market_data",
      symbols: ["BTCUSDT", "ETHUSDT"],
      sourceInterval: "5m",
      directionIntervals: ["4h", "1h"],
      entryModel: "fixed_price_distance",
      paperOnly: true,
      automaticPaperEnabled: true,
      automaticOrdersEnabled: false,
      exchangeCredentialsRequired: false,
      fundingIgnored: true,
      markPriceAndLiquidationIgnored: true,
    },
    directions: {
      BTCUSDT: publicDirection(report.directions.BTCUSDT),
      ETHUSDT: publicDirection(report.directions.ETHUSDT),
    },
    workingPlans: Array.isArray(report.workingPlans) ? report.workingPlans.slice(-2).map(publicPlan) : [],
    openGroups: Array.isArray(report.openGroups) ? report.openGroups.slice(-2).map(publicOpenGroup) : [],
    recentCompletedGroups: Array.isArray(report.recentCompletedGroups) ? report.recentCompletedGroups.slice(-50).map(publicCompletedGroup) : [],
    warnings: [],
  };
}

function unavailable(reason: "no_report" | "report_unreadable"): FixedGridReportResponse {
  return {
    routeId: FIXED_GRID_ROUTE_ID,
    status: "unavailable",
    forwardStart: FIXED_GRID_FORWARD_START_ISO,
    through: null,
    elapsedDays: 0,
    observationGate: { minimumDays: 60, minimumCompletedGroups: 100, mode: "either", reached: false },
    assumptions: { venue: "binance_usdm_public_market_data", symbols: ["BTCUSDT", "ETHUSDT"], sourceInterval: "5m", directionIntervals: ["4h", "1h"], entryModel: "fixed_price_distance", paperOnly: true, automaticPaperEnabled: true, automaticOrdersEnabled: false, exchangeCredentialsRequired: false, fundingIgnored: true, markPriceAndLiquidationIgnored: true },
    configuration: { ...FIXED_GRID_CONFIG, gridStepBySymbol: { ...FIXED_GRID_CONFIG.gridStepBySymbol }, directionModel: "confirmed_4h_structure_plus_1h_break", riskScaling: "scale_all_layers_to_structural_stop_risk_cap", oneGroupPerSymbol: true },
    dataQuality: { source: "binance_futures_public_rest", interval: "5m", updatedAt: null, symbols: { BTCUSDT: { candleCount: 0, missingBarCount: 0, through: null }, ETHUSDT: { candleCount: 0, missingBarCount: 0, through: null } } },
    metrics: { completedGroups: 0, totalFills: 0, realizedNetPnl: 0, unrealizedPnl: 0, profitFactor: null, averageR: 0, maxMarkToMarketDrawdownFraction: 0, initialEquity: 10_000, currentEquity: 10_000, fees: 0 },
    diagnostics: { confirmations: 0, expiredPlans: 0, startedGroups: 0, takeProfits: 0, groupStops: 0, timeouts: 0, dailyLossLocks: 0, bySymbol: { BTCUSDT: { confirmations: 0, expiredPlans: 0, completedGroups: 0, totalFills: 0, realizedNetPnl: 0, openGroup: false, workingPlan: false }, ETHUSDT: { confirmations: 0, expiredPlans: 0, completedGroups: 0, totalFills: 0, realizedNetPnl: 0, openGroup: false, workingPlan: false } } },
    directions: { BTCUSDT: emptyDirection(), ETHUSDT: emptyDirection() },
    workingPlans: [],
    openGroups: [],
    recentCompletedGroups: [],
    warnings: [reason],
  };
}
function emptyDirection() { return { fourHourBias: "neutral" as const, oneHourConfirmation: "none" as const, status: "waiting_for_structure" as const, anchorPrice: null, confirmedAt: null, expiresAt: null }; }
function iso(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed * 1000).toISOString() : null; }

function publicFill(fill: FixedGridFill): PublicFixedGridFill {
  return { ...fill, time: iso(fill.time) };
}

function publicOrder(order: FixedGridOrder): PublicFixedGridOrder {
  return { ...order, filledAt: iso(order.filledAt) };
}

function publicDirection(direction: FixedGridDirectionState): PublicFixedGridDirection {
  return { ...direction, confirmedAt: iso(direction.confirmedAt), expiresAt: iso(direction.expiresAt) };
}

function publicPlan(plan: FixedGridWorkingPlan): PublicFixedGridWorkingPlan {
  return {
    ...plan,
    confirmedAt: iso(plan.confirmedAt),
    expiresAt: iso(plan.expiresAt),
    orders: plan.orders.map(publicOrder),
  };
}

function publicOpenGroup(group: FixedGridOpenGroup): PublicFixedGridOpenGroup {
  return {
    ...group,
    confirmedAt: iso(group.confirmedAt),
    entryTime: iso(group.entryTime),
    fills: group.fills.map(publicFill),
    orders: group.orders.map(publicOrder),
  };
}

function publicCompletedGroup(group: FixedGridCompletedGroup): PublicFixedGridCompletedGroup {
  return {
    ...group,
    confirmedAt: iso(group.confirmedAt),
    entryTime: iso(group.entryTime),
    exitTime: iso(group.exitTime),
    fills: group.fills.map(publicFill),
    orders: group.orders.map(publicOrder),
  };
}
