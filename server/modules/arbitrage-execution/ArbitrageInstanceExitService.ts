import { createHash } from "node:crypto";
import {
  activeManagedQuantity,
  compareUnsignedDecimals,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import type { ArbitrageExecutionCommandService } from "./ArbitrageExecutionCommandService";
import type { ArbitrageExecutionCloseService } from "./ArbitrageExecutionCloseService";

type InstanceStore = Pick<ArbitrageInstanceStore, "get">;
type CloseService = Pick<ArbitrageExecutionCloseService, "closeLeg">;
type ReconciliationService = Pick<ArbitrageExecutionCommandService, "reconcileLeg">;
type PositionVerifier = Pick<ArbitragePositionVerificationService, "verify">;

export class ArbitrageInstanceExitError extends Error {
  constructor(
    readonly category: "invalid_exit_confirmation" | "arbitrage_instance_not_found" | "position_verification_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export class ArbitrageInstanceExitService {
  private readonly inFlight = new Map<string, Promise<ArbitrageInstanceExitResult>>();

  constructor(
    private readonly instances: InstanceStore,
    private readonly closeService: CloseService,
    private readonly reconciliationService: ReconciliationService,
    private readonly positions: PositionVerifier,
  ) {}

  async exit(authenticatedUserId: string, input: unknown) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseExitRequest(input);
    const key = `${userId}\0${request.arbitrageId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.exitOnce(userId, request);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  async reconcile(authenticatedUserId: string, input: unknown) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseReconcileRequest(input);
    let instance = this.requireInstance(userId, request.arbitrageId);
    for (const leg of instance.legs) {
      if (!hasUnresolvedClosingReference(instance, leg.legId)) continue;
      const result = await this.reconciliationService.reconcileLeg(userId, {
        arbitrageId: instance.arbitrageId,
        legId: leg.legId,
      });
      instance = result.instance;
    }
    const verification = await this.positions.verify(userId, instance.arbitrageId);
    if (!verification) throw exitError("position_verification_unavailable", "套利实例仓位核验不可用。");
    return Object.freeze({ instance, verification });
  }

  private async exitOnce(userId: string, request: ExitRequest): Promise<ArbitrageInstanceExitResult> {
    let instance = this.requireInstance(userId, request.arbitrageId);
    if (instance.status === "CLOSED") return result(instance, "CONFIRMED", []);
    if (instance.status === "FAILED") return result(instance, "STOPPED", []);

    const outcomes: ArbitrageInstanceExitLegResult[] = [];
    for (const leg of orderedExitLegs(instance)) {
      if (instance.status === "CLOSED") break;
      const currentLeg = instance.legs.find((candidate) => candidate.legId === leg.legId)!;
      const quantity = activeManagedQuantity(instance, currentLeg);
      if (quantity === "0") continue;
      if (hasUnresolvedClosingReference(instance, leg.legId)) {
        return result(instance, "STOPPED", outcomes);
      }
      const confirmation = await this.closeService.closeLeg(userId, {
        arbitrageId: instance.arbitrageId,
        legId: leg.legId,
        commandId: legCommandId(request.commandId, leg.legId),
        quantity,
        executionMode: request.executionMode,
        confirmed: true,
      });
      instance = confirmation.instance;
      outcomes.push(Object.freeze({
        legId: leg.legId,
        executionId: confirmation.executionRecord.executionId,
        status: confirmation.executionRecord.status,
        confirmedQuantity: confirmation.executionRecord.confirmedQuantity,
      }));
      if (confirmation.executionRecord.status !== "CONFIRMED"
        || compareUnsignedDecimals(
          confirmation.executionRecord.confirmedQuantity,
          confirmation.executionRecord.plannedQuantity,
        ) !== 0) {
        return result(instance, "STOPPED", outcomes);
      }
    }
    return result(instance, instance.status === "CLOSED" ? "CONFIRMED" : "STOPPED", outcomes);
  }

  private requireInstance(userId: string, arbitrageId: string) {
    const instance = this.instances.get(userId, arbitrageId);
    if (!instance) throw exitError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    return instance;
  }
}

type ExitRequest = Readonly<{
  arbitrageId: string;
  commandId: string;
  executionMode: "PRICE_PRIORITY" | "EXECUTION_PRIORITY";
}>;

type ArbitrageInstanceExitLegResult = Readonly<{
  legId: string;
  executionId: string | null;
  status: "CREATED" | "SUBMITTED" | "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN";
  confirmedQuantity: string;
}>;

type ArbitrageInstanceExitResult = Readonly<{
  instance: ArbitrageInstance;
  /** A pre-existing CLOSED instance is idempotently complete and may have no new leg outcomes. */
  status: "CONFIRMED" | "STOPPED";
  legs: readonly ArbitrageInstanceExitLegResult[];
}>;

function orderedExitLegs(instance: ArbitrageInstance) {
  return [...instance.legs].sort((left, right) => exitPriority(left) - exitPriority(right));
}

function exitPriority(leg: ArbitrageInstance["legs"][number]) {
  if (leg.instrumentId.endsWith("-SPOT")) return 2;
  return leg.role === "SHORT" ? 0 : 1;
}

function hasUnresolvedClosingReference(instance: ArbitrageInstance, legId: string) {
  return instance.executionReferences.some((reference) => reference.legId === legId
    && reference.phase === "CLOSING"
    && (reference.status === "CLAIMED" || reference.status === "LINKED"
      || reference.status === "PENDING_CONFIRMATION" || reference.status === "UNKNOWN"));
}

function parseExitRequest(input: unknown): ExitRequest {
  const value = object(input);
  exactKeys(value, ["arbitrageId", "commandId", "executionMode", "confirmed"]);
  if (value.confirmed !== true) throw exitError("invalid_exit_confirmation", "需要用户明确确认退出对冲。");
  if (value.executionMode !== "PRICE_PRIORITY" && value.executionMode !== "EXECUTION_PRIORITY") {
    throw exitError("invalid_exit_confirmation", "executionMode 无效。");
  }
  return Object.freeze({
    arbitrageId: identifier(value.arbitrageId, "arbitrageId"),
    commandId: identifier(value.commandId, "commandId"),
    executionMode: value.executionMode,
  });
}

function parseReconcileRequest(input: unknown) {
  const value = object(input);
  exactKeys(value, ["arbitrageId"]);
  return Object.freeze({ arbitrageId: identifier(value.arbitrageId, "arbitrageId") });
}

function result(instance: ArbitrageInstance, status: ArbitrageInstanceExitResult["status"], legs: readonly ArbitrageInstanceExitLegResult[]) {
  return Object.freeze({ instance, status, legs: Object.freeze([...legs]) });
}

function legCommandId(commandId: string, legId: string) {
  return `hedge-exit-${createHash("sha256").update(`${commandId}\0${legId}`).digest("hex")}`;
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw exitError("invalid_exit_confirmation", "退出对冲请求必须为对象。");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw exitError("invalid_exit_confirmation", `请求包含不允许的字段：${unknown}。`);
  const missing = allowed.find((key) => !(key in value));
  if (missing) throw exitError("invalid_exit_confirmation", `请求缺少字段：${missing}。`);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw exitError("invalid_exit_confirmation", `${name} 无效。`);
  }
  return value.trim();
}

function exitError(category: ArbitrageInstanceExitError["category"], message: string) {
  return new ArbitrageInstanceExitError(category, message);
}
