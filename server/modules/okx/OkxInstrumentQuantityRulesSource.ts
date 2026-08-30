import { tracedProviderFetch, tracedProviderJson } from "../cex/ProviderRequestTrace";
import type {
  OkxQuantityRulesSnapshot,
  OkxQuantityRulesSource,
} from "./OkxQuantitySemantics";

const OKX_API_BASE_URL = "https://www.okx.com";

export type OkxInstrumentQuantityRulesSourceOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
}>;

/** Public OKX instrument facts for explicit injection into the execution runtime. */
export function createOkxInstrumentQuantityRulesSource(
  options: OkxInstrumentQuantityRulesSourceOptions = {},
): OkxQuantityRulesSource {
  const baseUrl = options.baseUrl ?? OKX_API_BASE_URL;
  const fetchImpl = tracedProviderFetch("okx", options.fetchImpl ?? fetch);
  const clock = options.clock ?? Date.now;
  const timeoutMs = positiveSafeInteger(options.timeoutMs ?? 5_000, "OKX quantity rules timeoutMs");

  return async (inputInstId: string) => {
    const instId = okxSwapInstrumentId(inputInstId);
    const url = new URL("/api/v5/public/instruments", baseUrl);
    url.searchParams.set("instType", "SWAP");
    url.searchParams.set("instId", instId);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("OKX quantity rules request failed.");
    }
    if (!response.ok) {
      throw new Error(`OKX quantity rules request failed with HTTP ${response.status}.`);
    }

    let payload: unknown;
    try {
      payload = await tracedProviderJson(response);
    } catch {
      throw new Error("OKX quantity rules response is not valid JSON.");
    }
    const value = record(payload, "OKX quantity rules response");
    const code = requiredString(value.code, "OKX quantity rules response code");
    if (code !== "0") throw new Error(`OKX quantity rules response rejected: ${code}.`);
    const data = array(value.data, "OKX quantity rules response data");
    if (data.length === 0) return null;

    const rows = data.map((item) => record(item, "OKX quantity rules instrument"));
    const matching = rows.filter((row) => row.instId === instId);
    if (matching.length !== 1) {
      throw new Error("OKX quantity rules response instrument identity does not match the request.");
    }
    return snapshotFromRow(matching[0]!, fetchedAt(clock()));
  };
}

function snapshotFromRow(
  row: Record<string, unknown>,
  fetchedAtValue: number,
): OkxQuantityRulesSnapshot {
  const instType = requiredString(row.instType, "OKX quantity rules instType");
  if (instType !== "SWAP") {
    throw new Error("OKX quantity rules response instrument identity does not match the request.");
  }
  return Object.freeze({
    instType,
    instId: requiredString(row.instId, "OKX quantity rules instId"),
    uly: requiredString(row.uly, "OKX quantity rules uly"),
    ctType: requiredString(row.ctType, "OKX quantity rules ctType"),
    ctValCcy: requiredString(row.ctValCcy, "OKX quantity rules ctValCcy"),
    settleCcy: requiredString(row.settleCcy, "OKX quantity rules settleCcy"),
    lotSz: requiredString(row.lotSz, "OKX quantity rules lotSz"),
    minSz: requiredString(row.minSz, "OKX quantity rules minSz"),
    ctVal: requiredString(row.ctVal, "OKX quantity rules ctVal"),
    state: requiredString(row.state, "OKX quantity rules state"),
    fetchedAt: fetchedAtValue,
  });
}

function okxSwapInstrumentId(value: unknown) {
  const instId = requiredString(value, "OKX quantity rules instId");
  if (!/^[A-Z0-9]{2,12}-USDT-SWAP$/u.test(instId)) {
    throw new Error("OKX quantity rules instId must be a USDT linear perpetual swap.");
  }
  return instId;
}

function fetchedAt(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("OKX quantity rules clock is invalid.");
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
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
