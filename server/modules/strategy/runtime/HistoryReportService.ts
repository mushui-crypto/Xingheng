import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizePublicTrade, type PublicForwardTrade } from "./ForwardReportService";
import { calculatePaperMetrics, getRouteBAssumptions, ROUTE_B_ID, ROUTE_B_HISTORY_START_ISO } from "./RouteBPaperEngine";
import type { BacktestTrade } from "../backtest/BacktestEngine";

const defaultHistoryReportPath = path.resolve("server/data/strategy/research-ict-route-b-history.json");

export type HistoryReportQuery = {
  from?: unknown;
  to?: unknown;
  limit?: unknown;
  cursor?: unknown;
};

export type HistoryReportResponse = {
  routeId: typeof ROUTE_B_ID;
  status: "available" | "unavailable";
  requestedRange: { from: string | null; to: string | null };
  availableRange: { from: string | null; to: string | null };
  dataThrough: string | null;
  attributionField: "entryTime";
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
  completedTrades: PublicForwardTrade[];
  pagination: {
    limit: number;
    cursor: string | null;
    nextCursor: string | null;
    hasMore: boolean;
    total: number;
  };
  assumptions: ReturnType<typeof getRouteBAssumptions>;
  warnings: string[];
};

export type HistoryReportReadResult =
  | { ok: true; report: HistoryReportResponse }
  | { ok: false; statusCode: 200 | 400 | 503; report: HistoryReportResponse };

export function getHistoryReportPath() {
  return path.resolve(process.env.STRATEGY_HISTORY_REPORT_PATH ?? defaultHistoryReportPath);
}

export async function readHistoryReport(
  query: HistoryReportQuery = {},
  reportPath = getHistoryReportPath(),
): Promise<HistoryReportReadResult> {
  const exists = await access(reportPath).then(() => true).catch(() => false);
  if (!exists) {
    return { ok: false, statusCode: 200, report: makeUnavailableHistoryReport("no_report", query) };
  }
  try {
    const parsed = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    return { ok: true, report: normalizeHistoryReport(parsed, query) };
  } catch (error) {
    if (error instanceof UserQueryError) {
      return { ok: false, statusCode: 400, report: makeUnavailableHistoryReport(error.message, query) };
    }
    return { ok: false, statusCode: 503, report: makeUnavailableHistoryReport("report_unreadable", query) };
  }
}

export function normalizeHistoryReport(value: unknown, query: HistoryReportQuery = {}): HistoryReportResponse {
  const report = isRecord(value) ? value : {};
  const range = isRecord(report.availableRange) ? report.availableRange : {};
  const dataQuality = isRecord(report.dataQuality) ? report.dataQuality : {};
  const rawTrades = Array.isArray(report.completedTrades) ? report.completedTrades : [];
  const trades = rawTrades.filter(isRecord);
  const availableFrom = parseDateOnly(range.from) ?? ROUTE_B_HISTORY_START_ISO.slice(0, 10);
  const availableTo = parseDateOnly(range.to) ?? parseDateOnly(report.dataThrough) ?? deriveLastTradeDate(trades) ?? availableFrom;
  const requested = normalizeRequestedRange(query, availableFrom, availableTo);
  const warnings = [...requested.warnings];
  const filteredRawTrades = trades.filter((trade) => {
    const entryDate = secondsToDateOnly(trade.entryTime);
    return entryDate !== null && entryDate >= requested.from && entryDate <= requested.to;
  }) as BacktestTrade[];
  const metrics = calculatePaperMetrics(filteredRawTrades, 10_000);
  const page = paginate(filteredRawTrades, query);

  return {
    routeId: ROUTE_B_ID,
    status: "available",
    requestedRange: { from: requested.from, to: requested.to },
    availableRange: { from: availableFrom, to: availableTo },
    dataThrough: availableTo,
    attributionField: "entryTime",
    dataQuality: {
      source: stringOr(dataQuality.source, "binance_vision_usdm"),
      interval: "5m",
      candleCount: finiteNumber(dataQuality.candleCount, 0),
      missingBarCount: finiteNumber(dataQuality.missingBarCount, 0),
      updatedAt: stringOrNull(dataQuality.updatedAt) ?? availableTo,
    },
    metrics,
    completedTrades: page.items.map(normalizePublicTrade),
    pagination: {
      limit: page.limit,
      cursor: page.cursor === 0 ? null : String(page.cursor),
      nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
      hasMore: page.nextCursor !== null,
      total: filteredRawTrades.length,
    },
    assumptions: getRouteBAssumptions(),
    warnings,
  };
}

function makeUnavailableHistoryReport(reason: string, query: HistoryReportQuery): HistoryReportResponse {
  const requestedFrom = parseDateOnly(query.from);
  const requestedTo = parseDateOnly(query.to);
  return {
    routeId: ROUTE_B_ID,
    status: "unavailable",
    requestedRange: { from: requestedFrom, to: requestedTo },
    availableRange: { from: null, to: null },
    dataThrough: null,
    attributionField: "entryTime",
    dataQuality: { source: "binance_vision_usdm", interval: "5m", candleCount: 0, missingBarCount: 0, updatedAt: null },
    metrics: { tradeCount: 0, netPnl: 0, profitFactor: null, averageR: 0, maxDrawdownFraction: 0, initialEquity: 10_000, finalEquity: 10_000, fees: 0 },
    completedTrades: [],
    pagination: { limit: normalizeLimit(query.limit), cursor: null, nextCursor: null, hasMore: false, total: 0 },
    assumptions: getRouteBAssumptions(),
    warnings: [reason],
  };
}

function normalizeRequestedRange(query: HistoryReportQuery, availableFrom: string, availableTo: string) {
  const warnings: string[] = [];
  const requestedFrom = query.from === undefined ? availableFrom : parseDateOnly(query.from);
  const requestedTo = query.to === undefined ? availableTo : parseDateOnly(query.to);
  if (!requestedFrom) throw new UserQueryError("invalid_from");
  if (!requestedTo) throw new UserQueryError("invalid_to");
  if (requestedFrom > requestedTo) throw new UserQueryError("invalid_range");
  let from = requestedFrom;
  let to = requestedTo;
  if (from < availableFrom) {
    from = availableFrom;
    warnings.push("range_clamped");
  }
  if (to > availableTo) {
    to = availableTo;
    if (!warnings.includes("range_clamped")) warnings.push("range_clamped");
  }
  return { from, to, warnings };
}

function paginate<T>(items: T[], query: HistoryReportQuery) {
  const limit = normalizeLimit(query.limit);
  const cursor = normalizeCursor(query.cursor);
  const pageItems = items.slice(cursor, cursor + limit);
  const nextCursor = cursor + limit < items.length ? cursor + limit : null;
  return { items: pageItems, limit, cursor, nextCursor };
}

function normalizeLimit(value: unknown) {
  const number = Number(value ?? 50);
  if (!Number.isFinite(number)) return 50;
  return Math.max(1, Math.min(100, Math.trunc(number)));
}

function normalizeCursor(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new UserQueryError("invalid_cursor");
  return number;
}

function deriveLastTradeDate(trades: Record<string, unknown>[]) {
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    const date = secondsToDateOnly(trades[index].entryTime);
    if (date) return date;
  }
  return null;
}

function secondsToDateOnly(value: unknown) {
  const number = nullableNumber(value);
  if (number === null || number <= 0) return null;
  return new Date(number * 1000).toISOString().slice(0, 10);
}

function parseDateOnly(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const time = Date.parse(`${trimmed}T00:00:00.000Z`);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10) === trimmed ? trimmed : null;
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

class UserQueryError extends Error {}
