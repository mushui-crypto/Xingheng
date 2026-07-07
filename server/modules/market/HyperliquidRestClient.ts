import type { Candle, CandleInterval, MarketCategory, MarketSourceType } from "../../types";
import { intervalDurationMs, normalizeInterval, normalizeLimit, normalizeSymbol, toHyperliquidCoin } from "./marketConfig";

const defaultRestBaseUrl = process.env.HYPERLIQUID_REST_BASE_URL ?? "https://api.hyperliquid.xyz";
const requestTimeoutMs = 15_000;
const maxRequestAttempts = 2;

export type HyperliquidCandle = {
  T: number;
  c: string | number;
  h: string | number;
  i: string;
  l: string | number;
  n: number;
  o: string | number;
  s: string;
  t: number;
  v: string | number;
};

type HyperliquidUniverseItem = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
  growthMode?: string;
};

type HyperliquidAssetContext = {
  markPx?: string;
  midPx?: string;
  dayNtlVlm?: string;
  openInterest?: string;
};

export type HyperliquidPerpMarket = {
  providerMarketId: string;
  providerCoin: string;
  sourceDex: string;
  sourceType: MarketSourceType;
  category: MarketCategory;
  displayName?: string;
  szDecimals: number;
  maxLeverage: number;
  markPrice: number;
  dayNotionalVolume: number;
  openInterest: number;
};

type HyperliquidPerpDex = {
  name: string;
  fullName?: string;
};

type PerpDexDescriptor = {
  dexParam: string;
  sourceDex: string;
  sourceType: MarketSourceType;
};

type PerpAnnotation = {
  category?: string;
  displayName?: string;
  keywords?: string[];
};

export class HyperliquidRestClient {
  constructor(private baseUrl = defaultRestBaseUrl) {}

  async getPerpetualMarkets(): Promise<HyperliquidPerpMarket[]> {
    const annotations = await this.getPerpAnnotations();
    const markets: HyperliquidPerpMarket[] = [];
    for (const dex of await this.getPerpDexDescriptors()) {
      markets.push(...(await this.getPerpetualMarketsForDex(dex, annotations)));
    }
    return markets;
  }

  private async getPerpetualMarketsForDex(
    dex: PerpDexDescriptor,
    annotations: Map<string, PerpAnnotation>,
  ): Promise<HyperliquidPerpMarket[]> {
    const payload = await this.postInfo({
      type: "metaAndAssetCtxs",
      ...(dex.dexParam ? { dex: dex.dexParam } : {}),
    });
    if (!Array.isArray(payload) || !payload[0] || !Array.isArray(payload[0].universe) || !Array.isArray(payload[1])) {
      throw new Error("Hyperliquid metaAndAssetCtxs returned an invalid payload.");
    }
    const universe = payload[0].universe as HyperliquidUniverseItem[];
    const contexts = payload[1] as HyperliquidAssetContext[];
    return universe.flatMap((item, index) => {
      const context = contexts[index] ?? {};
      const markPrice = Number(context.midPx ?? context.markPx);
      if (
        item.isDelisted ||
        !item.name ||
        (dex.sourceType === "main" && item.name.includes(":")) ||
        !Number.isFinite(markPrice) ||
        markPrice <= 0
      ) {
        return [];
      }
      const providerMarketId = item.name;
      const providerCoin = providerMarketId.includes(":") ? providerMarketId.split(":").at(-1)! : providerMarketId;
      const annotation = annotations.get(providerMarketId) ?? annotations.get(`${dex.dexParam}:${providerCoin}`);
      return [{
        providerMarketId,
        providerCoin,
        sourceDex: dex.sourceDex,
        sourceType: dex.sourceType,
        category: dex.sourceType === "main" ? "crypto" : normalizeProviderCategory(annotation?.category, providerCoin),
        displayName: annotation?.displayName,
        szDecimals: item.szDecimals,
        maxLeverage: item.maxLeverage,
        markPrice,
        dayNotionalVolume: Number(context.dayNtlVlm ?? 0),
        openInterest: Number(context.openInterest ?? 0),
      }];
    });
  }

  private async getPerpDexDescriptors(): Promise<PerpDexDescriptor[]> {
    const payload = await this.postInfo({ type: "perpDexs" });
    if (!Array.isArray(payload)) {
      throw new Error("Hyperliquid perpDexs returned an invalid payload.");
    }
    const hip3Dexs = payload
      .filter((item): item is HyperliquidPerpDex => item !== null && typeof item?.name === "string" && item.name.trim().length > 0)
      .map((item) => item.name.trim());
    return [
      { dexParam: "", sourceDex: "main", sourceType: "main" },
      ...hip3Dexs.map((name) => ({ dexParam: name, sourceDex: name, sourceType: "hip3" as const })),
    ];
  }

