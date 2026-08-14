import type { ArbitrageHorizon } from "../features/arbitrage/model/types";
import { requireArbitrageInstance, type ArbitrageInstance } from "./arbitrageInstances";
import { requestJson } from "./httpClient";

export type ExecutionQuantityInput =
  | Readonly<{ mode: "NOTIONAL_USDT"; amountUsdt: string }>
  | Readonly<{ mode: "ASSET_QUANTITY"; quantity: string }>;

export type ExecutionDraftPlanning =
  | Readonly<{ status: "NOT_REQUESTED" }>
  | Readonly<{
      status: "PLANNED";
      plan: Readonly<{
        sizingPrice: string;
        plannedAssetQuantity: Readonly<{ asset: Readonly<{ symbol: string }>; quantity: string }>;
        plannedVenueQuantity?: string;
        estimatedNotionalUsdt: string;
      }>;
    }>
  | Readonly<{
      status: "UNAVAILABLE" | "ERROR";
      errorCode: string;
      minimumRequiredAssetQuantity?: string;
      minimumRequiredVenueQuantity?: string;
      minimumRequiredNotionalUsdt?: string;
      nearestLegalAssetQuantity?: string;
    }>;

export type ArbitrageExecutionDraftLeg = Readonly<{
  legId: string;
  role: "LONG" | "SHORT";
  venue: "binance" | "okx" | "bybit" | "bitget";
  instrumentId: string;
  providerSymbol: string | null;
  side: "buy" | "sell";
  marketType: "spot" | "perpetual";
  quote: Readonly<{ bid: string; ask: string; updatedAt: number }> | null;
  tradingRules: Readonly<{
    quantityStep: string;
    minQuantity: string;
    priceTick: string;
    minNotional?: string;
    contractSize?: string;
  }> | null;
  capability: Readonly<{
    status: "AVAILABLE" | "UNAVAILABLE";
    reasonCode: "AVAILABLE" | "EXECUTION_CAPABILITY_NOT_IMPLEMENTED" | "CREDENTIAL_NOT_CONFIGURED";
  }>;
  planning: ExecutionDraftPlanning;
  executionAvailable: boolean;
}>;

export type ArbitrageExecutionDraft = Readonly<{
  opportunityId: string;
  sourceIdentity: string;
  sourceSnapshotGeneratedAt: number;
  horizonDays: ArbitrageHorizon;
  strategyType: "PERPETUAL_PERPETUAL" | "SPOT_PERPETUAL";
  quantityInput?: ExecutionQuantityInput;
  legs: readonly [ArbitrageExecutionDraftLeg, ArbitrageExecutionDraftLeg];
  allLegsExecutable: boolean;
  generatedAt: number;
}>;

export function fetchArbitrageExecutionDraft(
  opportunityId: string,
  horizonDays: ArbitrageHorizon,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ opportunityId, horizonDays: String(horizonDays) });
  return requestJson<ArbitrageExecutionDraft>(
    `/api/arbitrage-execution/draft?${query.toString()}`,
    "套利执行草案加载失败。",
    { init: { signal }, userAuthFailure: true },
  );
}

export function previewArbitrageExecutionDraft(
  opportunityId: string,
  horizonDays: ArbitrageHorizon,
  quantityInput: ExecutionQuantityInput,
  signal?: AbortSignal,
) {
  return requestJson<ArbitrageExecutionDraft>(
    "/api/arbitrage-execution/draft/preview",
    "套利数量计划生成失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunityId, horizonDays, quantityInput }),
        signal,
      },
      userAuthFailure: true,
    },
  );
}

export type FormalExecutionMode = "PRICE_PRIORITY" | "EXECUTION_PRIORITY";

export type ArbitrageExecutionConfirmation = Readonly<{
  instance: ArbitrageInstance;
  created: boolean;
}>;

export type ArbitrageLegExecutionConfirmation = Readonly<{
  instance: ArbitrageInstance;
  executionRecord: Readonly<{
    executionId: string | null;
    intentId: string;
    status: "CREATED" | "SUBMITTED" | "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN";
    plannedQuantity: string;
    confirmedQuantity: string;
    verifiedAt: number;
  }>;
  idempotentReplay: boolean;
  secondLegAllowed: boolean;
}>;

