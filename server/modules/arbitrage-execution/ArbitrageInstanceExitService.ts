import { createHash } from "node:crypto";
import {
  activeManagedQuantity,
  compareUnsignedDecimals,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import type { ArbitrageExecutionCommandService } from "./ArbitrageExecutionCommandService";
import type {
  FormalExecutionDiagnostic,
  FormalExecutionMutationDisposition,
} from "./FormalExecutionRuntime";
import {
  ArbitrageExecutionCloseError,
  type ArbitrageExecutionCloseService,
} from "./ArbitrageExecutionCloseService";
import {
  ArbitrageManagementReleaseError,
  createVerifiedDustReleaseContext,
  type DustReleaseReadAttempt,
  type VerifiedDustReleaseContext,
  type ArbitrageManagementReleaseService,
} from "./ArbitrageManagementReleaseService";
import type { ArbitrageCloseSafetyAssessment } from "./ArbitrageCloseSafetyEvaluator";
import {
  finalizeExecutionOnline,
  OnlineReconcileFinalizationError,
  type OnlineReconcileAttempt,
} from "./OnlineReconcileFinalization";

type InstanceStore = Pick<ArbitrageInstanceStore, "get" | "recordCommandOutcome">;
type CloseService = Pick<ArbitrageExecutionCloseService, "closeLeg" | "evaluateCloseSafety"> &
  Partial<Pick<ArbitrageExecutionCloseService, "closeLegForExit" | "evaluateCloseSafetyAssessment">>;
type ReconciliationService = Pick<ArbitrageExecutionCommandService, "reconcileLeg">;
type PositionVerifier = Pick<ArbitragePositionVerificationService, "verify">;
type DustReleaseService = Pick<ArbitrageManagementReleaseService, "releaseDustAfterClose">;

const DEFAULT_CLOSE_FINALIZATION_BUDGET_MS = 15_000;
const DEFAULT_CLOSE_FINALIZATION_INITIAL_POLL_MS = 250;
const DEFAULT_CLOSE_FINALIZATION_MAX_POLL_MS = 2_000;
const DEFAULT_CLOSE_FINALIZATION_MAX_ATTEMPTS = 10;
const DEFAULT_TRANSIENT_READ_RETRY_BUDGET_MS = 15_000;
const DEFAULT_PRE_MUTATION_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_PRE_MUTATION_RETRY_INITIAL_DELAY_MS = 250;
const DEFAULT_PRE_MUTATION_RETRY_MAX_DELAY_MS = 500;

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
      preMutationRetryMaxAttempts?: number;
      preMutationRetryInitialDelayMs?: number;
      preMutationRetryMaxDelayMs?: number;
    }> = {},
  ) {}

  async exit(authenticatedUserId: string, input: unknown) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseExitRequest(input);
    const key = `${userId}\0${request.arbitrageId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.exitWithOutcomeAudit(userId, request);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  private async exitWithOutcomeAudit(userId: string, request: ExitRequest) {
    try {
      const outcome = await this.exitOnce(userId, request);
      this.recordOutcome(userId, request, outcome);
      return outcome;
    } catch (error) {
      this.recordExceptionalOutcome(userId, request, error);
      throw error;
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

    const pendingDustReleases = new Map<string, VerifiedDustReleaseContext>();
    let dustReadAttempts: readonly DustReleaseReadAttempt[] = Object.freeze([]);
    let firstConfirmedAt: number | null = null;
    let secondLegProviderDispatchAt: number | null = null;
    let continuationReadDeadline: number | null = null;
    let lastExecutionDiagnostic: ExitExecutionDiagnostic | undefined;
    let reconcileAttempts: readonly OnlineReconcileAttempt[] = Object.freeze([]);
    for (const leg of orderedLegs) {
      if (instance.status === "CLOSED") break;
      const currentLeg = instance.legs.find((candidate) => candidate.legId === leg.legId)!;
      const quantity = activeManagedQuantity(instance, currentLeg);
      if (quantity === "0") continue;
      if (hasUnresolvedClosingReference(instance, leg.legId)) {
        return stopped(instance, outcomes, leg.legId, phaseFor(leg, "CLOSE"), "UNRESOLVED_EXECUTION");
      }
      const spotLeg = leg.instrumentId.endsWith("-SPOT");
      let dustCompletion = false;
      let closeQuantity = quantity;
      if (spotLeg) {
        const assessment = await this.spotCloseSafetyAssessment(userId, instance, leg.legId);
        const safety = assessment.result;
        dustCompletion = safety.reason === "QUANTITY_STEP_DUST";
        if (!safety.fullManagedCloseAvailable && !dustCompletion) {
          return stopped(instance, outcomes, leg.legId, phaseFor(leg, "FRESH_SAFETY"), safety.reason);
        }
        if (dustCompletion && safety.safeClosableQuantity === "0") {
          if (!hasConfirmedClosingReference(instance, leg.legId)) {
            return stopped(instance, outcomes, leg.legId, "SPOT_DUST_RELEASE", safety.reason);
          }
          const releaseCommandId = dustReleaseCommandId(request.commandId, leg.legId);
          if (!assessment.verifiedDustReleaseFacts) {
            return stopped(instance, outcomes, leg.legId, "SPOT_DUST_RECHECK", "DUST_RELEASE_CONTEXT_UNAVAILABLE");
          }
          pendingDustReleases.set(leg.legId, createVerifiedDustReleaseContext(
            releaseCommandId, assessment.verifiedDustReleaseFacts, this.now(),
          ));
          continue;
        }
        closeQuantity = safety.fullManagedCloseAvailable ? quantity : safety.safeClosableQuantity;
      }
      let confirmation;
      try {
        const closeInput: ExitCloseInput = {
          arbitrageId: instance.arbitrageId,
          legId: leg.legId,
          commandId: legCommandId(request.commandId, leg.legId),
          quantity: closeQuantity,
          executionMode: request.executionMode,
          confirmed: true,
        };
        if (spotLeg) {
          confirmation = await this.closeService.closeLeg(userId, closeInput);
        } else {
          const closeAttempt = await this.closePerpetualWithSafePreMutationRetry(
            userId, instance, leg.legId, closeInput, continuationReadDeadline,
          );
          confirmation = closeAttempt.confirmation;
          lastExecutionDiagnostic = closeAttempt.diagnostic ?? lastExecutionDiagnostic;
        }
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
          const finalized = await this.finalizeClosingLeg(userId, instance.arbitrageId, leg.legId, confirmation);
          confirmation = finalized.confirmation;
          reconcileAttempts = Object.freeze([...reconcileAttempts, ...finalized.attempts]);
        } catch (error) {
          if (error instanceof OnlineReconcileFinalizationError) {
            reconcileAttempts = Object.freeze([...reconcileAttempts, ...error.attempts]);
          }
          instance = this.instances.get(userId, instance.arbitrageId) ?? confirmation.instance;
          return stopped(
            instance,
            outcomes,
            leg.legId,
            phaseFor(leg, "CONFIRMATION"),
            "CLOSE_FINALIZATION_UNAVAILABLE",
            undefined,
            undefined,
            reconcileAttempts,
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
        const diagnostic = executionFailureDiagnostic(confirmation, leg.legId);
        lastExecutionDiagnostic = diagnostic ?? lastExecutionDiagnostic;
        return stopped(
          instance,
          outcomes,
          leg.legId,
          diagnostic?.failureStage === "PRE_MUTATION"
            ? phaseFor(leg, "PRE_MUTATION")
            : phaseFor(leg, "CONFIRMATION"),
          diagnostic?.diagnosticCategory ?? confirmation.executionRecord.status,
          diagnostic,
          undefined,
          reconcileAttempts,
        );
      }
      if (!dispatchedByThisExit && instance.status !== "CLOSED") {
        return stopped(
          instance,
          outcomes,
          leg.legId,
          phaseFor(leg, "CONFIRMATION"),
          "EXISTING_CLOSING_EXECUTION_REQUIRES_USER_CONTINUE",
          undefined,
          undefined,
          reconcileAttempts,
        );
      }
      if (firstConfirmedAt === null) {
        firstConfirmedAt = confirmation.executionRecord.verifiedAt;
        if (spotLeg && instance.strategyType === "SPOT_PERPETUAL") {
          continuationReadDeadline = this.now()
            + (this.options.transientReadRetryBudgetMs ?? DEFAULT_TRANSIENT_READ_RETRY_BUDGET_MS);
        }
      }
      else if (confirmation.providerDispatchStartedAt !== undefined) {
        secondLegProviderDispatchAt = confirmation.providerDispatchStartedAt;
      }
      if (dustCompletion) {
        const remaining = instance.legs.find((candidate) => candidate.legId === leg.legId)!;
        const dustAssessment = await this.spotCloseSafetyAssessment(userId, instance, leg.legId);
        const dustSafety = dustAssessment.result;
        if (activeManagedQuantity(instance, remaining) === "0") continue;
        if (dustSafety.reason !== "QUANTITY_STEP_DUST" || dustSafety.safeClosableQuantity !== "0") {
          return stopped(instance, outcomes, leg.legId, "SPOT_DUST_RECHECK", dustSafety.reason,
            undefined, undefined, reconcileAttempts);
        }
        if (!dustAssessment.verifiedDustReleaseFacts) {
          return stopped(instance, outcomes, leg.legId, "SPOT_DUST_RECHECK", "DUST_RELEASE_CONTEXT_UNAVAILABLE",
            undefined, undefined, reconcileAttempts);
        }
        const releaseCommandId = dustReleaseCommandId(request.commandId, leg.legId);
        pendingDustReleases.set(leg.legId, createVerifiedDustReleaseContext(
          releaseCommandId, dustAssessment.verifiedDustReleaseFacts, this.now(),
        ));
      }
    }

    for (const [legId, verifiedContext] of pendingDustReleases) {
      try {
        const release = await this.managementRelease.releaseDustAfterClose(userId, {
          arbitrageId: instance.arbitrageId,
          legId,
          commandId: dustReleaseCommandId(request.commandId, legId),
          verifiedContext,
        });
        instance = release.instance;
        dustReadAttempts = release.dustReadAttempts;
      } catch (error) {
        dustReadAttempts = error instanceof ArbitrageManagementReleaseError
          ? error.dustReadAttempts : Object.freeze([]);
        return stopped(
          instance, outcomes, legId, "SPOT_DUST_RELEASE", dustReleaseFailureReason(error), undefined, dustReadAttempts,
          reconcileAttempts,
        );
      }
    }
    return result(
      instance,
      instance.status === "CLOSED" ? "CONFIRMED" : "STOPPED",
      outcomes,
      undefined,
      timing(firstConfirmedAt, secondLegProviderDispatchAt),
      lastExecutionDiagnostic,
      dustReadAttempts,
      reconcileAttempts,
    );
  }

  private async spotCloseSafetyAssessment(
    userId: string,
    instance: ArbitrageInstance,
    legId: string,
  ): Promise<ArbitrageCloseSafetyAssessment> {
    if (!this.closeService.evaluateCloseSafetyAssessment) {
      const result = await this.closeService.evaluateCloseSafety(userId, instance.arbitrageId, legId);
      return Object.freeze({ result, context: null, planner: null, market: "SPOT", side: "sell" });
    }
    return this.closeService.evaluateCloseSafetyAssessment(userId, instance.arbitrageId, legId);
  }

  private recordOutcome(userId: string, request: ExitRequest, outcome: ArbitrageInstanceExitResult) {
    const instance = this.instances.get(userId, request.arbitrageId) ?? outcome.instance;
    const reconcileFailure = outcome.status === "CONFIRMED" ? undefined
      : [...(outcome.reconcileAttempts ?? [])].reverse().find((attempt) => attempt.result === "FAILED");
    this.instances.recordCommandOutcome(userId, {
      commandId: request.commandId,
      requestedByUserId: userId,
      arbitrageId: request.arbitrageId,
      operation: "EXIT",
      terminalStatus: outcome.status,
      stopPhase: outcome.stop?.phase ?? null,
      stopReason: outcome.stop?.reason ?? null,
      failedLegId: outcome.stop?.failedLegId ?? null,
      completedLegIds: completedClosingLegIds(instance),
      currentManagedExposure: managedExposureSnapshot(instance),
      mutationDisposition: outcome.executionDiagnostic?.mutationDisposition ?? null,
      diagnosticCategory: outcome.executionDiagnostic?.diagnosticCategory ?? reconcileFailure?.category ?? null,
      failureStage: outcome.executionDiagnostic?.failureStage ?? (reconcileFailure ? "RECONCILIATION" : null),
      providerCode: outcome.executionDiagnostic?.providerCode ?? reconcileFailure?.providerCode ?? null,
      dustReadAttempts: outcome.dustReadAttempts ?? Object.freeze([]),
      reconcileAttempts: outcome.reconcileAttempts ?? Object.freeze([]),
      terminalAt: this.now(),
    });
  }

  private recordExceptionalOutcome(userId: string, request: ExitRequest, error: unknown) {
    const instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) return;
    this.instances.recordCommandOutcome(userId, {
      commandId: request.commandId,
      requestedByUserId: userId,
      arbitrageId: request.arbitrageId,
      operation: "EXIT",
      terminalStatus: "ERROR",
      stopPhase: "ORCHESTRATION",
      stopReason: controlledExitErrorCode(error),
      failedLegId: null,
      completedLegIds: completedClosingLegIds(instance),
      currentManagedExposure: managedExposureSnapshot(instance),
      mutationDisposition: null,
      diagnosticCategory: null,
      failureStage: "ORCHESTRATION",
      providerCode: null,
      dustReadAttempts: error instanceof ArbitrageManagementReleaseError
        ? error.dustReadAttempts : Object.freeze([]),
      reconcileAttempts: Object.freeze([]),
      terminalAt: this.now(),
    });
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
    return finalizeExecutionOnline({
      venue: dispatched.instance.legs.find((leg) => leg.legId === legId)?.venue ?? "unknown",
      initial: dispatched,
      budgetMs,
      initialPollMs,
      maxPollMs,
      maxAttempts,
      now: () => this.now(),
      sleep: (milliseconds) => this.sleep(milliseconds),
      reconcile: () => this.reconciliationService.reconcileLeg(userId, {
        arbitrageId,
        legId,
        executionIntentId: identity.executionIntentId,
      }),
      assertIdentity: (confirmation) => assertSameClosingExecutionIdentity(confirmation, legId, identity),
      isPendingWithoutFill: pendingWithoutFill,
    });
  }

  private async closeWithTransientReadRetry(
    userId: string,
    instance: ArbitrageInstance,
    legId: string,
    input: ExitCloseInput,
    inheritedDeadline: number | null,
  ) {
    const startedAt = this.now();
    const budget = this.options.transientReadRetryBudgetMs ?? DEFAULT_TRANSIENT_READ_RETRY_BUDGET_MS;
    const deadline = inheritedDeadline ?? startedAt + budget;
    const maxAttempts = this.options.transientReadMaxAttempts ?? 3;
    let attempts = 0;
    while (true) {
      attempts += 1;
      try {
        return await (this.closeService.closeLegForExit
          ? this.closeService.closeLegForExit(userId, input, deadline)
          : this.closeService.closeLeg(userId, input));
      } catch (error) {
        if (error instanceof ArbitrageExecutionCloseError
          && (error.category === "position_verification_unavailable"
            || error.category === "instrument_rules_unavailable")
          && attempts < maxAttempts
          && this.now() < deadline
          && !hasClosingReference(this.instances.get(userId, instance.arbitrageId) ?? instance, legId)) {
          await this.sleep(Math.min(
            this.options.transientReadRetryIntervalMs ?? 150,
            deadline - this.now(),
          ));
          if (this.now() >= deadline) throw error;
          continue;
        }
        throw error;
      }
    }
  }

  private async closePerpetualWithSafePreMutationRetry(
    userId: string,
    instance: ArbitrageInstance,
    legId: string,
    input: ExitCloseInput,
    inheritedDeadline: number | null,
  ): Promise<Readonly<{
    confirmation: Awaited<ReturnType<CloseService["closeLeg"]>>;
    diagnostic?: ExitExecutionDiagnostic;
  }>> {
    const budget = this.options.transientReadRetryBudgetMs ?? DEFAULT_TRANSIENT_READ_RETRY_BUDGET_MS;
    const deadline = inheritedDeadline ?? this.now() + budget;
    const maxAttempts = positiveInteger(
      this.options.preMutationRetryMaxAttempts ?? DEFAULT_PRE_MUTATION_RETRY_MAX_ATTEMPTS,
      "preMutationRetryMaxAttempts",
    );
    let delayMs = positiveInteger(
      this.options.preMutationRetryInitialDelayMs ?? DEFAULT_PRE_MUTATION_RETRY_INITIAL_DELAY_MS,
      "preMutationRetryInitialDelayMs",
    );
    const maxDelayMs = positiveInteger(
      this.options.preMutationRetryMaxDelayMs ?? DEFAULT_PRE_MUTATION_RETRY_MAX_DELAY_MS,
      "preMutationRetryMaxDelayMs",
    );
    let lastDiagnostic: ExitExecutionDiagnostic | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const commandId = attempt === 0
        ? String((input as { commandId: string }).commandId)
        : retryLegCommandId(String((input as { commandId: string }).commandId), attempt);
      const confirmation = await this.closeWithTransientReadRetry(
        userId,
        instance,
        legId,
        { ...input, commandId },
        deadline,
      );
      const diagnostic = executionFailureDiagnostic(confirmation, legId);
      if (diagnostic) lastDiagnostic = diagnostic;
      if (!isAuthoritativeNotDispatchedFailure(confirmation)) {
        return Object.freeze({ confirmation, ...(lastDiagnostic ? { diagnostic: lastDiagnostic } : {}) });
      }
      if (attempt + 1 >= maxAttempts || this.now() >= deadline) {
        return Object.freeze({ confirmation, ...(lastDiagnostic ? { diagnostic: lastDiagnostic } : {}) });
      }
      const current = this.instances.get(userId, instance.arbitrageId) ?? confirmation.instance;
      if (hasUnresolvedExecution(current)) {
        return Object.freeze({ confirmation, ...(lastDiagnostic ? { diagnostic: lastDiagnostic } : {}) });
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) return Object.freeze({ confirmation, ...(lastDiagnostic ? { diagnostic: lastDiagnostic } : {}) });
      await this.sleep(Math.min(delayMs, remaining));
      delayMs = Math.min(delayMs * 2, maxDelayMs);
      if (this.now() >= deadline) {
        return Object.freeze({ confirmation, ...(lastDiagnostic ? { diagnostic: lastDiagnostic } : {}) });
      }
    }
    throw new Error("Perpetual pre-mutation retry loop exhausted unexpectedly.");
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

function dustReleaseFailureReason(error: unknown) {
  if (!(error instanceof ArbitrageManagementReleaseError)) return "DUST_RELEASE_PROVIDER_READ_FAILED";
  switch (error.category) {
    case "dust_release_reality_unavailable": return "DUST_RELEASE_REALITY_UNAVAILABLE";
    case "dust_release_eligibility_changed": return "DUST_RELEASE_ELIGIBILITY_CHANGED";
    case "dust_release_attribution_unavailable": return "DUST_RELEASE_ATTRIBUTION_UNAVAILABLE";
    case "dust_release_provider_read_failed": return "DUST_RELEASE_PROVIDER_READ_FAILED";
    default: return "DUST_RELEASE_ELIGIBILITY_CHANGED";
  }
}

type ExitRequest = Readonly<{
  arbitrageId: string;
  commandId: string;
  executionMode: "PRICE_PRIORITY" | "EXECUTION_PRIORITY";
}>;

type ExitCloseInput = Readonly<{
  arbitrageId: string;
  legId: string;
  commandId: string;
  quantity: string;
  executionMode: "PRICE_PRIORITY" | "EXECUTION_PRIORITY";
  confirmed: true;
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
  executionDiagnostic?: ExitExecutionDiagnostic;
  dustReadAttempts?: readonly DustReleaseReadAttempt[];
  reconcileAttempts?: readonly OnlineReconcileAttempt[];
}>;

type ExitFailureStage = "PRE_MUTATION" | "MUTATION_OR_RESPONSE" | "CONFIRMATION" | "ORCHESTRATION";

type ExitExecutionDiagnostic = Readonly<{
  legId: string;
  mutationDisposition: FormalExecutionMutationDisposition;
  diagnosticCategory: string;
  failureStage: ExitFailureStage;
  providerCode?: string;
}>;

type ArbitrageInstanceExitStopDiagnostic = Readonly<{
  failedLegId: string | null;
  phase: "INITIAL_STATE" | "JOINT_PREFLIGHT" | "SPOT_FRESH_SAFETY" | "SPOT_CLOSE"
    | "SPOT_CONFIRMATION" | "SPOT_DUST_RECHECK" | "SPOT_DUST_RELEASE"
    | "PERPETUAL_FRESH_SAFETY" | "PERPETUAL_PRE_MUTATION"
    | "PERPETUAL_CLOSE" | "PERPETUAL_CONFIRMATION";
  reason: string;
  mutationDisposition?: FormalExecutionMutationDisposition;
  diagnosticCategory?: string;
  failureStage?: ExitFailureStage;
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

function hasClosingReference(instance: ArbitrageInstance, legId: string) {
  return instance.executionReferences.some((reference) => reference.legId === legId
    && reference.phase === "CLOSING");
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

function completedClosingLegIds(instance: ArbitrageInstance) {
  return Object.freeze(instance.legs.filter((leg) => hasConfirmedClosingReference(instance, leg.legId))
    .map(({ legId }) => legId));
}

function managedExposureSnapshot(instance: ArbitrageInstance) {
  return Object.freeze(instance.legs.map((leg) => Object.freeze({
    legId: leg.legId,
    quantity: activeManagedQuantity(instance, leg),
  })));
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
  executionDiagnostic?: ExitExecutionDiagnostic,
  dustReadAttempts?: readonly DustReleaseReadAttempt[],
  reconcileAttempts?: readonly OnlineReconcileAttempt[],
) {
  return Object.freeze({
    instance,
    status,
    legs: Object.freeze([...legs]),
    ...(stop === undefined ? {} : { stop }),
    ...(timingResult === undefined ? {} : { timing: timingResult }),
    ...(executionDiagnostic === undefined ? {} : { executionDiagnostic }),
    ...(dustReadAttempts === undefined ? {} : { dustReadAttempts: Object.freeze([...dustReadAttempts]) }),
    ...(reconcileAttempts === undefined ? {} : { reconcileAttempts: Object.freeze([...reconcileAttempts]) }),
  });
}

function stopped(
  instance: ArbitrageInstance,
  legs: readonly ArbitrageInstanceExitLegResult[],
  failedLegId: string | null,
  phase: ArbitrageInstanceExitStopDiagnostic["phase"],
  reason: string,
  diagnostic?: ExitExecutionDiagnostic,
  dustReadAttempts?: readonly DustReleaseReadAttempt[],
  reconcileAttempts?: readonly OnlineReconcileAttempt[],
) {
  return result(instance, "STOPPED", legs, Object.freeze({
    failedLegId,
    phase,
    reason,
    ...(diagnostic === undefined ? {} : {
      mutationDisposition: diagnostic.mutationDisposition,
      diagnosticCategory: diagnostic.diagnosticCategory,
      failureStage: diagnostic.failureStage,
    }),
    completedLegIds: Object.freeze(legs.filter((leg) => leg.status === "CONFIRMED").map((leg) => leg.legId)),
    currentManagedExposure: Object.freeze(instance.legs.map((leg) => Object.freeze({
      legId: leg.legId,
      quantity: activeManagedQuantity(instance, leg),
    }))),
  }), undefined, diagnostic, dustReadAttempts, reconcileAttempts);
}

function phaseFor(
  leg: ArbitrageInstance["legs"][number],
  suffix: "FRESH_SAFETY" | "PRE_MUTATION" | "CLOSE" | "CONFIRMATION",
) {
  return `${leg.instrumentId.endsWith("-SPOT") ? "SPOT" : "PERPETUAL"}_${suffix}` as ArbitrageInstanceExitStopDiagnostic["phase"];
}

function isAuthoritativeNotDispatchedFailure(
  confirmation: Awaited<ReturnType<CloseService["closeLeg"]>>,
) {
  return !confirmation.idempotentReplay
    && confirmation.mutationDisposition === "NOT_DISPATCHED"
    && confirmation.failureStage === "PRE_MUTATION"
    && confirmation.executionRecord.status === "FAILED"
    && compareUnsignedDecimals(confirmation.executionRecord.confirmedQuantity, "0") === 0
    && isRetryablePreMutationCategory(controlledDiagnosticCategory(confirmation.diagnostic));
}

function executionFailureDiagnostic(
  confirmation: Awaited<ReturnType<CloseService["closeLeg"]>>,
  legId: string,
): ExitExecutionDiagnostic | undefined {
  if (confirmation.executionRecord.status === "CONFIRMED") return undefined;
  const mutationDisposition = confirmation.mutationDisposition ?? "UNKNOWN";
  const failureStage: ExitFailureStage = confirmation.failureStage
    ?? (mutationDisposition === "NOT_DISPATCHED"
      ? "PRE_MUTATION"
      : mutationDisposition === "UNKNOWN"
        ? "MUTATION_OR_RESPONSE"
        : "CONFIRMATION");
  return Object.freeze({
    legId,
    mutationDisposition,
    diagnosticCategory: controlledDiagnosticCategory(confirmation.diagnostic),
    failureStage,
    ...(confirmation.diagnostic?.providerCode === undefined
      ? {}
      : { providerCode: confirmation.diagnostic.providerCode }),
  });
}

function controlledDiagnosticCategory(diagnostic?: FormalExecutionDiagnostic) {
  const category = diagnostic?.category?.trim().toUpperCase();
  if (!category || !/^[A-Z][A-Z0-9_]{0,95}$/u.test(category) || category === "EXECUTION_FAILED") {
    return "OTHER_PRE_MUTATION_FAILURE";
  }
  return category;
}

function isRetryablePreMutationCategory(category: string) {
  return category === "ACCOUNT_IDENTITY_UNAVAILABLE"
    || category === "IDENTITY_READ_UNAVAILABLE"
    || category === "POSITION_MODE_UNAVAILABLE"
    || category === "POSITION_REALITY_UNAVAILABLE"
    || category === "INSTRUMENT_RULES_UNAVAILABLE"
    || category === "PROVIDER_TIMEOUT"
    || category === "PROVIDER_TRANSPORT_ERROR"
    || category === "PROVIDER_UNAVAILABLE";
}

function safeCloseErrorReason(error: unknown) {
  return error instanceof ArbitrageExecutionCloseError ? error.category.toUpperCase() : "CLOSE_UNAVAILABLE";
}

function controlledExitErrorCode(error: unknown) {
  if (error instanceof ArbitrageInstanceExitError) return error.category.toUpperCase();
  if (error instanceof ArbitrageExecutionCloseError) return error.category.toUpperCase();
  if (error instanceof ArbitrageManagementReleaseError) return error.category.toUpperCase();
  return "EXIT_INTERNAL_ERROR";
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

function legCommandId(commandId: string, legId: string) {
  return `hedge-exit-${createHash("sha256").update(`${commandId}\0${legId}`).digest("hex")}`;
}

function retryLegCommandId(initialChildCommandId: string, attempt: number) {
  return `hedge-exit-retry-${createHash("sha256")
    .update(`${initialChildCommandId}\0${attempt}`)
    .digest("hex")}`;
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
