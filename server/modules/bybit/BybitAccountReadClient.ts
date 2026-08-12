import { createHmac } from "node:crypto";
import type { AccountReadAccountType } from "../account-read/AccountReadTypes";

const BYBIT_API_BASE_URL = "https://api.bybit.com";
const RECV_WINDOW = "5000";

export type BybitAccountReadCredentials = {
  apiKey: string;
  apiSecret: string;
};

export type BybitAccountBalance = {
  asset: string;
  accountType: AccountReadAccountType;
  total: number;
  available: number | null;
  locked: number | null;
};

export type BybitAccountReadSnapshot = {
  uid: string;
  unifiedMarginStatus: number;
  marginMode: string | null;
  readOnly: number | null;
  permissions: Record<string, string[] | null> | null;
  boundIps: string[] | null;
  balances: BybitAccountBalance[];
  fetchedAt: number;
};

type BybitAccountReadClientOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}>;

type BybitResponse = {
  retCode?: number;
  retMsg?: string;
  result?: unknown;
};

export class BybitAccountReadError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export class BybitAccountReadClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentials: BybitAccountReadCredentials,
    options: BybitAccountReadClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? BYBIT_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async readAccountSnapshot(): Promise<BybitAccountReadSnapshot> {
    const [apiKeyPayload, accountPayload] = await Promise.all([
      this.get("/v5/user/query-api"),
      this.get("/v5/account/info"),
    ]);
    const apiKey = requiredRecord(apiKeyPayload.result, "Bybit API key information");
    const account = requiredRecord(accountPayload.result, "Bybit account information");
    const unifiedMarginStatus = integer(account.unifiedMarginStatus, "Bybit unifiedMarginStatus");
    const balances = unifiedMarginStatus === 1
      ? await this.readClassicBalances()
      : await this.readUnifiedBalances();

    return {
      uid: requiredIdentifier(apiKey.userID, "Bybit userID"),
      unifiedMarginStatus,
      marginMode: optionalString(account.marginMode),
      readOnly: optionalInteger(apiKey.readOnly),
      permissions: optionalPermissions(apiKey.permissions),
      boundIps: optionalStringArray(apiKey.ips),
      balances,
      fetchedAt: this.now(),
    };
  }

  private async readUnifiedBalances(): Promise<BybitAccountBalance[]> {
    const payload = await this.get("/v5/account/wallet-balance", { accountType: "UNIFIED" });
    const result = requiredRecord(payload.result, "Bybit wallet balance result");
    const account = requiredFirstRecord(result.list, "Bybit wallet balance");
    const coins = requiredList(account.coin, "Bybit wallet coins")
      .map((value) => requiredRecord(value, "Bybit wallet coin"))
      .map((coin) => ({
        asset: requiredString(coin.coin, "Bybit wallet coin asset").toUpperCase(),
        total: finiteNumber(coin.walletBalance, "Bybit walletBalance"),
        locked: optionalFiniteNumber(coin.locked, "Bybit locked"),
      }))
      .filter((coin) => coin.total !== 0 || (coin.locked !== null && coin.locked !== 0));
    return coins.map((coin) => ({ ...coin, accountType: "unified" as const, available: null }));
  }

  private async readClassicBalances(): Promise<BybitAccountBalance[]> {
    const accountTypes = [
      ["SPOT", "spot"],
      ["CONTRACT", "derivatives"],
    ] as const;
    const responses = await Promise.all(accountTypes.map(async ([accountType, mappedType]) => {
      const payload = await this.get("/v5/asset/transfer/query-account-coins-balance", { accountType });
      const result = requiredRecord(payload.result, `Bybit ${accountType} balance result`);
      return requiredList(result.balance, `Bybit ${accountType} balances`)
        .map((value) => requiredRecord(value, `Bybit ${accountType} balance`))
        .map((balance) => ({
          asset: requiredString(balance.coin, `Bybit ${accountType} balance asset`).toUpperCase(),
          accountType: mappedType,
          total: finiteNumber(balance.walletBalance, `Bybit ${accountType} walletBalance`),
          available: null,
          locked: null,
        }))
        .filter((balance) => balance.total !== 0);
    }));
    return responses.flat();
  }

  private async get(path: string, query: Readonly<Record<string, string>> = {}): Promise<BybitResponse> {
    const queryString = new URLSearchParams(
      Object.entries(query).sort(([left], [right]) => left.localeCompare(right)),
    ).toString();
    const timestamp = String(this.now());
    const signature = createHmac("sha256", this.credentials.apiSecret)
      .update(`${timestamp}${this.credentials.apiKey}${RECV_WINDOW}${queryString}`)
      .digest("hex");
    const url = new URL(path, this.baseUrl);
    url.search = queryString;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          "X-BAPI-API-KEY": this.credentials.apiKey,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": RECV_WINDOW,
          "X-BAPI-SIGN": signature,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BybitAccountReadError("provider_read_failed", "Bybit account read request failed.");
    }
    if (!response.ok) {
      throw new BybitAccountReadError("provider_read_failed", `Bybit account read request failed: ${response.status}.`);
    }
    let payload: BybitResponse;
    try {
      payload = await response.json() as BybitResponse;
    } catch {
      throw new BybitAccountReadError("provider_response_invalid", "Bybit account read response is not valid JSON.");
    }
    if (payload.retCode !== 0) {
      const category = isAuthenticationCode(payload.retCode)
        ? "credential_validation_failed"
        : "provider_read_failed";
      throw new BybitAccountReadError(category, `Bybit account read rejected: ${payload.retCode ?? "unknown"}.`);
    }
    return payload;
  }
}