export async function confirmArbitrageExecution(
  input: Readonly<{
    confirmationId: string;
    opportunityId: string;
    horizonDays: ArbitrageHorizon;
    quantityInput: ExecutionQuantityInput;
    executionMode: FormalExecutionMode;
  }>,
) {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-execution/confirm",
    "套利执行确认失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, confirmed: true }),
      },
      userAuthFailure: true,
    },
  );
  const value = record(payload);
  if (typeof value.created !== "boolean") throw invalidCommandResponse();
  return Object.freeze({ instance: requireArbitrageInstance(value.instance), created: value.created });
}

export async function confirmArbitrageExecutionLeg(
  input: Readonly<{
    confirmationId: string;
    commandId: string;
    opportunityId: string;
    horizonDays: ArbitrageHorizon;
    quantityInput: ExecutionQuantityInput;
    executionMode: FormalExecutionMode;
    arbitrageId: string;
    legId: string;
  }>,
) {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-execution/legs/confirm",
    "套利腿执行确认失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, confirmed: true }),
      },
      userAuthFailure: true,
    },
  );
  return legExecutionConfirmation(payload);
}

export async function reconcileArbitrageExecutionLeg(
  input: Readonly<{ arbitrageId: string; legId: string }>,
) {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-execution/legs/reconcile",
    "套利腿执行状态核验失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      userAuthFailure: true,
    },
  );
  return legExecutionConfirmation(payload);
}

export async function closeArbitrageExecutionLeg(
  input: Readonly<{
    arbitrageId: string;
    legId: string;
    commandId: string;
    quantity: string;
    executionMode: FormalExecutionMode;
  }>,
) {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-execution/legs/close",
    "套利腿退出失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, confirmed: true }),
      },
      userAuthFailure: true,
    },
  );
  return legExecutionConfirmation(payload);
}

export async function cancelKnownArbitrageOrder(
  input: Readonly<{ arbitrageId: string; legId: string; executionIntentId: string }>,
) {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-execution/orders/cancel",
    "订单撤销暂不可用，请稍后重试。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, confirmed: true }),
      },
      userAuthFailure: true,
    },
  );
  return legExecutionConfirmation(payload);
}

function legExecutionConfirmation(payload: unknown): ArbitrageLegExecutionConfirmation {
  const value = record(payload);
  const executionRecord = record(value.executionRecord);
  if (typeof value.idempotentReplay !== "boolean" || typeof value.secondLegAllowed !== "boolean") {
    throw invalidCommandResponse();
  }
  const status = executionStatus(executionRecord.status);
  return Object.freeze({
    instance: requireArbitrageInstance(value.instance),
    executionRecord: Object.freeze({
      executionId: executionRecord.executionId === null ? null : requiredString(executionRecord.executionId),
      intentId: requiredString(executionRecord.intentId),
      status,
      plannedQuantity: decimalString(executionRecord.plannedQuantity),
      confirmedQuantity: decimalString(executionRecord.confirmedQuantity),
      verifiedAt: timestamp(executionRecord.verifiedAt),
    }),
    idempotentReplay: value.idempotentReplay,
    secondLegAllowed: value.secondLegAllowed,
  });
}

function timestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidCommandResponse();
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidCommandResponse();
  return value as Record<string, unknown>;
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw invalidCommandResponse();
  return value;
}

function decimalString(value: unknown) {
  const result = requiredString(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(result)) throw invalidCommandResponse();
  return result;
}

function executionStatus(value: unknown): ArbitrageLegExecutionConfirmation["executionRecord"]["status"] {
  if (value === "CREATED" || value === "SUBMITTED" || value === "PENDING_CONFIRMATION"
    || value === "CONFIRMED" || value === "FAILED" || value === "UNKNOWN") return value;
  throw invalidCommandResponse();
}

function invalidCommandResponse() {
  return new Error("套利执行确认响应无效。");
}
