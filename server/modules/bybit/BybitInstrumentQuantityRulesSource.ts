import { tracedProviderFetch, tracedProviderJson } from "../cex/ProviderRequestTrace";
import type { BybitQuantityRulesSnapshot, BybitQuantityRulesSource } from "./BybitQuantitySemantics";
import type { BybitCategory } from "./BybitTypes";

const BYBIT_API_BASE_URL = "https://api.bybit.com";

export type BybitInstrumentQuantityRulesSourceOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
}>;

export function createBybitInstrumentQuantityRulesSource(
  options: BybitInstrumentQuantityRulesSourceOptions = {},
): BybitQuantityRulesSource {
  const baseUrl = options.baseUrl ?? BYBIT_API_BASE_URL;
  const fetchImpl = tracedProviderFetch("bybit", options.fetchImpl ?? fetch);
  const clock = options.clock ?? Date.now;
  const timeoutMs = positiveSafeInteger(options.timeoutMs ?? 5_000, "Bybit quantity rules timeoutMs");

  return async (categoryInput, symbolInput) => {
    const category = bybitCategory(categoryInput);
    const symbol = bybitSymbol(symbolInput);
    const url = new URL("/v5/market/instruments-info", baseUrl);
    url.searchParams.set("category", category);
    url.searchParams.set("symbol", symbol);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("Bybit quantity rules request failed.");
    }
    if (!response.ok) throw new Error(`Bybit quantity rules request failed with HTTP ${response.status}.`);
    let payload: unknown;
    try {
      payload = await tracedProviderJson(response);
    } catch {
      throw new Error("Bybit quantity rules response is not valid JSON.");
    }
    const root = record(payload, "Bybit quantity rules response");
    if (root.retCode !== 0) throw new Error(`Bybit quantity rules response rejected: ${String(root.retCode)}.`);
    const result = record(root.result, "Bybit quantity rules result");
    const rows = array(result.list, "Bybit quantity rules list")
      .map((item) => record(item, "Bybit quantity rules instrument"))
      .filter((item) => item.symbol === symbol);
    if (!rows.length) return null;
    if (rows.length !== 1) throw new Error("Bybit quantity rules response instrument identity is ambiguous.");
    return snapshot(rows[0]!, category, fetchedAt(clock()));
  };
}

function snapshot(row: Record<string, unknown>, category: BybitCategory, fetchedAtValue: number): BybitQuantityRulesSnapshot {
  const lot = record(row.lotSizeFilter, "Bybit lotSizeFilter");
  return Object.freeze({
    category,
    symbol: requiredString(row.symbol, "Bybit quantity rules symbol"),
    status: requiredString(row.status, "Bybit quantity rules status"),
    baseCoin: requiredString(row.baseCoin, "Bybit quantity rules baseCoin"),
    quoteCoin: requiredString(row.quoteCoin, "Bybit quantity rules quoteCoin"),
    settleCoin: category === "linear" ? requiredString(row.settleCoin, "Bybit quantity rules settleCoin") : null,
    qtyStep: requiredString(lot.qtyStep ?? lot.basePrecision, "Bybit quantity rules qtyStep"),
    minOrderQty: requiredString(lot.minOrderQty ?? lot.basePrecision, "Bybit quantity rules minOrderQty"),
    minNotionalValue: optionalString(lot.minNotionalValue ?? lot.minOrderAmt),
    fetchedAt: fetchedAtValue,
  });
}

function bybitCategory(value: unknown): BybitCategory {
  if (value !== "spot" && value !== "linear") throw new Error("Bybit quantity rules category is invalid.");
  return value;
}

function bybitSymbol(value: unknown) {
  const symbol = requiredString(value, "Bybit quantity rules symbol");
  if (!/^[A-Z0-9]{4,24}$/u.test(symbol)) throw new Error("Bybit quantity rules symbol is invalid.");
  return symbol;
}

function fetchedAt(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Bybit quantity rules clock is invalid.");
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid.`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredString(value: unknown, label: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 200) throw new Error(`${label} is invalid.`);
  return text;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
