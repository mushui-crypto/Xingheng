import { HttpRequestError, requestJson } from "./httpClient";

export type ExchangeVenue = "binance" | "bybit" | "bitget" | "okx";

export type ExchangeCredentialSummary = {
  venue: ExchangeVenue;
  configured: boolean;
  implemented: boolean;
  accountId: string | null;
  accountFingerprint: string | null;
  maskedApiKey: string | null;
  permissions: Record<string, boolean>;
  lastVerifiedAt: number | null;
  message: string | null;
};

export type SaveExchangeCredentialInput = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
};

const requestOptions = {
  userAuthFailure: true,
  init: {
    cache: "no-store" as const,
    headers: { Accept: "application/json" },
  },
};

export function fetchExchangeCredentials(signal?: AbortSignal) {
  return requestJson<unknown>(
    "/api/exchange-credentials",
    "交易所 API 配置加载失败。",
    { ...requestOptions, init: { ...requestOptions.init, signal } },
  ).then((payload) => Array.isArray(payload)
    ? payload.map((item) => normalizeExchangeCredentialSummary(item)).filter((item): item is ExchangeCredentialSummary => item !== null)
    : []);
}

export function saveExchangeCredential(venue: ExchangeVenue, input: SaveExchangeCredentialInput) {
  return requestJson<unknown>(
    `/api/exchange-credentials/${venue}`,
    "交易所 API 配置保存失败。",
    {
      ...requestOptions,
      init: {
        ...requestOptions.init,
        method: "PUT",
        headers: { ...requestOptions.init.headers, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    },
  ).then((payload) => requireCredentialSummary(payload, venue))
    .catch((error: unknown) => { throw presentExchangeCredentialError(error); });
}

export function deleteExchangeCredential(venue: ExchangeVenue) {
  return requestJson<unknown>(
    `/api/exchange-credentials/${venue}`,
    "交易所 API 配置删除失败。",
    { ...requestOptions, init: { ...requestOptions.init, method: "DELETE" } },
  ).then((payload) => requireCredentialSummary(payload, venue))
    .catch((error: unknown) => { throw presentExchangeCredentialError(error); });
}

export function normalizeExchangeCredentialSummary(payload: unknown): ExchangeCredentialSummary | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (!isVenue(value.venue)) return null;
  return {
    venue: value.venue,
    configured: value.configured === true,
    implemented: value.implemented === true,
    accountId: nullableString(value.accountId),
    accountFingerprint: nullableString(value.accountFingerprint),
    maskedApiKey: nullableString(value.maskedApiKey),
    permissions: booleanRecord(value.permissions),
    lastVerifiedAt: typeof value.lastVerifiedAt === "number" && Number.isFinite(value.lastVerifiedAt) ? value.lastVerifiedAt : null,
    message: nullableString(value.message),
  };
}

function requireCredentialSummary(payload: unknown, venue: ExchangeVenue) {
  const summary = normalizeExchangeCredentialSummary(payload);
  if (!summary || summary.venue !== venue) throw new Error("交易所 API 配置响应无效。");
  return summary;
}

function isVenue(value: unknown): value is ExchangeVenue {
  return value === "binance" || value === "bybit" || value === "bitget" || value === "okx";
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function booleanRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
}

export function presentExchangeCredentialError(error: unknown) {
  if (error instanceof HttpRequestError) {
    if (error.category?.startsWith("credential_key_")) {
      return new Error("凭证加密服务当前不可用，请等待 KMS/WIF 恢复后重试；无需在交易所重新创建 API Key。");
    }
    if (error.category === "credential_input_invalid") {
      return new Error(error.message || "API Key、Secret 或 Passphrase 格式不正确。");
    }
    if (error.category === "credential_already_configured") {
      return new Error(error.message || "该交易所已配置 API 凭证，请先删除旧配置。");
    }
  }
  return error instanceof Error ? error : new Error("交易所 API 配置请求失败。");
}
