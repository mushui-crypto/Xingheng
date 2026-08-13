import { requestJson } from "./httpClient";
import type { ExchangeVenue } from "./exchangeCredentials";

export type ArbitrageInstanceStatus =
  | "OPENING"
  | "HOLDING"
  | "RESIDUAL"
  | "CLOSING"
  | "CLOSED"
  | "FAILED";

export type ArbitrageInstanceLeg = {
  legId: string;
  role: "LONG" | "SHORT";
  venue: ExchangeVenue;
  accountId: string;
  instrumentId: string;
  plannedQuantity: string;
  confirmedOpenedQuantity: string;
  confirmedClosedQuantity: string;
};

export type ArbitrageExecutionReference = {
  arbitrageId: string;
  legId: string;
  phase: "OPENING" | "ADJUSTMENT" | "CLOSING";
  quantityEffect: "INCREASE" | "DECREASE";
  executionIntentId: string;
  executionRecordId: string | null;
  requestedQuantity: string;
  confirmedQuantity: string;
  status: "CLAIMED" | "LINKED" | "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN";
  createdAt: number;
  updatedAt: number;
};

export type ArbitrageInstance = {
  arbitrageId: string;
  userId: string;
  strategyType: "PERPETUAL_PERPETUAL" | "SPOT_PERPETUAL";
  sourcePlanId: string | null;
  maxResidualBaseQuantity: string;
  status: ArbitrageInstanceStatus;
  createdAt: number;
  openedAt: number | null;
  updatedAt: number;
  closedAt: number | null;
  legs: [ArbitrageInstanceLeg, ArbitrageInstanceLeg];
  executionReferences: ArbitrageExecutionReference[];
  pnl: {
    asset: string | null;
    cumulativeFundingPnl: string | null;
    realizedTradingPnl: string | null;
    feesCosts: string | null;
    cumulativeNetPnl: string | null;
    updatedAt: number | null;
  };
};

export type ArbitrageLegVerificationStatus = "MATCHED" | "MISMATCH" | "UNKNOWN";

export type ArbitrageLegVerification = {
  arbitrageId: string;
  legId: string;
  expectedManagedQuantity: string;
  actualQuantity: string | null;
  verificationStatus: ArbitrageLegVerificationStatus;
  checkedAt: number;
};

export type ArbitragePositionVerification = {
  arbitrageId: string;
  checkedAt: number;
  legs: [ArbitrageLegVerification, ArbitrageLegVerification];
};

export async function fetchActiveArbitrageInstances(signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-instances/active",
    "套利组合加载失败，请稍后重试",
    { userAuthFailure: true, init: { cache: "no-store", signal } },
  );
  return instanceList(payload);
}

export async function fetchArbitrageInstanceHistory(page = 1, limit = 50, signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    `/api/arbitrage-instances/history?page=${page}&limit=${limit}`,
    "套利组合加载失败，请稍后重试",
    { userAuthFailure: true, init: { cache: "no-store", signal } },
  );
  return instanceList(payload);
}

export async function fetchArbitrageInstanceById(arbitrageId: string, signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    `/api/arbitrage-instances/${encodeURIComponent(arbitrageId)}`,
    "套利组合加载失败，请稍后重试",
    { userAuthFailure: true, init: { cache: "no-store", signal } },
  );
  return instance(payload);
}

export async function fetchArbitragePositionVerification(arbitrageId: string, signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    `/api/arbitrage-instances/${encodeURIComponent(arbitrageId)}/verification`,
    "当前仓位暂无法可靠确认",
    { userAuthFailure: true, init: { cache: "no-store", signal } },
  );
  return positionVerification(payload);
}

export function requireArbitrageInstanceList(payload: unknown) {
  return instanceList(payload);
}

function instanceList(payload: unknown) {
  if (!Array.isArray(payload)) throw invalidResponse();
  return payload.map(instance);
}

function instance(payload: unknown): ArbitrageInstance {
  const value = record(payload);
  if (!value || !Array.isArray(value.legs) || value.legs.length !== 2
    || !Array.isArray(value.executionReferences)) throw invalidResponse();
  const legs = value.legs.map(leg);
  if (legs[0]?.role !== "LONG" || legs[1]?.role !== "SHORT") throw invalidResponse();
  const pnl = requiredRecord(value.pnl);
  return {
    arbitrageId: requiredString(value.arbitrageId),
    userId: requiredString(value.userId),
    strategyType: strategyType(value.strategyType),
    sourcePlanId: nullableString(value.sourcePlanId),
    maxResidualBaseQuantity: decimal(value.maxResidualBaseQuantity),
    status: instanceStatus(value.status),
    createdAt: timestamp(value.createdAt),
    openedAt: nullableTimestamp(value.openedAt),
    updatedAt: timestamp(value.updatedAt),
    closedAt: nullableTimestamp(value.closedAt),
    legs: legs as [ArbitrageInstanceLeg, ArbitrageInstanceLeg],
    executionReferences: value.executionReferences.map(executionReference),
    pnl: {
      asset: nullableString(pnl.asset),
      cumulativeFundingPnl: nullableDecimal(pnl.cumulativeFundingPnl),
      realizedTradingPnl: nullableDecimal(pnl.realizedTradingPnl),
      feesCosts: nullableDecimal(pnl.feesCosts),
      cumulativeNetPnl: nullableDecimal(pnl.cumulativeNetPnl),
      updatedAt: nullableTimestamp(pnl.updatedAt),
    },
  };
}

