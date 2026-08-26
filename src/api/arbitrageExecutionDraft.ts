import type { ArbitrageHorizon } from "../features/arbitrage/model/types";
import {
  requireArbitrageInstance,
  requireArbitragePositionVerification,
  type ArbitrageInstance,
  type ArbitragePositionVerification,
} from "./arbitrageInstances";
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
    reasonCode:
      | "AVAILABLE"
      | "EXECUTION_CAPABILITY_NOT_IMPLEMENTED"
      | "EXECUTION_MODE_NOT_SUPPORTED"
      | "CREDENTIAL_NOT_CONFIGURED";
  }>;
  planning: ExecutionDraftPlanning;
  executionAvailable: boolean;
}>;

export type ArbitrageExecutionDraft = Readonly<{
  opportunityId: string;
  sourceIdentity: string;
  sourceSnapshotGeneratedAt: number;
  horizonDays: ArbitrageHorizon;
  executionMode: FormalExecutionMode;
  strategyType: "PERPETUAL_PERPETUAL" | "SPOT_PERPETUAL";
  quantityInput?: ExecutionQuantityInput;
  legs: readonly [ArbitrageExecutionDraftLeg, ArbitrageExecutionDraftLeg];
  allLegsExecutable: boolean;
  generatedAt: number;
}>;

export function fetchArbitrageExecutionDraft(
  opportunityId: string,
  horizonDays: ArbitrageHorizon,
  executionMode: FormalExecutionMode,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ opportunityId, horizonDays: String(horizonDays), executionMode });
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
  executionMode: FormalExecutionMode,
  signal?: AbortSignal,
) {
  return requestJson<ArbitrageExecutionDraft>(
    "/api/arbitrage-execution/draft/preview",
    "套利数量计划生成失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunityId, horizonDays, executionMode, quantityInput }),
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

export type ArbitrageHedgeWorkflowPhase =
  | "NOT_STARTED" | "FIRST_LEG_EXECUTING" | "FIRST_LEG_PENDING" | "FIRST_LEG_CONFIRMED"
  | "SECOND_LEG_EXECUTING" | "SECOND_LEG_PENDING" | "COMPLETED"
  | "FIRST_LEG_FAILED_ZERO" | "FIRST_LEG_PARTIAL" | "FIRST_LEG_UNKNOWN"
  | "SECOND_LEG_FAILED_ZERO" | "SECOND_LEG_PARTIAL" | "SECOND_LEG_UNKNOWN"
  | "RESIDUAL" | "CLOSED";

export type ArbitrageHedgeWorkflow = Readonly<{
  arbitrageId: string;
  phase: ArbitrageHedgeWorkflowPhase;
  firstLeg: WorkflowLeg | null;
  secondLeg: WorkflowLeg | null;
  requiresUserAction: boolean;
  riskAction?: "RESTART_HEDGE" | "CONTINUE_PARTIAL_HEDGE" | "CONTINUE_SECOND_LEG" | "RECONCILE" | "REVIEW_RESIDUAL";
  reason: string | null;
  derivedAt: number;
}>;

type WorkflowLeg = Readonly<{
  legId: string;
  executionIntentId: string;
  status: ArbitrageInstance["executionReferences"][number]["status"];
  requestedQuantity: string;
  confirmedQuantity: string;
  activeManagedQuantity: string;
  updatedAt: number;
}>;

type HedgeCommandInput = Readonly<{
  confirmationId: string;
  opportunityId: string;
  horizonDays: ArbitrageHorizon;
  quantityInput: ExecutionQuantityInput;
  executionMode: FormalExecutionMode;
}>;

type ArbitrageHedgeStartResult = Readonly<{
  status: string;
  reason?: string;
  firstLeg: Readonly<{ diagnostic?: Readonly<{ category: string; sanitizedMessage: string }> }>;
}>;

export async function startArbitrageHedge(input: HedgeCommandInput & Readonly<{
  arbitrageId: string;
  hedgeCommandId: string;
  firstLegId: string;
}>) {
  const { arbitrageId, ...body } = input;
  return requestJson<ArbitrageHedgeStartResult>(
    `/api/arbitrage-instances/${encodeURIComponent(arbitrageId)}/start-hedge`,
    "一键开始对冲失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, confirmed: true }),
      },
      userAuthFailure: true,
    },
  );
}

export async function continuePartialArbitrageHedge(input: HedgeCommandInput & Readonly<{
  arbitrageId: string;
  commandId: string;
}>) {
  const { arbitrageId, ...body } = input;
  const payload = await requestJson<unknown>(
    `/api/arbitrage-instances/${encodeURIComponent(arbitrageId)}/continue-hedge`,
    "继续对冲已成交部分失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, confirmed: true }),
      },
      userAuthFailure: true,
    },
  );
  return legExecutionConfirmation(payload);
}

export async function fetchArbitrageHedgeWorkflow(arbitrageId: string, signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    `/api/arbitrage-instances/${encodeURIComponent(arbitrageId)}/workflow`,
    "对冲流程状态加载失败。",
    { init: { cache: "no-store", signal }, userAuthFailure: true },
  );
  return workflowSnapshot(payload);
}

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

export type ArbitrageInstanceExitResult = Readonly<{
  instance: ArbitrageInstance;
  /** Command completion, not proof that this invocation created a new Provider close fill. */
  status: "CONFIRMED" | "STOPPED";
}>;

export async function exitArbitrageInstance(input: Readonly<{
  arbitrageId: string;
  commandId: string;
  executionMode: FormalExecutionMode;
}>): Promise<ArbitrageInstanceExitResult> {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-execution/exit",
    "对冲退出失败。",
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
  if (value.status !== "CONFIRMED" && value.status !== "STOPPED") throw invalidCommandResponse();
  if (!Array.isArray(value.legs)) throw invalidCommandResponse();
  return Object.freeze({ instance: requireArbitrageInstance(value.instance), status: value.status });
}

export async function reconcileArbitrageInstance(arbitrageId: string): Promise<Readonly<{
  instance: ArbitrageInstance;
  verification: ArbitragePositionVerification;
}>> {
  const payload = await requestJson<unknown>(
    "/api/arbitrage-execution/reconcile",
    "对冲状态核验失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arbitrageId }),
      },
      userAuthFailure: true,
    },
  );
  const value = record(payload);
  return Object.freeze({
    instance: requireArbitrageInstance(value.instance),
    verification: requireArbitragePositionVerification(value.verification),
  });
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

function workflowSnapshot(payload: unknown): ArbitrageHedgeWorkflow {
  const value = record(payload);
  const phases: readonly string[] = [
    "NOT_STARTED", "FIRST_LEG_EXECUTING", "FIRST_LEG_PENDING", "FIRST_LEG_CONFIRMED",
    "SECOND_LEG_EXECUTING", "SECOND_LEG_PENDING", "COMPLETED", "FIRST_LEG_FAILED_ZERO",
    "FIRST_LEG_PARTIAL", "FIRST_LEG_UNKNOWN", "SECOND_LEG_FAILED_ZERO", "SECOND_LEG_PARTIAL",
    "SECOND_LEG_UNKNOWN", "RESIDUAL", "CLOSED",
  ];
  if (typeof value.arbitrageId !== "string" || !phases.includes(String(value.phase))
    || typeof value.requiresUserAction !== "boolean" || !Number.isSafeInteger(value.derivedAt)) {
    throw invalidCommandResponse();
  }
  return value as ArbitrageHedgeWorkflow;
}
