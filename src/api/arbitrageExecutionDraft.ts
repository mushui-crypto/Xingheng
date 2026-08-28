import type { ArbitrageHorizon } from "../features/arbitrage/model/types";
import {
  fetchArbitrageCloseSafety,
  fetchArbitrageInstanceById,
  fetchArbitragePositionVerification,
  fetchInstanceHedgeDelta,
  requireArbitrageInstance,
  requireArbitragePositionVerification,
  type ArbitrageCloseSafety,
  type ArbitrageInstance,
  type InstanceHedgeDelta,
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

export type ArbitrageUnstartedResumeContext = Readonly<{
  instance: ArbitrageInstance;
  setup: Readonly<{
    opportunityId: string;
    horizonDays: ArbitrageHorizon;
    quantityInput: ExecutionQuantityInput;
    executionMode: FormalExecutionMode;
  }>;
  draft: ArbitrageExecutionDraft;
}>;

export function fetchArbitrageUnstartedResumeContext(arbitrageId: string, signal?: AbortSignal) {
  return requestJson<ArbitrageUnstartedResumeContext>(
    `/api/arbitrage-instances/${encodeURIComponent(arbitrageId)}/resume-opening`,
    "当前实例设置恢复失败。",
    { init: { cache: "no-store", signal }, userAuthFailure: true },
  );
}

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

export type ArbitrageTerminalAuthoritativeSnapshot = Readonly<{
  instance: ArbitrageInstance;
  workflow: ArbitrageHedgeWorkflow | null;
  verification: ArbitragePositionVerification | null;
  closeSafeties: Readonly<Record<string, ArbitrageCloseSafety>>;
  delta: InstanceHedgeDelta | null;
  complete: boolean;
}>;

/**
 * Read-only terminal refresh shared by Start and Exit. The instance is fetched
 * first so a secondary capability failure can never hide newer durable facts.
 */
export async function fetchArbitrageTerminalAuthoritativeSnapshot(
  arbitrageId: string,
  signal?: AbortSignal,
): Promise<ArbitrageTerminalAuthoritativeSnapshot> {
  const instance = await fetchArbitrageInstanceById(arbitrageId, signal);
  const results = await Promise.allSettled([
    fetchArbitrageHedgeWorkflow(arbitrageId, signal),
    fetchArbitragePositionVerification(arbitrageId, signal),
    fetchInstanceHedgeDelta(arbitrageId, signal),
    ...instance.legs.map((leg) => fetchArbitrageCloseSafety(arbitrageId, leg.legId, signal)),
  ]);
  const [workflow, verification, delta, ...safeties] = results;
  const closeSafeties: Record<string, ArbitrageCloseSafety> = {};
  instance.legs.forEach((leg, index) => {
    const safety = safeties[index];
    if (safety?.status === "fulfilled") closeSafeties[leg.legId] = safety.value;
  });
  return Object.freeze({
    instance,
    workflow: workflow?.status === "fulfilled" ? workflow.value : null,
    verification: verification?.status === "fulfilled" ? verification.value : null,
    closeSafeties: Object.freeze(closeSafeties),
    delta: delta?.status === "fulfilled" ? delta.value : null,
    complete: results.every(({ status }) => status === "fulfilled"),
  });
}

export function createTerminalAuthoritativeRefreshCoordinator(
  load: typeof fetchArbitrageTerminalAuthoritativeSnapshot = fetchArbitrageTerminalAuthoritativeSnapshot,
) {
  let generation = 0;
  let controller: AbortController | null = null;
  return Object.freeze({
    async refresh(arbitrageId: string) {
      controller?.abort();
      controller = new AbortController();
      const currentController = controller;
      const currentGeneration = ++generation;
      const snapshot = await load(arbitrageId, currentController.signal);
      return !currentController.signal.aborted && currentGeneration === generation ? snapshot : null;
    },
    cancel() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  });
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
  legs: readonly ArbitrageInstanceExitLegResult[];
  stop?: ArbitrageInstanceExitStopDiagnostic;
  timing?: ArbitrageInstanceExitTiming;
}>;

export type ArbitrageInstanceExitLegResult = Readonly<{
  legId: string;
  executionId: string | null;
  status: "CREATED" | "SUBMITTED" | "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN";
  confirmedQuantity: string;
}>;

export type ArbitrageInstanceExitStopPhase =
  | "INITIAL_STATE" | "JOINT_PREFLIGHT" | "SPOT_FRESH_SAFETY" | "SPOT_CLOSE"
  | "SPOT_CONFIRMATION" | "SPOT_DUST_RECHECK" | "SPOT_DUST_RELEASE"
  | "PERPETUAL_FRESH_SAFETY" | "PERPETUAL_CLOSE" | "PERPETUAL_CONFIRMATION";

export type ArbitrageInstanceExitStopDiagnostic = Readonly<{
  failedLegId: string | null;
  phase: ArbitrageInstanceExitStopPhase;
  reason: string;
  completedLegIds: readonly string[];
  currentManagedExposure: readonly Readonly<{ legId: string; quantity: string }>[];
}>;

export type ArbitrageInstanceExitTiming = Readonly<{
  firstLegConfirmedAt: number;
  secondLegProviderDispatchAt: number;
  secondLegExitDelayMs: number;
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
  const stop = value.stop === undefined ? undefined : exitStopDiagnostic(value.stop);
  const timing = value.timing === undefined ? undefined : exitTiming(value.timing);
  return Object.freeze({
    instance: requireArbitrageInstance(value.instance),
    status: value.status,
    legs: Object.freeze(value.legs.map(exitLegResult)),
    ...(stop === undefined ? {} : { stop }),
    ...(timing === undefined ? {} : { timing }),
  });
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

function exitLegResult(value: unknown): ArbitrageInstanceExitLegResult {
  const leg = record(value);
  const status = executionStatus(leg.status);
  return Object.freeze({
    legId: requiredString(leg.legId),
    executionId: leg.executionId === null ? null : requiredString(leg.executionId),
    status,
    confirmedQuantity: decimalString(leg.confirmedQuantity),
  });
}

function exitStopDiagnostic(value: unknown): ArbitrageInstanceExitStopDiagnostic {
  const stop = record(value);
  const phase = exitStopPhase(stop.phase);
  if (!Array.isArray(stop.completedLegIds) || !Array.isArray(stop.currentManagedExposure)) {
    throw invalidCommandResponse();
  }
  const failedLegId = stop.failedLegId === null ? null : requiredString(stop.failedLegId);
  return Object.freeze({
    failedLegId,
    phase,
    reason: requiredString(stop.reason),
    completedLegIds: Object.freeze(stop.completedLegIds.map(requiredString)),
    currentManagedExposure: Object.freeze(stop.currentManagedExposure.map((candidate) => {
      const exposure = record(candidate);
      return Object.freeze({
        legId: requiredString(exposure.legId),
        quantity: decimalString(exposure.quantity),
      });
    })),
  });
}

function exitStopPhase(value: unknown): ArbitrageInstanceExitStopPhase {
  if (value === "INITIAL_STATE" || value === "JOINT_PREFLIGHT" || value === "SPOT_FRESH_SAFETY"
    || value === "SPOT_CLOSE" || value === "SPOT_CONFIRMATION" || value === "SPOT_DUST_RECHECK"
    || value === "SPOT_DUST_RELEASE" || value === "PERPETUAL_FRESH_SAFETY"
    || value === "PERPETUAL_CLOSE" || value === "PERPETUAL_CONFIRMATION") return value;
  throw invalidCommandResponse();
}

function exitTiming(value: unknown): ArbitrageInstanceExitTiming {
  const timing = record(value);
  return Object.freeze({
    firstLegConfirmedAt: timestamp(timing.firstLegConfirmedAt),
    secondLegProviderDispatchAt: timestamp(timing.secondLegProviderDispatchAt),
    secondLegExitDelayMs: timestamp(timing.secondLegExitDelayMs),
  });
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