function isAuthenticationCode(code: number | undefined) {
  return code === 10002 || code === 10003 || code === 10004 || code === 10005 || code === 33004;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BybitAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredFirstRecord(value: unknown, label: string) {
  const values = requiredList(value, label);
  if (!values.length) throw new BybitAccountReadError("provider_response_invalid", `${label} is empty.`);
  return requiredRecord(values[0], label);
}

function requiredList(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new BybitAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  return value;
}

function requiredString(value: unknown, label: string) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new BybitAccountReadError("provider_response_invalid", `${label} is invalid.`);
  return result;
}

function requiredIdentifier(value: unknown, label: string) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return requiredString(value, label);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown, label: string) {
  if ((typeof value !== "string" && typeof value !== "number") || value === "") {
    throw new BybitAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  const result = Number(value);
  if (!Number.isInteger(result)) throw new BybitAccountReadError("provider_response_invalid", `${label} is invalid.`);
  return result;
}

function optionalInteger(value: unknown) {
  if ((typeof value !== "string" && typeof value !== "number") || value === "") return null;
  const result = Number(value);
  return Number.isInteger(result) ? result : null;
}

function finiteNumber(value: unknown, label: string) {
  if ((typeof value !== "string" && typeof value !== "number") || value === "") {
    throw new BybitAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new BybitAccountReadError("provider_response_invalid", `${label} is invalid.`);
  return result;
}

function optionalFiniteNumber(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  return finiteNumber(value, label);
}

function optionalStringArray(value: unknown) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BybitAccountReadError("provider_response_invalid", "Bybit IP restrictions are invalid.");
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalPermissions(value: unknown): Record<string, string[] | null> | null {
  if (value === undefined || value === null) return null;
  const record = requiredRecord(value, "Bybit permissions");
  return Object.fromEntries(Object.entries(record).map(([key, permissionValue]) => {
    if (permissionValue === undefined || permissionValue === null) return [key, null];
    if (!Array.isArray(permissionValue) || permissionValue.some((item) => typeof item !== "string")) {
      throw new BybitAccountReadError("provider_response_invalid", `Bybit ${key} permissions are invalid.`);
    }
    return [key, permissionValue];
  }));
}
