import { tracedProviderFetch, tracedProviderJson } from "../cex/ProviderRequestTrace";
import { createHash, createHmac } from "node:crypto";

const OKX_API_BASE_URL = "https://www.okx.com";

export type OkxAccountReadCredentials = {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
};

export type OkxAccountBalance = {
  asset: string;
  total: number;
  available: number;
  locked: number;
};

export type OkxAccountReadSnapshot = {
  uid: string;
  accountLevel: string;
  permissions: string | null;
  boundIps: string | null;
  balances: OkxAccountBalance[];
  fetchedAt: number;
};

export type OkxPerpetualPositionSnapshot = {
  instId: string;
  side: "long" | "short" | "flat";
  contractQuantity: string;
  updatedAt: number | null;
};

type OkxAccountReadClientOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}>;

type OkxResponse = {
  code?: string;
  msg?: string;
  data?: unknown[];
};

export class OkxAccountReadError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export class OkxAccountReadClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private accountConfigRead: Promise<Record<string, unknown>> | null = null;

  constructor(
    private readonly credentials: OkxAccountReadCredentials,
    options: OkxAccountReadClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? OKX_API_BASE_URL;
    this.fetchImpl = tracedProviderFetch("okx", options.fetchImpl ?? fetch);
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async readAccountSnapshot(): Promise<OkxAccountReadSnapshot> {
    const [balancePayload, config] = await Promise.all([
      this.get("/api/v5/account/balance"),
      this.readAccountConfig(),
    ]);
    const balance = requiredFirstRecord(balancePayload.data, "OKX account balance");
    const uid = requiredString(config.uid, "OKX uid");
    const accountLevel = requiredString(config.acctLv, "OKX acctLv");
    const balances = list(balance.details)
      .map((value) => requiredRecord(value, "OKX balance detail"))
      .map((detail) => ({
        asset: requiredString(detail.ccy, "OKX balance currency").toUpperCase(),
        total: finiteNumber(detail.cashBal, "OKX cashBal"),
        available: finiteNumber(detail.availBal, "OKX availBal"),
        locked: finiteNumber(detail.frozenBal, "OKX frozenBal"),
      }))
      .filter((item) => item.total !== 0 || item.available !== 0 || item.locked !== 0);
    return {
      uid,
      accountLevel,
      permissions: optionalString(config.perm),
      boundIps: typeof config.ip === "string" ? config.ip : null,
      balances,
      fetchedAt: this.now(),
    };
  }

  async readAccountIdentity(): Promise<Readonly<{ accountId: string }>> {
    const config = await this.readAccountConfig();
    const uid = requiredString(config.uid, "OKX uid");
    const uidHash = createHash("sha256").update(`okx:${uid}`).digest("hex");
    return Object.freeze({ accountId: `okx:${uidHash.slice(0, 16)}` });
  }

  async readPositionMode(): Promise<"ONE_WAY" | "HEDGE"> {
    const config = await this.readAccountConfig();
    const positionMode = requiredString(config.posMode, "OKX position mode");
    if (positionMode === "net_mode") return "ONE_WAY";
    if (positionMode === "long_short_mode") return "HEDGE";
    throw new OkxAccountReadError("provider_response_invalid", "OKX position mode is unsupported.");
  }

  private readAccountConfig() {
    return this.accountConfigRead ??= this.get("/api/v5/account/config")
      .then((payload) => requiredFirstRecord(payload.data, "OKX account config"));
  }

  async readPerpetualPosition(
    instId: string,
    expectedSide?: "long" | "short",
  ): Promise<OkxPerpetualPositionSnapshot> {
    const normalizedInstId = requiredString(instId, "OKX position instId");
    const payload = await this.get("/api/v5/account/positions", { instId: normalizedInstId });
    const rows = payload.data?.map((value) => requiredRecord(value, "OKX position")) ?? [];
    const matching = rows.filter((row) => optionalString(row.instId) === normalizedInstId);
    if (!matching.length) {
      if (rows.length) {
        throw new OkxAccountReadError("provider_response_invalid", "OKX position instrument does not match the request.");
      }
      return { instId: normalizedInstId, side: "flat", contractQuantity: "0", updatedAt: null };
    }
    const nonZero = matching.filter((row) => decimalMagnitude(row.pos, "OKX position quantity") !== "0");
    const sideMatched = expectedSide
      ? nonZero.filter((row) => optionalString(row.posSide)?.toLowerCase() === expectedSide)
      : nonZero;
    if (sideMatched.length > 1 || (!expectedSide && nonZero.length > 1)
      || (expectedSide !== undefined && nonZero.length > 1 && sideMatched.length === 0)) {
      throw new OkxAccountReadError("provider_response_invalid", "OKX returned multiple non-zero position sides.");
    }
    const row = sideMatched[0] ?? (nonZero.length <= 1 ? nonZero[0] : undefined) ?? matching[0]!;
    const signed = finiteNumber(row.pos, "OKX position quantity");
    const positionSide = optionalString(row.posSide)?.toLowerCase() ?? null;
    const side = okxPositionSide(signed, positionSide);
    return {
      instId: normalizedInstId,
      side,
      contractQuantity: decimalMagnitude(row.pos, "OKX position quantity"),
      updatedAt: optionalTimestamp(row.uTime),
    };
  }

  private async get(path: string, query: Readonly<Record<string, string>> = {}): Promise<OkxResponse> {
    const queryString = new URLSearchParams(
      Object.entries(query).sort(([left], [right]) => left.localeCompare(right)),
    ).toString();
    const requestPath = queryString ? `${path}?${queryString}` : path;
    const timestamp = new Date(this.now()).toISOString();
    const signature = createHmac("sha256", this.credentials.apiSecret)
      .update(`${timestamp}GET${requestPath}`)
      .digest("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(requestPath, this.baseUrl), {
        method: "GET",
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.passphrase,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new OkxAccountReadError("provider_read_failed", "OKX account read request failed.");
    }
    if (!response.ok) {
      throw new OkxAccountReadError("provider_read_failed", `OKX account read request failed: ${response.status}.`);
    }
    let payload: OkxResponse;
    try {
      payload = await tracedProviderJson(response) as OkxResponse;
    } catch {
      throw new OkxAccountReadError("provider_response_invalid", "OKX account read response is not valid JSON.");
    }
    if (payload.code !== "0") {
      const category = isAuthenticationCode(payload.code)
        ? "credential_validation_failed"
        : "provider_read_failed";
      throw new OkxAccountReadError(category, `OKX account read rejected: ${payload.code ?? "unknown"}.`);
    }
    if (!Array.isArray(payload.data)) {
      throw new OkxAccountReadError("provider_response_invalid", "OKX account read response data is invalid.");
    }
    return payload;
  }
}

