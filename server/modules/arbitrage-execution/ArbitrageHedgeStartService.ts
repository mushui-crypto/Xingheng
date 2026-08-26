import { createHash } from "node:crypto";
import {
  compareUnsignedDecimals,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import {
  ArbitrageExecutionCommandError,
  type ArbitrageExecutionCommandService,
  type ArbitrageLegExecutionConfirmation,
} from "./ArbitrageExecutionCommandService";
import { validOpeningFirstLeg } from "./ArbitrageOpeningLegOrder";

type InstanceStore = Pick<ArbitrageInstanceStore, "get">;
type LegExecutor = Pick<ArbitrageExecutionCommandService, "executeLeg">;

export type ArbitrageHedgeStartStatus =
  | "COMPLETED"
  | "FIRST_LEG_CONFIRMED_REQUIRES_USER_CONTINUE"
  | "STOPPED_FIRST_LEG_PENDING"
  | "STOPPED_FIRST_LEG_UNKNOWN"
  | "STOPPED_FIRST_LEG_PARTIAL"
  | "STOPPED_FIRST_LEG_FAILED"
  | "STOPPED_SECOND_LEG_PENDING"
  | "STOPPED_SECOND_LEG_UNKNOWN"
  | "STOPPED_SECOND_LEG_PARTIAL"
  | "STOPPED_SECOND_LEG_FAILED"
  | "STOPPED_SAFETY";

export type ArbitrageHedgeStartResult = Readonly<{
  arbitrageId: string;
  hedgeCommandId: string;
  status: ArbitrageHedgeStartStatus;
  firstLeg: ArbitrageHedgeStartLegResult;
  secondLeg: ArbitrageHedgeStartLegResult | null;
  instanceStatus: ArbitrageInstance["status"];
  requiresUserAction: boolean;
  reason?: string;
  timing: Readonly<{
    firstLegCompletedAt: number;
    secondLegDispatchStartedAt: number | null;
  }>;
}>;

type ArbitrageHedgeStartLegResult = Readonly<{
  legId: string;
  executionIntentId?: string;
  status: ArbitrageLegExecutionConfirmation["executionRecord"]["status"];
  requestedQuantity?: string;
  confirmedQuantity?: string;
  diagnostic?: Readonly<{ category: string; sanitizedMessage: string }>;
}>;

type InFlightStart = Readonly<{
  fingerprint: string;
  operation: Promise<ArbitrageHedgeStartResult>;
}>;

export class ArbitrageHedgeStartError extends Error {
  constructor(
    readonly category:
      | "invalid_start_confirmation"
      | "arbitrage_instance_not_found"
      | "arbitrage_leg_not_found"
      | "idempotency_conflict",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Thin, continuous-process orchestration over the authoritative per-leg command.
 * It owns no execution, quantity, safety, Provider, or projection logic.
 */
export class ArbitrageHedgeStartService {
  private readonly inFlight = new Map<string, InFlightStart>();

  constructor(
    private readonly instances: InstanceStore,
    private readonly commands: LegExecutor,
    private readonly options: Readonly<{ clock?: () => number }> = {},
  ) {}

  async start(authenticatedUserId: string, arbitrageIdInput: string, input: unknown) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const arbitrageId = identifier(arbitrageIdInput, "arbitrageId");
    const request = parseRequest(input);
    const instance = this.instances.get(userId, arbitrageId);
    if (!instance) throw startError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    if (!instance.legs.some(({ legId }) => legId === request.firstLegId)) {
      throw startError("arbitrage_leg_not_found", "所选第一腿不属于当前套利实例。");
    }
    if (!validOpeningFirstLeg(instance, request.firstLegId)) {
      throw startError(
        "invalid_start_confirmation",
        "现货永续套利必须先执行现货腿，再执行永续合约腿。",
      );
    }

    const fingerprint = startFingerprint(userId, arbitrageId, request);
    const key = `${userId}\0${arbitrageId}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw startError("idempotency_conflict", "当前套利实例已有不同的一键开始命令正在执行。");
      }
      return existing.operation;
    }

    const operation = this.startOnce(userId, arbitrageId, instance, request);
    this.inFlight.set(key, { fingerprint, operation });
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key)?.operation === operation) this.inFlight.delete(key);
    }
  }

  private async startOnce(
    userId: string,
    arbitrageId: string,
    initial: ArbitrageInstance,
    request: StartRequest,
  ): Promise<ArbitrageHedgeStartResult> {
    const secondLegId = initial.legs.find(({ legId }) => legId !== request.firstLegId)!.legId;
    let first: ArbitrageLegExecutionConfirmation;
    try {
      first = await this.commands.executeLeg(userId, childRequest(
        arbitrageId,
        request.firstLegId,
        childCommandId(request.hedgeCommandId, "first"),
        request,
      ));
    } catch (error) {
      return this.stoppedFromCommandError(userId, arbitrageId, request, request.firstLegId, null, error);
    }
    const firstLegCompletedAt = this.now();
    const firstStop = stopStatus("FIRST", first);
    if (firstStop !== null) {
      return result(arbitrageId, request.hedgeCommandId, firstStop, first, null, first.instance,
        firstLegCompletedAt, null);
    }

    const secondReferenceExists = first.instance.executionReferences.some((reference) =>
      reference.phase === "OPENING" && reference.legId === secondLegId);
    if (first.idempotentReplay && !secondReferenceExists) {
      return result(
        arbitrageId,
        request.hedgeCommandId,
        "FIRST_LEG_CONFIRMED_REQUIRES_USER_CONTINUE",
        first,
        null,
        first.instance,
        firstLegCompletedAt,
        null,
        "第一腿来自既有执行事实；本次请求不是原始连续编排，第二腿需要用户重新明确触发。",
      );
    }

    const secondLegDispatchStartedAt = this.now();
    let second: ArbitrageLegExecutionConfirmation;
    try {
      second = await this.commands.executeLeg(userId, childRequest(
        arbitrageId,
        secondLegId,
        childCommandId(request.hedgeCommandId, "second"),
        request,
      ));
    } catch (error) {
      return this.stoppedFromCommandError(
        userId,
        arbitrageId,
        request,
        request.firstLegId,
        first,
        error,
        firstLegCompletedAt,
        secondLegDispatchStartedAt,
      );
    }
    const secondStop = stopStatus("SECOND", second);
    return result(
      arbitrageId,
      request.hedgeCommandId,
      secondStop ?? "COMPLETED",
      first,
      second,
      second.instance,
      firstLegCompletedAt,
      secondLegDispatchStartedAt,
    );
  }

  private stoppedFromCommandError(
    userId: string,
    arbitrageId: string,
    request: StartRequest,
    firstLegId: string,
    first: ArbitrageLegExecutionConfirmation | null,
    error: unknown,
    firstLegCompletedAt = this.now(),
    secondLegDispatchStartedAt: number | null = null,
  ): ArbitrageHedgeStartResult {
    if (!(error instanceof ArbitrageExecutionCommandError) || !stoppableCommandError(error)) throw error;
    const instance = this.instances.get(userId, arbitrageId)
      ?? first?.instance;
    if (!instance) throw error;
    const phase = first === null ? "FIRST" : "SECOND";
    const legId = phase === "FIRST"
      ? firstLegId
      : instance.legs.find(({ legId: candidate }) => candidate !== firstLegId)!.legId;
    const reference = [...instance.executionReferences].reverse().find((candidate) =>
      candidate.phase === "OPENING" && candidate.legId === legId);
    const observed = reference ? confirmationFromReference(instance, reference) : null;
    const status = error.category === "execution_state_unknown" || error.category === "manual_reconciliation_required"
      ? `STOPPED_${phase}_LEG_UNKNOWN` as ArbitrageHedgeStartStatus
      : observed === null ? "STOPPED_SAFETY" : stopStatus(phase, observed) ?? "STOPPED_SAFETY";
    return resultFromLegs(
      arbitrageId,
      request.hedgeCommandId,
      status,
      first ? legResult(first) : observed ? legResult(observed) : emptyLeg(firstLegId),
      first === null || observed === null ? null : legResult(observed),
      instance,
      firstLegCompletedAt,
      secondLegDispatchStartedAt,
      error.message,
    );
  }

  private now() {
    const value = this.options.clock?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Hedge start clock is invalid.");
    return value;
  }
}

type StartRequest = Readonly<{
  hedgeCommandId: string;
  firstLegId: string;
  confirmationId: string;
  opportunityId: string;
  horizonDays: 90 | 365;
  quantityInput: Readonly<{ mode: "NOTIONAL_USDT"; amountUsdt: string } | { mode: "ASSET_QUANTITY"; quantity: string }>;
  executionMode: "PRICE_PRIORITY" | "EXECUTION_PRIORITY";
  confirmed: true;
}>;

function parseRequest(input: unknown): StartRequest {
  const value = object(input);
  exactKeys(value, [
    "hedgeCommandId", "firstLegId", "confirmationId", "opportunityId", "horizonDays",
    "quantityInput", "executionMode", "confirmed",
  ]);
  if (value.confirmed !== true) throw startError("invalid_start_confirmation", "需要用户明确确认开始对冲。");
  if (value.horizonDays !== 90 && value.horizonDays !== 365) {
    throw startError("invalid_start_confirmation", "horizonDays 必须为 90 或 365。");
  }
  if (value.executionMode !== "PRICE_PRIORITY" && value.executionMode !== "EXECUTION_PRIORITY") {
    throw startError("invalid_start_confirmation", "executionMode 无效。");
  }
  return Object.freeze({
    hedgeCommandId: identifier(value.hedgeCommandId, "hedgeCommandId"),
    firstLegId: identifier(value.firstLegId, "firstLegId"),
    confirmationId: identifier(value.confirmationId, "confirmationId"),
    opportunityId: identifier(value.opportunityId, "opportunityId"),
    horizonDays: value.horizonDays,
    quantityInput: quantityInput(value.quantityInput),
    executionMode: value.executionMode,
    confirmed: true,
  });
}

function childRequest(arbitrageId: string, legId: string, commandId: string, request: StartRequest) {
  return Object.freeze({
    confirmationId: request.confirmationId,
    opportunityId: request.opportunityId,
    horizonDays: request.horizonDays,
    quantityInput: request.quantityInput,
    executionMode: request.executionMode,
    confirmed: true,
    arbitrageId,
    legId,
    commandId,
  });
}

function childCommandId(hedgeCommandId: string, phase: "first" | "second") {
  return `hedge-start-${createHash("sha256").update(`${hedgeCommandId}\0${phase}`).digest("hex")}`;
}

function startFingerprint(userId: string, arbitrageId: string, request: StartRequest) {
  return createHash("sha256").update(JSON.stringify([
    "HEDGE_START", userId, arbitrageId, request.hedgeCommandId, request.firstLegId,
    request.confirmationId, request.opportunityId, request.horizonDays, request.quantityInput,
    request.executionMode, "CONFIRMED_TRUE",
  ])).digest("hex");
}

function stopStatus(
  phase: "FIRST" | "SECOND",
  confirmation: ArbitrageLegExecutionConfirmation,
): ArbitrageHedgeStartStatus | null {
  const record = confirmation.executionRecord;
  const prefix = `STOPPED_${phase}_LEG_` as const;
  if (record.status === "PENDING_CONFIRMATION" || record.status === "CREATED" || record.status === "SUBMITTED") {
    return `${prefix}PENDING`;
  }
  if (record.status === "UNKNOWN") return `${prefix}UNKNOWN`;
  const full = compareUnsignedDecimals(record.confirmedQuantity, record.plannedQuantity) === 0;
  if (record.status === "FAILED") {
    return compareUnsignedDecimals(record.confirmedQuantity, "0") === 0 || full
      ? `${prefix}FAILED`
      : `${prefix}PARTIAL`;
  }
  if (!full) return `${prefix}PARTIAL`;
  return record.status === "CONFIRMED" ? null : `${prefix}PENDING`;
}

function result(
  arbitrageId: string,
  hedgeCommandId: string,
  status: ArbitrageHedgeStartStatus,
  first: ArbitrageLegExecutionConfirmation,
  second: ArbitrageLegExecutionConfirmation | null,
  instance: ArbitrageInstance,
  firstLegCompletedAt: number,
  secondLegDispatchStartedAt: number | null,
  reason?: string,
) {
  return resultFromLegs(arbitrageId, hedgeCommandId, status, legResult(first), second && legResult(second), instance,
    firstLegCompletedAt, secondLegDispatchStartedAt, reason);
}

function resultFromLegs(
  arbitrageId: string,
  hedgeCommandId: string,
  status: ArbitrageHedgeStartStatus,
  firstLeg: ArbitrageHedgeStartLegResult,
  secondLeg: ArbitrageHedgeStartLegResult | null,
  instance: ArbitrageInstance,
  firstLegCompletedAt: number,
  secondLegDispatchStartedAt: number | null,
  reason?: string,
): ArbitrageHedgeStartResult {
  return Object.freeze({
    arbitrageId,
    hedgeCommandId,
    status,
    firstLeg,
    secondLeg,
    instanceStatus: instance.status,
    requiresUserAction: status !== "COMPLETED",
    ...(reason === undefined ? {} : { reason }),
    timing: Object.freeze({ firstLegCompletedAt, secondLegDispatchStartedAt }),
  });
}

function legResult(confirmation: ArbitrageLegExecutionConfirmation): ArbitrageHedgeStartLegResult {
  return Object.freeze({
    legId: confirmation.instance.executionReferences.find((reference) =>
      reference.executionIntentId === confirmation.executionRecord.intentId)?.legId ?? "unknown",
    executionIntentId: confirmation.executionRecord.intentId,
    status: confirmation.executionRecord.status,
    requestedQuantity: confirmation.executionRecord.plannedQuantity,
    confirmedQuantity: confirmation.executionRecord.confirmedQuantity,
    ...(confirmation.diagnostic === undefined ? {} : { diagnostic: Object.freeze({
      category: confirmation.diagnostic.category,
      sanitizedMessage: confirmation.diagnostic.sanitizedMessage,
    }) }),
  });
}

function confirmationFromReference(
  instance: ArbitrageInstance,
  reference: ArbitrageInstance["executionReferences"][number],
): ArbitrageLegExecutionConfirmation {
  return Object.freeze({
    instance,
    executionRecord: Object.freeze({
      executionId: reference.executionRecordId,
      intentId: reference.executionIntentId,
      status: reference.status === "CLAIMED" || reference.status === "LINKED" ? "CREATED" : reference.status,
      plannedQuantity: reference.requestedQuantity,
      confirmedQuantity: reference.confirmedQuantity,
      verifiedAt: reference.updatedAt,
    }),
    idempotentReplay: true,
    secondLegAllowed: false,
  });
}

function emptyLeg(legId: string): ArbitrageHedgeStartLegResult {
  return Object.freeze({ legId, status: "CREATED" });
}

function stoppableCommandError(error: ArbitrageExecutionCommandError) {
  return error.category === "execution_capability_unavailable"
    || error.category === "second_leg_not_allowed"
    || error.category === "opening_attribution_unsafe"
    || error.category === "execution_state_unknown"
    || error.category === "manual_reconciliation_required";
}

function quantityInput(value: unknown): StartRequest["quantityInput"] {
  const input = object(value);
  if (input.mode === "NOTIONAL_USDT") {
    exactKeys(input, ["mode", "amountUsdt"]);
    return Object.freeze({ mode: input.mode, amountUsdt: decimal(input.amountUsdt, "amountUsdt") });
  }
  if (input.mode === "ASSET_QUANTITY") {
    exactKeys(input, ["mode", "quantity"]);
    return Object.freeze({ mode: input.mode, quantity: decimal(input.quantity, "quantity") });
  }
  throw startError("invalid_start_confirmation", "quantityInput.mode 无效。");
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw startError("invalid_start_confirmation", "开始对冲请求必须为对象。");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw startError("invalid_start_confirmation", `请求包含不允许的字段：${unknown}。`);
  const missing = allowed.find((key) => !(key in value));
  if (missing) throw startError("invalid_start_confirmation", `请求缺少字段：${missing}。`);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw startError("invalid_start_confirmation", `${name} 无效。`);
  }
  return value.trim();
}

function decimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || value === "0") {
    throw startError("invalid_start_confirmation", `${name} 必须为正十进制字符串。`);
  }
  return value;
}

function startError(category: ArbitrageHedgeStartError["category"], message: string) {
  return new ArbitrageHedgeStartError(category, message);
}
