import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "../../../types";
import { BacktestEngine, type BacktestResult, type BacktestTrade } from "../backtest/BacktestEngine";
import type { Strategy } from "../core/types";
import { IctLiquidityReversalStrategy } from "../models/IctLiquidityReversalStrategy";
import { ictResearchCandidateV5 } from "../models/ictResearchCandidate";
import { makeIctLeverage100xBacktestConfig } from "../models/ictResearchRoutes";

export const ROUTE_B_ID = "ict-route-b-100x-cross-margin-2pct";
export const ROUTE_B_SYMBOL = "BTCUSDT";
export const ROUTE_B_INTERVAL = "5m";
export const ROUTE_B_INTERVAL_SECONDS = 5 * 60;
export const ROUTE_B_FORWARD_START_ISO = "2026-07-15T00:00:00.000Z";
export const ROUTE_B_FORWARD_START = Math.floor(Date.parse(ROUTE_B_FORWARD_START_ISO) / 1000);
export const ROUTE_B_HISTORY_START_ISO = "2024-01-01T00:00:00.000Z";
export const ROUTE_B_HISTORY_DEFAULT_THROUGH_DATE = "2026-07-13";

export type RouteBAssumptions = {
  venue: "binance_usdm_btcusdt_perpetual";
  symbol: "BTCUSDT";
  leverageSelection: 100;
  marginMode: "cross";
  marginFraction: 0.02;
  effectiveNotionalEquityMultiple: 2;
  onePositionAtATime: true;
  fundingIgnored: true;
  markPriceAndDynamicBracketIgnored: true;
  automaticOrdersEnabled: false;
};

export type RouteBDataQuality = {
  source: string;
  interval: "5m";
  candleCount: number;
  missingBarCount: number;
  updatedAt?: string | null;
  checksumVerified?: boolean;
  files?: string[];
};

export type RouteBMetrics = {
  tradeCount: number;
  netPnl: number;
  profitFactor: number | null;
  averageR: number;
  maxDrawdownFraction: number;
  initialEquity: number;
  finalEquity: number;
  fees: number;
};

export type RouteBForwardReport = {
  routeId: typeof ROUTE_B_ID;
  status: "collecting" | "observation_gate_reached_pending_review";
  forwardStart: number;
  forwardStartIso: string;
  through: number | null;
  throughIso: string | null;
  elapsedDays: number;
  observationGate: { minimumDays: 60; minimumCompletedTrades: 50; mode: "either"; reached: boolean };
  assumptions: RouteBAssumptions;
  dataQuality: RouteBDataQuality;
  metrics: RouteBMetrics;
  diagnostics: BacktestResult["diagnostics"];
  openPosition: BacktestTrade | null;
  recentCompletedTrades: BacktestTrade[];
};

export type RouteBHistoryReport = {
  routeId: typeof ROUTE_B_ID;
  generatedAt: string;
  availableRange: { from: string; to: string };
  dataThrough: string;
  attributionField: "entryTime";
  assumptions: RouteBAssumptions;
  dataQuality: RouteBDataQuality;
  metrics: RouteBMetrics;
  completedTrades: BacktestTrade[];
  openPosition: BacktestTrade | null;
  diagnostics: BacktestResult["diagnostics"];
};

export type BinanceKlineLoaderOptions = {
  startTime: number;
  endTime: number;
  fetchFn?: typeof fetch;
};

export function getRouteBAssumptions(): RouteBAssumptions {
  return {
    venue: "binance_usdm_btcusdt_perpetual",
    symbol: ROUTE_B_SYMBOL,
    leverageSelection: 100,
    marginMode: "cross",
    marginFraction: 0.02,
    effectiveNotionalEquityMultiple: 2,
    onePositionAtATime: true,
    fundingIgnored: true,
    markPriceAndDynamicBracketIgnored: true,
    automaticOrdersEnabled: false,
  };
}