function okxPositionSide(signedQuantity: number, positionSide: string | null) {
  if (signedQuantity === 0) return "flat" as const;
  if (positionSide === "long") return "long" as const;
  if (positionSide === "short") return "short" as const;
  if (positionSide === "net") return signedQuantity > 0 ? "long" as const : "short" as const;
  throw new OkxAccountReadError("provider_response_invalid", "OKX position side is unknown.");
}

function decimalMagnitude(value: unknown, label: string) {
  const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(raw)) {
    throw new OkxAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  return normalizeDecimal(raw.startsWith("-") ? raw.slice(1) : raw);
}

function normalizeDecimal(value: string) {
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
}

function optionalTimestamp(value: unknown) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function isAuthenticationCode(code: string | undefined) {
  return code === "50101" || code === "50102" || code === "50111"
    || code === "50113" || code === "50114" || code === "50115";
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new OkxAccountReadError("provider_response_invalid", "OKX balance details are invalid.");
  }
  return value;
}

function requiredFirstRecord(value: unknown[] | undefined, label: string) {
  if (!value?.length) throw new OkxAccountReadError("provider_response_invalid", `${label} is empty.`);
  return requiredRecord(value[0], label);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OkxAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new OkxAccountReadError("provider_response_invalid", `${label} is invalid.`);
  return result;
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value.trim() : null;
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new OkxAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new OkxAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  return result;
}
