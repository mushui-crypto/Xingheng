import { HttpRequestError, requestJson } from "./httpClient";
import type { ExchangeVenue } from "./exchangeCredentials";

export type AccountReadAccountType = "spot" | "derivatives" | "unified" | "unknown";
export type AccountReadPermissionStatus = "ENABLED" | "DISABLED" | "UNKNOWN";

export type AccountReadBalance = {
  asset: string;
  accountType: AccountReadAccountType;
  total: number;
  available: number | null;
  locked: number | null;
  estimatedValueUsdt: number | null;
  valuationStatus: "VALUED" | "UNAVAILABLE";
};

export type AccountReadSnapshot = {
  venue: ExchangeVenue;
  accountId: string;
  accountFingerprint: string;
  accountTypes: AccountReadAccountType[];
  accountMode: string | null;
  connection: { status: "connected"; checkedAt: number };
  credentialValidation: { status: "validated"; checkedAt: number };
  balances: AccountReadBalance[];
  permissions: {
    read: AccountReadPermissionStatus;
    spotTrade: AccountReadPermissionStatus;
    derivativesTrade: AccountReadPermissionStatus;
    withdraw: AccountReadPermissionStatus;
    ipRestricted: AccountReadPermissionStatus;
  };
  latestSyncAt: number;
  estimatedTotalValueUsdt: number | null;
  valuationCoverage: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
};

export type AccountReadFailureKind = "missing_credential" | "validation_failed" | "provider_failed" | "unavailable";

export class AccountReadRequestError extends Error {
  constructor(readonly kind: AccountReadFailureKind, message: string) {
    super(message);
  }
}

export async function fetchAccountRead(venue: ExchangeVenue, signal?: AbortSignal) {
  try {
    const payload = await requestJson<unknown>(
      `/api/account-read/${venue}`,
      "账户读取暂时不可用。",
      {
        userAuthFailure: true,
        init: { cache: "no-store", headers: { Accept: "application/json" }, signal },
      },
    );
    return requireAccountReadSnapshot(payload, venue);
  } catch (error) {
    throw presentAccountReadError(error);
  }
}

export function presentAccountReadError(error: unknown) {
  if (error instanceof AccountReadRequestError) return error;
  if (error instanceof HttpRequestError) {
    if (error.category === "credential_not_configured") {
      return new AccountReadRequestError("missing_credential", "尚未配置账户凭证");
    }
    if (error.category === "credential_validation_failed") {
      return new AccountReadRequestError("validation_failed", "账户凭证验证失败");
    }
    if (error.category?.startsWith("credential_key_")) {
      return new AccountReadRequestError("unavailable", "凭证服务暂时不可用");
    }
    if (error.status >= 500) {
      return new AccountReadRequestError("provider_failed", "交易所账户读取失败");
    }
  }
  return new AccountReadRequestError("unavailable", "账户读取暂时不可用");
}

export function requireAccountReadSnapshot(payload: unknown, venue: ExchangeVenue): AccountReadSnapshot {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalidResponse();
  const value = payload as Record<string, unknown>;
  if (value.venue !== venue) throw invalidResponse();
  const connection = record(value.connection);
  const credentialValidation = record(value.credentialValidation);
  const permissions = record(value.permissions);
  const balances = Array.isArray(value.balances) ? value.balances.map(accountBalance) : null;
  const accountTypes = Array.isArray(value.accountTypes) ? value.accountTypes.filter(isAccountType) : null;
  if (!connection || connection.status !== "connected" || !credentialValidation
    || credentialValidation.status !== "validated" || !permissions || !balances || !accountTypes) {
    throw invalidResponse();
  }
  return {
    venue,
    accountId: requiredString(value.accountId),
    accountFingerprint: requiredString(value.accountFingerprint),
    accountTypes,
    accountMode: nullableString(value.accountMode),
    connection: { status: "connected", checkedAt: finiteNumber(connection.checkedAt) },
    credentialValidation: { status: "validated", checkedAt: finiteNumber(credentialValidation.checkedAt) },
    balances,
    permissions: {
      read: permission(permissions.read),
      spotTrade: permission(permissions.spotTrade),
      derivativesTrade: permission(permissions.derivativesTrade),
      withdraw: permission(permissions.withdraw),
      ipRestricted: permission(permissions.ipRestricted),
    },
    latestSyncAt: finiteNumber(value.latestSyncAt),
    estimatedTotalValueUsdt: nullableFiniteNumber(value.estimatedTotalValueUsdt),
    valuationCoverage: valuationCoverage(value.valuationCoverage),
  };
}

function accountBalance(value: unknown): AccountReadBalance {
  const balance = record(value);
  if (!balance || !isAccountType(balance.accountType)) throw invalidResponse();
  return {
    asset: requiredString(balance.asset),
    accountType: balance.accountType,
    total: finiteNumber(balance.total),
    available: nullableFiniteNumber(balance.available),
    locked: nullableFiniteNumber(balance.locked),
    estimatedValueUsdt: nullableFiniteNumber(balance.estimatedValueUsdt),
    valuationStatus: balance.valuationStatus === "VALUED" ? "VALUED" : "UNAVAILABLE",
  };
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw invalidResponse();
  return value;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function finiteNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidResponse();
  return value;
}

function nullableFiniteNumber(value: unknown) {
  return value === null || value === undefined ? null : finiteNumber(value);
}

function permission(value: unknown): AccountReadPermissionStatus {
  return value === "ENABLED" || value === "DISABLED" ? value : "UNKNOWN";
}

function valuationCoverage(value: unknown): AccountReadSnapshot["valuationCoverage"] {
  return value === "COMPLETE" || value === "PARTIAL" ? value : "UNAVAILABLE";
}

function isAccountType(value: unknown): value is AccountReadAccountType {
  return value === "spot" || value === "derivatives" || value === "unified" || value === "unknown";
}

function invalidResponse(): AccountReadRequestError {
  return new AccountReadRequestError("unavailable", "账户数据响应无效");
}