export function buildRouteBForwardReport(
  candles: Candle[],
  options: { forwardStart?: number; now?: number; source?: string } = {},
): RouteBForwardReport {
  const forwardStart = options.forwardStart ?? ROUTE_B_FORWARD_START;
  const result = runRouteBBacktest(candles, { forwardStart });
  const forwardTrades = result.trades.filter((trade) => trade.signalTime >= forwardStart);
  const openPosition = forwardTrades.at(-1)?.exitReason === "end_of_data" ? forwardTrades.at(-1)! : null;
  const completedTrades = openPosition ? forwardTrades.slice(0, -1) : forwardTrades;
  const through = candles.at(-1)?.time ?? null;
  const elapsedDays = through === null ? 0 : Math.max(0, (through - forwardStart) / (24 * 60 * 60));
  const observationGateReached = elapsedDays >= 60 || completedTrades.length >= 50;

  return {
    routeId: ROUTE_B_ID,
    status: observationGateReached ? "observation_gate_reached_pending_review" : "collecting",
    forwardStart,
    forwardStartIso: new Date(forwardStart * 1000).toISOString(),
    through,
    throughIso: through ? new Date(through * 1000).toISOString() : null,
    elapsedDays,
    observationGate: { minimumDays: 60, minimumCompletedTrades: 50, mode: "either", reached: observationGateReached },
    assumptions: getRouteBAssumptions(),
    dataQuality: {
      source: options.source ?? "binance_futures_public_rest",
      interval: ROUTE_B_INTERVAL,
      candleCount: candles.length,
      missingBarCount: countMissingBars(candles),
      updatedAt: through ? new Date(through * 1000).toISOString() : null,
    },
    metrics: calculatePaperMetrics(completedTrades, result.config.initialEquity),
    diagnostics: result.diagnostics,
    openPosition,
    recentCompletedTrades: completedTrades.slice(-20),
  };
}

export function buildRouteBHistoryReport(
  candles: Candle[],
  options: {
    generatedAt?: string;
    availableFrom?: string;
    dataThrough?: string;
    source?: string;
    checksumVerified?: boolean;
    files?: string[];
  } = {},
): RouteBHistoryReport {
  const result = runRouteBBacktest(candles);
  const openPosition = result.trades.at(-1)?.exitReason === "end_of_data" ? result.trades.at(-1)! : null;
  const completedTrades = openPosition ? result.trades.slice(0, -1) : result.trades;
  const from = options.availableFrom ?? ROUTE_B_HISTORY_START_ISO.slice(0, 10);
  const lastCandleIso = candles.at(-1) ? new Date(candles.at(-1)!.time * 1000).toISOString().slice(0, 10) : from;
  const dataThrough = options.dataThrough ?? lastCandleIso;

  return {
    routeId: ROUTE_B_ID,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    availableRange: { from, to: dataThrough },
    dataThrough,
    attributionField: "entryTime",
    assumptions: getRouteBAssumptions(),
    dataQuality: {
      source: options.source ?? "binance_vision_usdm",
      interval: ROUTE_B_INTERVAL,
      candleCount: candles.length,
      missingBarCount: countMissingBars(candles),
      updatedAt: dataThrough,
      checksumVerified: options.checksumVerified,
      files: options.files,
    },
    metrics: calculatePaperMetrics(completedTrades, result.config.initialEquity),
    completedTrades,
    openPosition,
    diagnostics: result.diagnostics,
  };
}

export function calculatePaperMetrics(trades: BacktestTrade[], initialEquity: number): RouteBMetrics {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = -losses.reduce((sum, trade) => sum + trade.netPnl, 0);
  let equity = initialEquity;
  let peak = equity;
  let maxDrawdownFraction = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    const drawdownFraction = peak > 0 ? (peak - equity) / peak : 0;
    maxDrawdownFraction = Math.max(maxDrawdownFraction, drawdownFraction);
  }
  return {
    tradeCount: trades.length,
    netPnl: equity - initialEquity,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    averageR: trades.length ? trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length : 0,
    maxDrawdownFraction,
    initialEquity,
    finalEquity: equity,
    fees: trades.reduce((sum, trade) => sum + trade.fees, 0),
  };
}

