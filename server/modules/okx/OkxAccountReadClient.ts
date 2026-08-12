import { createHmac } from "node:crypto";

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

  constructor(
    private readonly credentials: OkxAccountReadCredentials,
    options: OkxAccountReadClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? OKX_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async readAccountSnapshot(): Promise<OkxAccountReadSnapshot> {
    const [balancePayload, configPayload] = await Promise.all([
      this.get("/api/v5/account/balance"),
      this.get("/api/v5/account/config"),
    ]);
    const balance = requiredFirstRecord(balancePayload.data, "OKX account balance");
    const config = requiredFirstRecord(configPayload.data, "OKX account config");
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

  private async get(path: string): Promise<OkxResponse> {
    const timestamp = new Date(this.now()).toISOString();
    const signature = createHmac("sha256", this.credentials.apiSecret)
      .update(`${timestamp}GET${path}`)
      .digest("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
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
      payload = await response.json() as OkxResponse;
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
