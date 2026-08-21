import type { BitgetCategory } from "./BitgetTypes";

export type BitgetExecutionTicker = Readonly<{
  category: BitgetCategory;
  symbol: string;
  bid: string;
  ask: string;
  fetchedAt: number;
}>;
export type BitgetExecutionTickerSource = (category: BitgetCategory, symbol: string) => Promise<BitgetExecutionTicker>;

export function createBitgetExecutionTickerSource(options: Readonly<{
  baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number; clock?: () => number;
}> = {}): BitgetExecutionTickerSource {
  const baseUrl = options.baseUrl ?? "https://api.bitget.com";
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const clock = options.clock ?? Date.now;
  return async (category, symbol) => {
    const url = new URL("/api/v3/market/tickers", baseUrl);
    url.searchParams.set("category", category);
    url.searchParams.set("symbol", symbol);
    const response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Bitget ticker request failed with HTTP ${response.status}.`);
    const root = record(await response.json(), "Bitget ticker response");
    if (root.code !== "00000") throw new Error(`Bitget ticker response rejected: ${String(root.code)}.`);
    const rows = array(root.data, "Bitget ticker list").map((item) => record(item, "Bitget ticker"))
      .filter((item) => item.category === category && item.symbol === symbol);
    if (rows.length !== 1) throw new Error("Bitget ticker identity is unavailable or ambiguous.");
    const fetchedAt = clock();
    if (!Number.isSafeInteger(fetchedAt) || fetchedAt < 0) throw new Error("Bitget ticker clock is invalid.");
    return Object.freeze({ category, symbol, bid: positiveDecimal(rows[0]!.bid1Price, "Bitget bid1Price"),
      ask: positiveDecimal(rows[0]!.ask1Price, "Bitget ask1Price"), fetchedAt });
  };
}
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`); return value as Record<string, unknown>; }
function array(value: unknown, label: string) { if (!Array.isArray(value)) throw new Error(`${label} is invalid.`); return value; }
function positiveDecimal(value: unknown, label: string) { if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) throw new Error(`${label} is invalid.`); return value; }