  private async getPerpAnnotations(): Promise<Map<string, PerpAnnotation>> {
    const annotations = new Map<string, PerpAnnotation>();
    for (const request of [{ type: "perpConciseAnnotations" }, { type: "perpCategories" }]) {
      try {
        const payload = await this.postInfo(request);
        if (!Array.isArray(payload)) continue;
        for (const row of payload) {
          if (!Array.isArray(row) || typeof row[0] !== "string") continue;
          const previous = annotations.get(row[0]) ?? {};
          const value = row[1];
          annotations.set(row[0], {
            ...previous,
            ...(typeof value === "string" ? { category: value } : typeof value === "object" && value ? value : {}),
          });
        }
      } catch (error) {
        console.warn(
          `[market] Hyperliquid ${request.type} unavailable; special market categories may fall back to other.`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return annotations;
  }

  async getKlines(symbol: string, interval: CandleInterval, limit: number): Promise<Candle[]> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedInterval = normalizeInterval(interval);
    const normalizedLimit = normalizeLimit(limit);
    const endTime = Date.now();
    const startTime = endTime - intervalDurationMs(normalizedInterval) * (normalizedLimit + 2);
    const durationMs = intervalDurationMs(normalizedInterval);
    const candles: Candle[] = [];
    let cursor = startTime;

    while (candles.length < normalizedLimit && cursor <= endTime) {
      const payload = await this.fetchCandleSnapshot(
        toHyperliquidCoin(normalizedSymbol),
        normalizedInterval,
        cursor,
        endTime,
      );
      const page = payload
        .map((row) => normalizeProviderCandle(row, normalizedSymbol, normalizedInterval))
        .filter((candle): candle is Candle => candle !== null)
        .sort((left, right) => left.time - right.time);
      if (page.length === 0) {
        break;
      }
      candles.push(...page);
      const nextCursor = page.at(-1)!.time * 1000 + durationMs;
      if (nextCursor <= cursor) {
        break;
      }
      cursor = nextCursor;
    }

    return [...new Map(candles.map((candle) => [candle.time, candle])).values()]
      .sort((left, right) => left.time - right.time)
      .slice(-normalizedLimit);
  }

  private async fetchCandleSnapshot(coin: string, interval: CandleInterval, startTime: number, endTime: number) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRequestAttempts; attempt += 1) {
      try {
        const payload = await this.postInfo({
          type: "candleSnapshot",
          req: { coin, interval, startTime, endTime },
        });
        if (!Array.isArray(payload)) {
          throw new Error("Hyperliquid candleSnapshot returned an invalid payload.");
        }
        return payload as HyperliquidCandle[];
      } catch (error) {
        lastError = error;
        if (attempt >= maxRequestAttempts) {
          break;
        }
        await delay(500 * attempt);
      }
    }
    throw lastError;
  }

  private async postInfo(body: unknown) {
    const url = new URL("/info", this.baseUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`Hyperliquid info request failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`);
    }
    return response.json() as Promise<any>;
  }
}

function normalizeProviderCategory(value: unknown, providerCoin: string): MarketCategory {
  const category = String(value ?? "").trim().toLowerCase();
  if (category === "crypto") return "crypto";
  if (category === "stocks") return "us_equities";
  if (category === "indices") return "indices";
  if (category === "commodities" && ["GOLD", "SILVER", "PLATINUM", "PALLADIUM"].includes(providerCoin.toUpperCase())) {
    return "metals";
  }
  return "other";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeProviderCandle(
  row: HyperliquidCandle,
  symbol: string,
  expectedInterval?: CandleInterval,
): Candle | null {
  const interval = normalizeInterval(String(row.i ?? expectedInterval ?? ""));
  const candle: Candle = {
    symbol: normalizeSymbol(symbol),
    interval,
    time: Math.floor(Number(row.t) / 1000),
    open: Number(row.o),
    high: Number(row.h),
    low: Number(row.l),
    close: Number(row.c),
    volume: Number(row.v),
  };
  if (
    !Number.isFinite(candle.time) ||
    candle.time <= 0 ||
    ![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) ||
    candle.open <= 0 ||
    candle.close <= 0
  ) {
    return null;
  }
  return {
    ...candle,
    high: Math.max(candle.high, candle.open, candle.close),
    low: Math.min(candle.low, candle.open, candle.close),
  };
}