function positionVerification(payload: unknown): ArbitragePositionVerification {
  const value = requiredRecord(payload);
  if (!Array.isArray(value.legs) || value.legs.length !== 2) throw invalidVerificationResponse();
  const legs = value.legs.map(legVerification);
  const arbitrageId = requiredString(value.arbitrageId);
  if (legs.some((item) => item.arbitrageId !== arbitrageId)) throw invalidVerificationResponse();
  return {
    arbitrageId,
    checkedAt: timestamp(value.checkedAt),
    legs: legs as [ArbitrageLegVerification, ArbitrageLegVerification],
  };
}

function legVerification(payload: unknown): ArbitrageLegVerification {
  const value = requiredRecord(payload);
  return {
    arbitrageId: requiredString(value.arbitrageId),
    legId: requiredString(value.legId),
    expectedManagedQuantity: decimal(value.expectedManagedQuantity),
    actualQuantity: nullableDecimal(value.actualQuantity),
    verificationStatus: verificationStatus(value.verificationStatus),
    checkedAt: timestamp(value.checkedAt),
  };
}

function leg(payload: unknown): ArbitrageInstanceLeg {
  const value = requiredRecord(payload);
  return {
    legId: requiredString(value.legId),
    role: value.role === "LONG" || value.role === "SHORT" ? value.role : invalidResponse(),
    venue: venue(value.venue),
    accountId: requiredString(value.accountId),
    instrumentId: requiredString(value.instrumentId),
    plannedQuantity: decimal(value.plannedQuantity),
    confirmedOpenedQuantity: decimal(value.confirmedOpenedQuantity),
    confirmedClosedQuantity: decimal(value.confirmedClosedQuantity),
  };
}

function executionReference(payload: unknown): ArbitrageExecutionReference {
  const value = requiredRecord(payload);
  return {
    arbitrageId: requiredString(value.arbitrageId),
    legId: requiredString(value.legId),
    phase: value.phase === "OPENING" || value.phase === "ADJUSTMENT" || value.phase === "CLOSING"
      ? value.phase : invalidResponse(),
    quantityEffect: value.quantityEffect === "INCREASE" || value.quantityEffect === "DECREASE"
      ? value.quantityEffect : invalidResponse(),
    executionIntentId: requiredString(value.executionIntentId),
    executionRecordId: nullableString(value.executionRecordId),
    requestedQuantity: decimal(value.requestedQuantity),
    confirmedQuantity: decimal(value.confirmedQuantity),
    status: referenceStatus(value.status),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
}

function instanceStatus(value: unknown): ArbitrageInstanceStatus {
  if (value === "OPENING" || value === "HOLDING" || value === "RESIDUAL"
    || value === "CLOSING" || value === "CLOSED" || value === "FAILED") return value;
  throw invalidResponse();
}

function referenceStatus(value: unknown): ArbitrageExecutionReference["status"] {
  if (value === "CLAIMED" || value === "LINKED" || value === "PENDING_CONFIRMATION"
    || value === "CONFIRMED" || value === "FAILED" || value === "UNKNOWN") return value;
  throw invalidResponse();
}

function verificationStatus(value: unknown): ArbitrageLegVerificationStatus {
  if (value === "MATCHED" || value === "MISMATCH" || value === "UNKNOWN") return value;
  throw invalidVerificationResponse();
}

function strategyType(value: unknown): ArbitrageInstance["strategyType"] {
  if (value === "PERPETUAL_PERPETUAL" || value === "SPOT_PERPETUAL") return value;
  throw invalidResponse();
}

function venue(value: unknown): ExchangeVenue {
  if (value === "binance" || value === "okx" || value === "bybit" || value === "bitget") return value;
  throw invalidResponse();
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredRecord(value: unknown) {
  const parsed = record(value);
  if (!parsed) throw invalidResponse();
  return parsed;
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw invalidResponse();
  return value;
}

function nullableString(value: unknown) {
  return value === null ? null : requiredString(value);
}

function decimal(value: unknown) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw invalidResponse();
  return value;
}

function nullableDecimal(value: unknown) {
  return value === null ? null : decimal(value);
}

function timestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidResponse();
  return value;
}

function nullableTimestamp(value: unknown) {
  return value === null ? null : timestamp(value);
}

function invalidResponse(): never {
  throw new Error("套利组合数据响应无效");
}

function invalidVerificationResponse(): never {
  throw new Error("仓位核验数据响应无效");
}
