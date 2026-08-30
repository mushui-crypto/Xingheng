import { tracedProviderFetch, tracedProviderJson } from "../cex/ProviderRequestTrace";
import { decimalStepFromPrecision } from "../cex/TradingRules";
import type { BitgetQuantityRulesSource } from "./BitgetQuantitySemantics";

const BITGET_API_BASE_URL = "https://api.bitget.com";

export type BitgetInstrumentQuantityRulesSourceOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
}>;

export function createBitgetInstrumentQuantityRulesSource(
  options: BitgetInstrumentQuantityRulesSourceOptions = {},
): BitgetQuantityRulesSource {
  const baseUrl = options.baseUrl ?? BITGET_API_BASE_URL;
  const fetchImpl = tracedProviderFetch("bitget", options.fetchImpl ?? fetch);
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (category, symbol) => {
    const url = new URL("/api/v3/market/instruments", baseUrl);
    url.searchParams.set("category", category);
    url.searchParams.set("symbol", symbol);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Bitget instrument request failed: ${response.status}.`);
    const payload = record(await tracedProviderJson(response), "Bitget instrument response");
    if (payload.code !== "00000") throw new Error(`Bitget instrument response rejected: ${String(payload.code)}.`);
    const rows = array(payload.data, "Bitget instrument data").map((item) => record(item, "Bitget instrument"));
    const matches = rows.filter((row) => row.symbol === symbol);
    if (matches.length !== 1) throw new Error("Bitget instrument response does not uniquely match the symbol.");
    const row = matches[0]!;
    const quantityStep = optionalString(row.quantityMultiplier)
      ?? decimalStepFromPrecision(requiredString(row.quantityPrecision, "Bitget quantityPrecision"), "Bitget quantityPrecision");
    return Object.freeze({
      category,
      symbol,
      status: normalizeStatus(requiredString(row.status, "Bitget instrument status")),
      baseCoin: asset(row.baseCoin, "Bitget baseCoin"),
      quoteCoin: asset(row.quoteCoin, "Bitget quoteCoin"),
      quantityStep,
      minOrderQty: decimal(row.minOrderQty, "Bitget minOrderQty"),
      minNotional: optionalDecimal(row.minOrderAmount, "Bitget minOrderAmount"),
      // UTA v3 defines both Spot limit size and USDT-FUTURES size in base coin.
      contractSize: "1",
      quantityUnit: "base" as const,
      fetchedAt: clock(),
    });
  };
}

function normalizeStatus(value: string) {
  const normalized = value.toLowerCase();
  return normalized === "online" || normalized === "live" ? "online" : normalized;
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
  if (!text) throw new Error(`${label} is invalid.`);
  return text;
}
function optionalString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function decimal(value: unknown, label: string) {
  const text = requiredString(value, label);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}
function optionalDecimal(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  return decimal(value, label);
}
function asset(value: unknown, label: string) {
  const text = requiredString(value, label).toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/u.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}
