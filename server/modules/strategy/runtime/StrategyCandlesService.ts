import type { Candle } from "../../../types";

const SOURCE = "binance_usdm" as const;
const SYMBOL = "BTCUSDT" as const;
const SUPPORTED_INTERVALS = ["5m", "15m", "1h", "4h"] as const;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const CACHE_TTL_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;

type StrategyCandleInterval = typeof SUPPORTED_INTERVALS[number];

const INTERVAL_SECONDS: Record<StrategyCandleInterval, number> = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
};

export type StrategyCandlesQuery = {
  interval?: unknown;
  from?: unknown;
  to?: unknown;
  limit?: unknown;
};

export type PublicStrategyCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type StrategyCandlesResponse = {
  source: typeof SOURCE;
  symbol: typeof SYMBOL;
  interval: StrategyCandleInterval;
  status: "available" | "unavailable";
  requestedRange: { from: string; to: string };
  dataThrough: string | null;
  candles: PublicStrategyCandle[];
  warnings: string[];
};

export type StrategyCandlesReadResult =
  | { ok: true; statusCode: 200; report: StrategyCandlesResponse }
  | { ok: false; statusCode: 400 | 503; report: StrategyCandlesResponse };

export type StrategyCandlesReadOptions = {
  now?: () => number;
  fetchFn?: typeof fetch;
  cache?: StrategyCandlesCache;
};

export type StrategyCandlesCache = Map<string, { expiresAt: number; promise: Promise<Candle[]> }>;

const defaultCache: StrategyCandlesCache = new Map();

export async function readStrategyCandles(
  query: StrategyCandlesQuery = {},
  options: StrategyCandlesReadOptions = {},
): Promise<StrategyCandlesReadResult> {
  const nowMs = options.now?.() ?? Date.now();
  try {
    const request = normalizeRequest(query, nowMs);
    const candles = await loadCachedCandles(request, {
      nowMs,
      fetchFn: options.fetchFn ?? fetch,
      cache: options.cache ?? defaultCache,
    });
    const publicCandles = candles.map(toPublicCandle);
    return {
      ok: true,
      statusCode: 200,
      report: {
        source: SOURCE,
        symbol: SYMBOL,
        interval: request.interval,
        status: "available",
        requestedRange: {
          from: new Date(request.fromMs).toISOString(),
          to: new Date(request.toMs).toISOString(),
        },
        dataThrough: publicCandles.at(-1) ? new Date(publicCandles.at(-1)!.time * 1000).toISOString() : null,
        candles: publicCandles,
        warnings: publicCandles.length === 0 ? ["empty_data"] : [],
      },
    };
  } catch (error) {
    const reason = error instanceof UserQueryError ? error.message : "binance_candles_unavailable";
    const interval = safeNormalizeInterval(query.interval);
    const fallbackRange = makeFallbackRange(query, nowMs, interval);
    return {
      ok: false,
      statusCode: error instanceof UserQueryError ? 400 : 503,
      report: {
        source: SOURCE,
        symbol: SYMBOL,
        interval,
        status: "unavailable",
        requestedRange: fallbackRange,
        dataThrough: null,
        candles: [],
        warnings: [reason],
      },
    };
  }
}

function normalizeRequest(query: StrategyCandlesQuery, nowMs: number) {
  const interval = normalizeInterval(query.interval);
  const intervalMs = INTERVAL_SECONDS[interval] * 1000;
  const limit = normalizeLimit(query.limit);
  const latestClosedOpenMs = Math.floor(nowMs / intervalMs) * intervalMs - intervalMs;
  if (latestClosedOpenMs <= 0) throw new UserQueryError("invalid_time");
  const toMs = query.to === undefined
    ? latestClosedOpenMs
    : Math.min(parseIsoTime(query.to, "invalid_to"), latestClosedOpenMs);
  const fromMs = query.from === undefined
    ? toMs - (limit - 1) * intervalMs
    : parseIsoTime(query.from, "invalid_from");
  if (fromMs > toMs) throw new UserQueryError("invalid_range");
  const maxWindowMs = (MAX_LIMIT - 1) * intervalMs;
  if (toMs - fromMs > maxWindowMs) throw new UserQueryError("max_window_exceeded");
  return { interval, intervalMs, fromMs, toMs, limit };
}

