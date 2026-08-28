import { createHash } from "node:crypto";
import {
  activeManagedQuantity,
  compareUnsignedDecimals,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import type { ArbitrageExecutionCommandService } from "./ArbitrageExecutionCommandService";
import {
  ArbitrageExecutionCloseError,
  type ArbitrageExecutionCloseService,
} from "./ArbitrageExecutionCloseService";
import type { ArbitrageCloseSafetyResult } from "./ArbitrageCloseSafetyEvaluator";
import type { ArbitrageManagementReleaseService } from "./ArbitrageManagementReleaseService";

type InstanceStore = Pick<ArbitrageInstanceStore, "get">;
type CloseService = Pick<ArbitrageExecutionCloseService, "closeLeg" | "evaluateCloseSafety"> &
  Partial<Pick<ArbitrageExecutionCloseService, "closeLegForExit">>;
type ReconciliationService = Pick<ArbitrageExecutionCommandService, "reconcileLeg">;
type PositionVerifier = Pick<ArbitragePositionVerificationService, "verify">;
type DustReleaseService = Pick<ArbitrageManagementReleaseService, "releaseDustAfterClose">;

const DEFAULT_CLOSE_FINALIZATION_BUDGET_MS = 15_000;
const DEFAULT_CLOSE_FINALIZATION_INITIAL_POLL_MS = 250;
const DEFAULT_CLOSE_FINALIZATION_MAX_POLL_MS = 2_000;
const DEFAULT_CLOSE_FINALIZATION_MAX_ATTEMPTS = 10;

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
    private readonly managementRelease: DustReleaseService,
    private readonly reconciliationService: ReconciliationService,
    private readonly positions: PositionVerifier,
    private readonly options: Readonly<{
      now?: () => number;
      sleep?: (milliseconds: number) => Promise<void>;
      transientReadRetryBudgetMs?: number;
      transientReadRetryIntervalMs?: number;
      transientReadMaxAttempts?: number;
      closeFinalizationBudgetMs?: number;
      closeFinalizationInitialPollMs?: number;
      closeFinalizationMaxPollMs?: number;
      closeFinalizationMaxAttempts?: number;
    }> = {},
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
    if (instance.status === "FAILED") return stopped(instance, [], null, "INITIAL_STATE", "INSTANCE_TERMINAL");
    if (hasUnresolvedExecution(instance)) {
      return stopped(instance, [], null, "JOINT_PREFLIGHT", "UNRESOLVED_EXECUTION");
    }

    const outcomes: ArbitrageInstanceExitLegResult[] = [];
    const orderedLegs = orderedExitLegs(instance);
    for (const leg of orderedLegs) {
      const quantity = activeManagedQuantity(instance, leg);
      if (quantity === "0") continue;
      if (hasUnresolvedClosingReference(instance, leg.legId)) {
        return stopped(instance, outcomes, leg.legId, "JOINT_PREFLIGHT", "UNRESOLVED_EXECUTION");
      }
      const safety = await this.closeService.evaluateCloseSafety(userId, instance.arbitrageId, leg.legId);
      if (!isExecutableExitSafety(instance, leg.legId, safety)) {
        return stopped(instance, outcomes, leg.legId, "JOINT_PREFLIGHT", safety.reason);
      }
    }

    const pendingDustReleaseLegIds: string[] = [];
    let firstConfirmedAt: number | null = null;
    let secondLegProviderDispatchAt: number | null = null;
    let continuationReadDeadline: number | null = null;
    for (const leg of orderedLegs) {
      if (instance.status === "CLOSED") break;
      const currentLeg = instance.legs.find((candidate) => candidate.legId === leg.legId)!;
      const quantity = activeManagedQuantity(instance, currentLeg);
      if (quantity === "0") continue;
      if (hasUnresolvedClosingReference(instance, leg.legId)) {
        return stopped(instance, outcomes, leg.legId, phaseFor(leg, "CLOSE"), "UNRESOLVED_EXECUTION");
      }
      const fresh = leg.instrumentId.endsWith("-SPOT")
        ? { safety: await this.closeService.evaluateCloseSafety(userId, instance.arbitrageId, leg.legId), attempts: 1 }
        : await this.readPerpetualSafetyWithRetry(userId, instance, leg.legId, continuationReadDeadline);
      const safety = fresh.safety;
      const dustCompletion = safety.reason === "QUANTITY_STEP_DUST";
      if (!safety.fullManagedCloseAvailable && !dustCompletion) {
        return stopped(instance, outcomes, leg.legId, phaseFor(leg, "FRESH_SAFETY"), safety.reason);
      }
      if (dustCompletion && safety.safeClosableQuantity === "0") {
        if (!hasConfirmedClosingReference(instance, leg.legId)) {
          return stopped(instance, outcomes, leg.legId, "SPOT_DUST_RELEASE", safety.reason);
        }
        pendingDustReleaseLegIds.push(leg.legId);
        continue;
      }
      const closeQuantity = safety.fullManagedCloseAvailable
        ? quantity
        : safety.safeClosableQuantity;
      let confirmation;
      try {
        const closeInput = {
          arbitrageId: instance.arbitrageId,
          legId: leg.legId,
          commandId: legCommandId(request.commandId, leg.legId),
          quantity: closeQuantity,
          executionMode: request.executionMode,
          confirmed: true,
        };
        confirmation = leg.instrumentId.endsWith("-SPOT")
          ? await this.closeService.closeLeg(userId, closeInput)
          : await this.closeWithTransientReadRetry(
            userId, instance, leg.legId, closeInput, fresh.attempts, continuationReadDeadline,
          );
      } catch (error) {
        return stopped(
          this.instances.get(userId, instance.arbitrageId) ?? instance,
          outcomes,
          leg.legId,
          phaseFor(leg, "CLOSE"),
          safeCloseErrorReason(error),
        );
      }
      const dispatchedByThisExit = !confirmation.idempotentReplay;
      if (dispatchedByThisExit && pendingWithoutFill(confirmation)) {
        try {
          confirmation = await this.finalizeClosingLeg(userId, instance.arbitrageId, leg.legId, confirmation);
        } catch {
          instance = this.instances.get(userId, instance.arbitrageId) ?? confirmation.instance;
          return stopped(
            instance,
            outcomes,
            leg.legId,
            phaseFor(leg, "CONFIRMATION"),
            "CLOSE_FINALIZATION_UNAVAILABLE",
          );
        }
      }
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
        return stopped(instance, outcomes, leg.legId, phaseFor(leg, "CONFIRMATION"), confirmation.executionRecord.status);
      }
      if (!dispatchedByThisExit && instance.status !== "CLOSED") {
        return stopped(
          instance,
          outcomes,
          leg.legId,
          phaseFor(leg, "CONFIRMATION"),
          "EXISTING_CLOSING_EXECUTION_REQUIRES_USER_CONTINUE",
        );
      }
      if (firstConfirmedAt === null) {
        firstConfirmedAt = confirmation.executionRecord.verifiedAt;
        if (leg.instrumentId.endsWith("-SPOT") && instance.strategyType === "SPOT_PERPETUAL") {
          continuationReadDeadline = this.now() + (this.options.transientReadRetryBudgetMs ?? 5_000);
        }
      }
      else if (confirmation.providerDispatchStartedAt !== undefined) {
        secondLegProviderDispatchAt = confirmation.providerDispatchStartedAt;
      }
      if (dustCompletion) {
        const remaining = instance.legs.find((candidate) => candidate.legId === leg.legId)!;
        const dustSafety = await this.closeService.evaluateCloseSafety(userId, instance.arbitrageId, leg.legId);
        if (activeManagedQuantity(instance, remaining) === "0") continue;
        if (dustSafety.reason !== "QUANTITY_STEP_DUST" || dustSafety.safeClosableQuantity !== "0") {
          return stopped(instance, outcomes, leg.legId, "SPOT_DUST_RECHECK", dustSafety.reason);
        }
        pendingDustReleaseLegIds.push(leg.legId);
      }
    }

    for (const legId of pendingDustReleaseLegIds) {
      try {
        instance = (await this.managementRelease.releaseDustAfterClose(userId, {
          arbitrageId: instance.arbitrageId,
          legId,
          commandId: dustReleaseCommandId(request.commandId, legId),
        })).instance;
      } catch {
        return stopped(instance, outcomes, legId, "SPOT_DUST_RELEASE", "DUST_RELEASE_UNAVAILABLE");
      }
    }
    return result(
      instance,
      instance.status === "CLOSED" ? "CONFIRMED" : "STOPPED",
      outcomes,
      undefined,
      timing(firstConfirmedAt, secondLegProviderDispatchAt),
    );
  }

  private async finalizeClosingLeg(
    userId: string,
    arbitrageId: string,
    legId: string,
    dispatched: Awaited<ReturnType<CloseService["closeLeg"]>>,
  ) {
    const identity = reliableClosingExecutionIdentity(dispatched, legId);
    if (identity === null) throw new Error("Closing execution identity is unavailable for online finalization.");
    const budgetMs = positiveInteger(
      this.options.closeFinalizationBudgetMs ?? DEFAULT_CLOSE_FINALIZATION_BUDGET_MS,
      "closeFinalizationBudgetMs",
    );
    const initialPollMs = positiveInteger(
      this.options.closeFinalizationInitialPollMs ?? DEFAULT_CLOSE_FINALIZATION_INITIAL_POLL_MS,
      "closeFinalizationInitialPollMs",
    );
    const maxPollMs = positiveInteger(
      this.options.closeFinalizationMaxPollMs ?? DEFAULT_CLOSE_FINALIZATION_MAX_POLL_MS,
      "closeFinalizationMaxPollMs",
    );
    const maxAttempts = positiveInteger(
      this.options.closeFinalizationMaxAttempts ?? DEFAULT_CLOSE_FINALIZATION_MAX_ATTEMPTS,
      "closeFinalizationMaxAttempts",
    );
    const deadline = this.now() + budgetMs;
    let confirmation = dispatched;
    let pollMs = Math.min(initialPollMs, maxPollMs);
    for (let attempt = 0; attempt < maxAttempts && this.now() < deadline; attempt += 1) {
      if (attempt > 0) {
        const remaining = deadline - this.now();
        if (remaining <= 0) break;
        await this.sleep(Math.min(pollMs, remaining));
        pollMs = Math.min(pollMs * 2, maxPollMs);
        if (this.now() >= deadline) break;
      }
      confirmation = await this.reconciliationService.reconcileLeg(userId, {
        arbitrageId,
        legId,
        executionIntentId: identity.executionIntentId,
      });
      assertSameClosingExecutionIdentity(confirmation, legId, identity);
      if (!pendingWithoutFill(confirmation)) return confirmation;
    }
    return confirmation;
  }

  private async readPerpetualSafetyWithRetry(
    userId: string,
    instance: ArbitrageInstance,
    legId: string,
    inheritedDeadline: number | null,
  ) {
    const startedAt = this.now();
    const budget = this.options.transientReadRetryBudgetMs ?? 5_000;
    const deadline = inheritedDeadline ?? startedAt + budget;
    const maxAttempts = this.options.transientReadMaxAttempts ?? 3;
    let attempts = 0;
    let safety: ArbitrageCloseSafetyResult;
    do {
      attempts += 1;
      safety = await this.evaluateSafetyBeforeDeadline(userId, instance, legId, deadline);
      if (safety.reason !== "PROVIDER_REALITY_UNAVAILABLE") return { safety, attempts };
      const remaining = deadline - this.now();
      if (attempts >= maxAttempts || remaining <= 0) return { safety, attempts };
      await this.sleep(Math.min(this.options.transientReadRetryIntervalMs ?? 150, remaining));
    } while (true);
  }

  private async evaluateSafetyBeforeDeadline(
    userId: string,
    instance: ArbitrageInstance,
    legId: string,
    deadline: number,
  ): Promise<ArbitrageCloseSafetyResult> {
    const remaining = deadline - this.now();
    if (remaining <= 0) return unavailableSafety(instance, legId, this.now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.closeService.evaluateCloseSafety(userId, instance.arbitrageId, legId),
        new Promise<ArbitrageCloseSafetyResult>((resolve) => {
          timeout = setTimeout(() => resolve(unavailableSafety(instance, legId, this.now())), remaining);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async closeWithTransientReadRetry(
    userId: string,
    instance: ArbitrageInstance,
    legId: string,
    input: Parameters<CloseService["closeLeg"]>[1],
    attemptsAlreadyUsed: number,
    inheritedDeadline: number | null,
  ) {
    const startedAt = this.now();
    const budget = this.options.transientReadRetryBudgetMs ?? 5_000;
    const deadline = inheritedDeadline ?? startedAt + budget;
    const maxAttempts = this.options.transientReadMaxAttempts ?? 3;
    let attempts = attemptsAlreadyUsed;
    while (true) {
      try {
        return await (inheritedDeadline !== null && this.closeService.closeLegForExit
          ? this.closeService.closeLegForExit(userId, input, inheritedDeadline)
          : this.closeService.closeLeg(userId, input));
      } catch (error) {
        if (error instanceof ArbitrageExecutionCloseError
          && error.category === "position_verification_unavailable"
          && attempts < maxAttempts
          && this.now() < deadline
          && !hasUnresolvedClosingReference(this.instances.get(userId, instance.arbitrageId) ?? instance, legId)) {
          attempts += 1;
          await this.sleep(Math.min(
            this.options.transientReadRetryIntervalMs ?? 150,
            deadline - this.now(),
          ));
          continue;
        }
        throw error;
      }
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(milliseconds: number) {
    if (milliseconds <= 0) return Promise.resolve();
    return this.options.sleep?.(milliseconds) ?? new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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
  stop?: ArbitrageInstanceExitStopDiagnostic;
  timing?: Readonly<{
    firstLegConfirmedAt: number;
    secondLegProviderDispatchAt: number;
    secondLegExitDelayMs: number;
  }>;
}>;

type ArbitrageInstanceExitStopDiagnostic = Readonly<{
  failedLegId: string | null;
  phase: "INITIAL_STATE" | "JOINT_PREFLIGHT" | "SPOT_FRESH_SAFETY" | "SPOT_CLOSE"
    | "SPOT_CONFIRMATION" | "SPOT_DUST_RECHECK" | "SPOT_DUST_RELEASE"
    | "PERPETUAL_FRESH_SAFETY" | "PERPETUAL_CLOSE" | "PERPETUAL_CONFIRMATION";
  reason: string;
  completedLegIds: readonly string[];
  currentManagedExposure: readonly Readonly<{ legId: string; quantity: string }>[];
}>;

function orderedExitLegs(instance: ArbitrageInstance) {
  if (instance.strategyType === "SPOT_PERPETUAL") {
    return [...instance.legs].sort((left, right) => Number(!left.instrumentId.endsWith("-SPOT"))
      - Number(!right.instrumentId.endsWith("-SPOT")));
  }
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

function hasUnresolvedExecution(instance: ArbitrageInstance) {
  return instance.executionReferences.some((reference) => reference.status === "CLAIMED"
    || reference.status === "LINKED"
    || reference.status === "PENDING_CONFIRMATION"
    || reference.status === "UNKNOWN");
}

function hasConfirmedClosingReference(instance: ArbitrageInstance, legId: string) {
  return instance.executionReferences.some((reference) => reference.legId === legId
    && reference.phase === "CLOSING"
    && reference.status === "CONFIRMED"
    && compareUnsignedDecimals(reference.confirmedQuantity, reference.requestedQuantity) === 0);
}

function pendingWithoutFill(confirmation: Awaited<ReturnType<CloseService["closeLeg"]>>) {
  const record = confirmation.executionRecord;
  return (record.status === "PENDING_CONFIRMATION" || record.status === "SUBMITTED")
    && compareUnsignedDecimals(record.confirmedQuantity, "0") === 0;
}

type ReliableClosingExecutionIdentity = Readonly<{
  executionIntentId: string;
  executionRecordId: string;
}>;

function reliableClosingExecutionIdentity(
  confirmation: Awaited<ReturnType<CloseService["closeLeg"]>>,
  legId: string,
): ReliableClosingExecutionIdentity | null {
  const executionIntentId = confirmation.executionRecord.intentId;
  const executionRecordId = confirmation.executionRecord.executionId;
  if (!executionRecordId) return null;
  const reference = confirmation.instance.executionReferences.find((candidate) =>
    candidate.phase === "CLOSING"
    && candidate.legId === legId
    && candidate.executionIntentId === executionIntentId
    && candidate.executionRecordId === executionRecordId);
  return reference ? Object.freeze({ executionIntentId, executionRecordId }) : null;
}

function assertSameClosingExecutionIdentity(
  confirmation: Awaited<ReturnType<CloseService["closeLeg"]>>,
  legId: string,
  expected: ReliableClosingExecutionIdentity,
) {
  if (confirmation.executionRecord.intentId !== expected.executionIntentId
    || confirmation.executionRecord.executionId !== expected.executionRecordId
    || reliableClosingExecutionIdentity(confirmation, legId) === null) {
    throw new Error("Closing online finalization returned a different execution identity.");
  }
}

function isExecutableExitSafety(
  instance: ArbitrageInstance,
  legId: string,
  safety: Awaited<ReturnType<CloseService["evaluateCloseSafety"]>>,
) {
  if (safety.fullManagedCloseAvailable) return true;
  if (safety.reason !== "QUANTITY_STEP_DUST") return false;
  return safety.safeClosableQuantity !== "0" || hasConfirmedClosingReference(instance, legId);
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

function result(
  instance: ArbitrageInstance,
  status: ArbitrageInstanceExitResult["status"],
  legs: readonly ArbitrageInstanceExitLegResult[],
  stop?: ArbitrageInstanceExitStopDiagnostic,
  timingResult?: ArbitrageInstanceExitResult["timing"],
) {
  return Object.freeze({
    instance,
    status,
    legs: Object.freeze([...legs]),
    ...(stop === undefined ? {} : { stop }),
    ...(timingResult === undefined ? {} : { timing: timingResult }),
  });
}

function stopped(
  instance: ArbitrageInstance,
  legs: readonly ArbitrageInstanceExitLegResult[],
  failedLegId: string | null,
  phase: ArbitrageInstanceExitStopDiagnostic["phase"],
  reason: string,
) {
  return result(instance, "STOPPED", legs, Object.freeze({
    failedLegId,
    phase,
    reason,
    completedLegIds: Object.freeze(legs.filter((leg) => leg.status === "CONFIRMED").map((leg) => leg.legId)),
    currentManagedExposure: Object.freeze(instance.legs.map((leg) => Object.freeze({
      legId: leg.legId,
      quantity: activeManagedQuantity(instance, leg),
    }))),
  }));
}

function phaseFor(leg: ArbitrageInstance["legs"][number], suffix: "FRESH_SAFETY" | "CLOSE" | "CONFIRMATION") {
  return `${leg.instrumentId.endsWith("-SPOT") ? "SPOT" : "PERPETUAL"}_${suffix}` as ArbitrageInstanceExitStopDiagnostic["phase"];
}

function safeCloseErrorReason(error: unknown) {
  return error instanceof ArbitrageExecutionCloseError ? error.category.toUpperCase() : "CLOSE_UNAVAILABLE";
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function timing(firstLegConfirmedAt: number | null, secondLegProviderDispatchAt: number | null) {
  if (firstLegConfirmedAt === null || secondLegProviderDispatchAt === null) return undefined;
  return Object.freeze({
    firstLegConfirmedAt,
    secondLegProviderDispatchAt,
    secondLegExitDelayMs: Math.max(0, secondLegProviderDispatchAt - firstLegConfirmedAt),
  });
}

function unavailableSafety(instance: ArbitrageInstance, legId: string, checkedAt: number): ArbitrageCloseSafetyResult {
  const leg = instance.legs.find((candidate) => candidate.legId === legId)!;
  return Object.freeze({
    activeManagedQuantity: activeManagedQuantity(instance, leg),
    safeClosableQuantity: "0",
    fullManagedCloseAvailable: false,
    reason: "PROVIDER_REALITY_UNAVAILABLE",
    checkedAt,
    positionMode: null,
    actualQuantity: null,
    actualSignedNetQuantity: null,
    actualLongQuantity: null,
    actualShortQuantity: null,
    availableQuantity: null,
  });
}

function legCommandId(commandId: string, legId: string) {
  return `hedge-exit-${createHash("sha256").update(`${commandId}\0${legId}`).digest("hex")}`;
}

function dustReleaseCommandId(commandId: string, legId: string) {
  return `hedge-exit-dust-${createHash("sha256").update(`${commandId}\0${legId}`).digest("hex")}`;
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
