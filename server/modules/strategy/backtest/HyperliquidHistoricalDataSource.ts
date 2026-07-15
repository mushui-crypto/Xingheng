import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle, CandleInterval } from "../../../types";
import { intervalDurationMs } from "../../market/marketConfig";
import { normalizeProviderCandle, type HyperliquidCandle } from "../../market/HyperliquidRestClient";

const defaultBaseUrl = process.env.HYPERLIQUID_REST_BASE_URL ?? "https://api.hyperliquid.xyz";

export type HistoricalRequest = {
  symbol: string;
  providerCoin: string;
  interval: CandleInterval;
  startTime: number;
  endTime: number;
};

export class HyperliquidHistoricalDataSource {
  constructor(
    private baseUrl = defaultBaseUrl,
    private cacheDirectory = path.resolve(".cache/strategy/hyperliquid"),
  ) {}

  async load(request: HistoricalRequest): Promise<Candle[]> {
    validateRequest(request);
    const cachePath = path.join(this.cacheDirectory, cacheFileName(request));
    const cached = await readFile(cachePath, "utf8").then((value) => JSON.parse(value) as Candle[]).catch(() => null);
    if (cached?.length) return normalizeCandles(cached);

    const durationMs = intervalDurationMs(request.interval);
    const payload = await this.postInfo({
      type: "candleSnapshot",
      req: {
        coin: request.providerCoin,
        interval: request.interval,
        startTime: request.startTime,
        endTime: request.endTime,
      },
    });
    if (!Array.isArray(payload)) throw new Error("Hyperliquid candleSnapshot returned an invalid payload.");
    const candles = payload
      .map((row) => normalizeProviderCandle(row as HyperliquidCandle, request.symbol, request.interval))
      .filter((candle): candle is Candle => candle !== null)
      .sort((left, right) => left.time - right.time);
    const normalized = normalizeCandles(candles).filter(
      (candle) => candle.time * 1000 >= request.startTime && candle.time * 1000 <= request.endTime,
    );
    if (normalized.length === 0) {
      throw new Error("Hyperliquid did not return candles for the requested range.");
    }
    if (normalized[0].time * 1000 > request.startTime + durationMs) {
      throw new Error(
        "Hyperliquid candleSnapshot truncated the requested history. Use a shorter range or an approved long-term dataset.",
      );
    }
    await mkdir(this.cacheDirectory, { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  }

  private async postInfo(body: unknown) {
    const response = await fetch(new URL("/info", this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Hyperliquid history request failed: ${response.status} ${response.statusText}`);
    return response.json() as Promise<unknown>;
  }
}

function validateRequest(request: HistoricalRequest) {
  if (!request.symbol.trim() || !request.providerCoin.trim()) throw new Error("Historical symbol and providerCoin are required.");
  if (!Number.isFinite(request.startTime) || !Number.isFinite(request.endTime) || request.startTime >= request.endTime) {
    throw new Error("Historical time range is invalid.");
  }
}

function cacheFileName(request: HistoricalRequest) {
  const safeCoin = request.providerCoin.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safeCoin}-${request.interval}-${request.startTime}-${request.endTime}.json`;
}

function normalizeCandles(candles: Candle[]) {
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()]
    .sort((left, right) => left.time - right.time);
}
