import { tracedProviderFetch, tracedProviderJson } from "../cex/ProviderRequestTrace";
import type { BybitCategory } from "./BybitTypes";

export type BybitExecutionTicker = Readonly<{
  category: BybitCategory;
  symbol: string;
  bid: string;
  ask: string;
  fetchedAt: number;
}>;

export type BybitExecutionTickerSource = (
  category: BybitCategory,
  symbol: string,
) => Promise<BybitExecutionTicker>;

export function createBybitExecutionTickerSource(options: Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  clock?: () => number;
}> = {}): BybitExecutionTickerSource {
  const baseUrl = options.baseUrl ?? "https://api.bybit.com";
  const fetchImpl = tracedProviderFetch("bybit", options.fetchImpl ?? fetch);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const clock = options.clock ?? Date.now;
  return async (category, symbol) => {
    const url = new URL("/v5/market/tickers", baseUrl);
    url.searchParams.set("category", category);
    url.searchParams.set("symbol", symbol);
    const response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Bybit ticker request failed with HTTP ${response.status}.`);
    const root = record(await tracedProviderJson(response), "Bybit ticker response");
    if (root.retCode !== 0) throw new Error(`Bybit ticker response rejected: ${String(root.retCode)}.`);
    const result = record(root.result, "Bybit ticker result");
    const rows = array(result.list, "Bybit ticker list").map((item) => record(item, "Bybit ticker"))
      .filter((item) => item.symbol === symbol);
    if (rows.length !== 1) throw new Error("Bybit ticker identity is unavailable or ambiguous.");
    const fetchedAt = clock();
    if (!Number.isSafeInteger(fetchedAt) || fetchedAt < 0) throw new Error("Bybit ticker clock is invalid.");
    return Object.freeze({
      category,
      symbol,
      bid: positiveDecimal(rows[0]!.bid1Price, "Bybit bid1Price"),
      ask: positiveDecimal(rows[0]!.ask1Price, "Bybit ask1Price"),
      fetchedAt,
    });
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function positiveDecimal(value: unknown, label: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