export async function loadBinanceFuturesClosedKlines(options: BinanceKlineLoaderOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const candles: Candle[] = [];
  let cursor = Math.floor(options.startTime / ROUTE_B_INTERVAL_SECONDS) * ROUTE_B_INTERVAL_SECONDS * 1000;
  const endMilliseconds = options.endTime * 1000;
  for (let request = 0; cursor <= endMilliseconds && request < 100; request += 1) {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    url.searchParams.set("symbol", ROUTE_B_SYMBOL);
    url.searchParams.set("interval", ROUTE_B_INTERVAL);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endMilliseconds));
    url.searchParams.set("limit", "1500");
    const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Binance forward kline request failed: ${response.status}.`);
    const rows = await response.json() as unknown[][];
    if (rows.length === 0) break;
    for (const row of rows) {
      const candle = klineRowToCandle(row);
      if (
        candle &&
        candle.time + ROUTE_B_INTERVAL_SECONDS <= options.endTime
      ) candles.push(candle);
    }
    const lastOpenTime = Number(rows.at(-1)?.[0]);
    if (!Number.isFinite(lastOpenTime) || lastOpenTime < cursor) break;
    cursor = lastOpenTime + ROUTE_B_INTERVAL_SECONDS * 1000;
    if (rows.length < 1500) break;
  }
  return normalizeCandles(candles);
}

export async function loadLatestBinanceFuturesClosedKline(options: { now: number; fetchFn?: typeof fetch }) {
  const fetchFn = options.fetchFn ?? fetch;
  const url = new URL("https://fapi.binance.com/fapi/v1/klines");
  url.searchParams.set("symbol", ROUTE_B_SYMBOL);
  url.searchParams.set("interval", ROUTE_B_INTERVAL);
  url.searchParams.set("limit", "3");
  const response = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Binance latest kline request failed: ${response.status}.`);
  const rows = await response.json() as unknown[][];
  const closed = rows
    .map(klineRowToCandle)
    .filter((candle): candle is Candle => Boolean(candle) && candle!.time + ROUTE_B_INTERVAL_SECONDS <= options.now)
    .sort((left, right) => left.time - right.time);
  return closed.at(-1) ?? null;
}

export async function atomicWriteJson(filePath: string, value: unknown) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, resolved);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function countMissingBars(items: Array<{ time: number }>) {
  let missing = 0;
  for (let index = 1; index < items.length; index += 1) {
    const delta = items[index].time - items[index - 1].time;
    if (delta > ROUTE_B_INTERVAL_SECONDS) missing += Math.floor(delta / ROUTE_B_INTERVAL_SECONDS) - 1;
  }
  return missing;
}

function runRouteBBacktest(candles: Candle[], options: { forwardStart?: number } = {}) {
  const baseStrategy = new IctLiquidityReversalStrategy(ictResearchCandidateV5);
  const strategy: Strategy = {
    id: options.forwardStart ? `${baseStrategy.id}-route-b-forward` : `${baseStrategy.id}-route-b-history`,
    warmupBars: baseStrategy.warmupBars,
    prepare: (items) => baseStrategy.prepare(items),
    release: () => baseStrategy.release(),
    evaluate: (context) => {
      if (options.forwardStart && context.candles[context.index].time < options.forwardStart) return null;
      return baseStrategy.evaluate(context);
    },
  };
  try {
    return new BacktestEngine(strategy, makeIctLeverage100xBacktestConfig(0.02)).run(candles);
  } finally {
    strategy.release?.();
  }
}

function klineRowToCandle(row: unknown[]): Candle | null {
  const candle: Candle = {
    symbol: ROUTE_B_SYMBOL,
    interval: ROUTE_B_INTERVAL,
    time: Math.trunc(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
  if (![candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) return null;
  if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.high < candle.low) return null;
  return candle;
}

function normalizeCandles(candles: Candle[]) {
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()]
    .sort((left, right) => left.time - right.time);
}
