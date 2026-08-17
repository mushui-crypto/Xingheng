import type { OkxSpotQuantityRulesSource, OkxSpotQuantityRulesSnapshot } from "./OkxSpotQuantitySemantics";

const OKX_API_BASE_URL = "https://www.okx.com";

export function createOkxSpotInstrumentQuantityRulesSource(options: Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
}> = {}): OkxSpotQuantityRulesSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? OKX_API_BASE_URL;
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("OKX Spot quantity rules timeoutMs is invalid.");
  return async (requestedInstId) => {
    if (!/^[A-Z0-9]{2,12}-USDT$/u.test(requestedInstId)) throw new Error("OKX Spot quantity rules instId is invalid.");
    const url = new URL("/api/v5/public/instruments", baseUrl);
    url.searchParams.set("instType", "SPOT");
    url.searchParams.set("instId", requestedInstId);
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new Error("OKX Spot quantity rules request failed."); }
    if (!response.ok) throw new Error(`OKX Spot quantity rules request failed with HTTP ${response.status}.`);
    const payload = await response.json().catch(() => { throw new Error("OKX Spot quantity rules response is not valid JSON."); });
    const root = object(payload, "OKX Spot quantity rules response");
    if (text(root.code, "OKX Spot quantity rules response code") !== "0") throw new Error("OKX Spot quantity rules response was rejected.");
    const data = root.data;
    if (!Array.isArray(data)) throw new Error("OKX Spot quantity rules response data is invalid.");
    const rows = data.map((row) => object(row, "OKX Spot quantity rules instrument"));
    const matching = rows.filter((row) => row.instId === requestedInstId);
    if (!matching.length) return null;
    if (matching.length !== 1) throw new Error("OKX Spot quantity rules response instrument identity does not match the request.");
    const row = matching[0]!;
    const fetchedAt = clock();
    if (!Number.isSafeInteger(fetchedAt) || fetchedAt < 0) throw new Error("OKX Spot quantity rules clock is invalid.");
    return Object.freeze({
      instType: literal(row.instType, "SPOT", "OKX Spot quantity rules instType"),
      instId: text(row.instId, "OKX Spot quantity rules instId"),
      baseCcy: text(row.baseCcy, "OKX Spot quantity rules baseCcy"),
      quoteCcy: text(row.quoteCcy, "OKX Spot quantity rules quoteCcy"),
      lotSz: text(row.lotSz, "OKX Spot quantity rules lotSz"),
      minSz: text(row.minSz, "OKX Spot quantity rules minSz"),
      tickSz: text(row.tickSz, "OKX Spot quantity rules tickSz"),
      state: text(row.state, "OKX Spot quantity rules state"),
      fetchedAt,
    } satisfies OkxSpotQuantityRulesSnapshot);
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > 200) throw new Error(`${label} is invalid.`);
  return result;
}
function literal(value: unknown, expected: "SPOT", label: string) {
  if (value !== expected) throw new Error(`${label} is invalid.`);
  return expected;
}