function normalizeInterval(value: unknown): StrategyCandleInterval {
  if (value === undefined || value === null || value === "") return "5m";
  if (SUPPORTED_INTERVALS.includes(value as StrategyCandleInterval)) return value as StrategyCandleInterval;
  throw new UserQueryError("invalid_interval");
}

function safeNormalizeInterval(value: unknown): StrategyCandleInterval {
  try {
    return normalizeInterval(value);
  } catch {
    return "5m";
  }
}

function normalizeLimit(value: unknown) {
  if (value === undefined || value === null || value === "") return DEFAULT_LIMIT;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new UserQueryError("invalid_limit");
  return Math.min(number, MAX_LIMIT);
}

function parseIsoTime(value: unknown, errorCode: string) {
  if (typeof value !== "string" || value.trim() === "") throw new UserQueryError(errorCode);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new UserQueryError(errorCode);
  return timestamp;
}

async function loadCachedCandles(
  request: ReturnType<typeof normalizeRequest>,
  options: { nowMs: number; fetchFn: typeof fetch; cache: StrategyCandlesCache },
) {
  const cacheKey = [
    request.interval,
    request.fromMs,
    request.toMs,
    request.limit,
  ].join(":");
  const cached = options.cache.get(cacheKey);
  if (cached && cached.expiresAt > options.nowMs) return cached.promise;
  const promise = loadBinanceCandles(request, options.fetchFn).catch((error) => {
    options.cache.delete(cacheKey);
    throw error;
  });
  options.cache.set(cacheKey, { expiresAt: options.nowMs + CACHE_TTL_MS, promise });
  return promise;
}

async function loadBinanceCandles(request: ReturnType<typeof normalizeRequest>, fetchFn: typeof fetch) {
  const url = new URL("https://fapi.binance.com/fapi/v1/klines");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", request.interval);
  url.searchParams.set("startTime", String(request.fromMs));
  url.searchParams.set("endTime", String(request.toMs + request.intervalMs - 1));
  url.searchParams.set("limit", String(request.limit));
  const response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Binance strategy candles request failed: ${response.status}.`);
  const rows = await response.json() as unknown[][];
  return normalizeCandles(rows
    .map((row) => klineRowToCandle(row, request.interval))
    .filter((candle): candle is Candle => Boolean(candle))
    .filter((candle) => {
      const openMs = candle.time * 1000;
      return openMs >= request.fromMs && openMs <= request.toMs;
    }));
}

function klineRowToCandle(row: unknown[], interval: StrategyCandleInterval): Candle | null {
  const candle: Candle = {
    symbol: SYMBOL,
    interval,
    time: Math.trunc(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
  if (![candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) return null;
  if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0) return null;
  if (candle.high < candle.low) return null;
  return candle;
}

function normalizeCandles(candles: Candle[]) {
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()]
    .sort((left, right) => left.time - right.time);
}

function toPublicCandle(candle: Candle): PublicStrategyCandle {
  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };
}

function makeFallbackRange(query: StrategyCandlesQuery, nowMs: number, interval: StrategyCandleInterval) {
  const intervalMs = INTERVAL_SECONDS[interval] * 1000;
  const limit = (() => {
    try {
      return normalizeLimit(query.limit);
    } catch {
      return DEFAULT_LIMIT;
    }
  })();
  const latestClosedOpenMs = Math.floor(nowMs / intervalMs) * intervalMs - intervalMs;
  const toMs = (() => {
    try {
      return query.to === undefined ? latestClosedOpenMs : Math.min(parseIsoTime(query.to, "invalid_to"), latestClosedOpenMs);
    } catch {
      return latestClosedOpenMs;
    }
  })();
  const fromMs = (() => {
    try {
      return query.from === undefined ? toMs - (limit - 1) * intervalMs : parseIsoTime(query.from, "invalid_from");
    } catch {
      return toMs - (limit - 1) * intervalMs;
    }
  })();
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

class UserQueryError extends Error {}
