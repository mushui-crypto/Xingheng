import { createHash } from "node:crypto";
import type { ExecutionVenue } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import type {
  ArbitrageInstanceStore,
  UnresolvedExecutionRecoveryCandidate,
} from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitrageExecutionPlanningContextSource } from "./ArbitrageExecutionPlanningContext";
import type { ArbitrageRecoveryAuditStore } from "./ArbitrageRecoveryAuditStore";
import type {
  ArbitrageRecoveryAnomalyDetector,
  RecoveryAnomalyClassification,
} from "./ArbitrageRecoveryAnomalyDetector";
import type { ArbitrageStartupRecoveryService } from "./ArbitrageStartupRecoveryService";
import type { SpotOpeningAttributionSource } from "./BinanceSpotOpeningAttributionSource";
import type { FormalExecutionRuntime } from "./FormalExecutionRuntime";

type InstanceStore = Pick<ArbitrageInstanceStore,
  | "get"
  | "listUnresolvedExecutionReferencesForRecovery"
  | "repairLegacyPartialConfirmed"
  | "readSpotOpeningAttributionEvidence"
  | "recordSpotOpeningAttributionEvidence"
  | "sealLegacyUnresolvedExecution"
  | "listLegacyUnresolvedExecutionSealsForUser"
>;

type RuntimeResolver = Readonly<{
  resolve(venue: ExecutionVenue): Pick<FormalExecutionRuntime, "reconcile">;
}>;

type SpotSources = Partial<Record<ExecutionVenue, SpotOpeningAttributionSource>>;

export class ArbitrageRecoveryOperatorError extends Error {
  constructor(
    readonly category:
      | "invalid_recovery_request"
      | "recovery_target_not_found"
      | "manual_review_required"
      | "recovery_evidence_unavailable"
      | "recovery_conflict",
    message: string,
  ) {
    super(message);
  }
}

export class ArbitrageRecoveryOperatorService {
  constructor(
    private readonly instances: InstanceStore,
    private readonly detector: Pick<ArbitrageRecoveryAnomalyDetector, "scan">,
    private readonly startup: Pick<ArbitrageStartupRecoveryService, "readLatestSummary">,
    private readonly records: Pick<ExecutionRecordStore, "loadForUser">,
    private readonly runtimes: RuntimeResolver,
    private readonly contexts: ArbitrageExecutionPlanningContextSource,
    private readonly spotSources: SpotSources,
    private readonly audits: Pick<ArbitrageRecoveryAuditStore, "listForUser">,
    private readonly clock: () => number = Date.now,
  ) {}

  readSummary(authenticatedUserId: string) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const unresolved = this.instances.listUnresolvedExecutionReferencesForRecovery()
      .filter((candidate) => candidate.userId === userId);
    const startup = this.startup.readLatestSummary();
    const startupOutcomes = startup?.outcomes.filter((outcome) => outcome.userId === userId) ?? [];
    const anomaly = this.detector.scan({ userId });
    return Object.freeze({
      unresolvedExecutions: Object.freeze(unresolved),
      startupRecovery: Object.freeze({
        available: startup !== null,
        candidates: startupOutcomes.length,
        outcomes: Object.freeze(startupOutcomes),
      }),
      anomaly,
      manualReviewCount: anomaly.manualReview + anomaly.integrityErrors,
      recoverableCount: anomaly.recoverable,
      recoveryAudit: this.audits.listForUser(userId),
      legacyUnresolvedExecutionSeals: this.instances.listLegacyUnresolvedExecutionSealsForUser(userId),
    });
  }

  async sealLegacyUnresolvedExecution(authenticatedUserId: string, input: unknown) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseLegacySealRequest(input);
    const target = this.requireTarget(userId, request);
    if (!target.reference.executionRecordId) {
      throw operatorError("manual_review_required", "Legacy UNKNOWN has no ExecutionRecord linkage.");
    }
    const record = await this.requireExecutionRecord(userId, target);
    if (target.reference.phase !== "OPENING"
      || target.reference.quantityEffect !== "INCREASE" || target.reference.status !== "UNKNOWN"
      || target.reference.confirmedQuantity !== "0" || record.status !== "UNKNOWN") {
      throw operatorError("recovery_conflict", "Legacy UNKNOWN no longer matches seal eligibility.");
    }
    const sealedAt = now(this.clock);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      operationType: "SEAL_LEGACY_UNRESOLVED_EXECUTION",
      userId,
      arbitrageId: request.arbitrageId,
      legId: request.legId,
      executionIntentId: request.executionIntentId,
      executionRecordId: record.executionId,
      venue: target.leg.venue,
      accountId: target.leg.accountId,
      instrumentId: target.leg.instrumentId,
      reason: request.reason,
    })).digest("hex");
    try {
      const result = this.instances.sealLegacyUnresolvedExecution(userId, request.arbitrageId, {
        commandId: request.commandId,
        operationType: "SEAL_LEGACY_UNRESOLVED_EXECUTION",
        requestedByUserId: userId,
        arbitrageId: request.arbitrageId,
        legId: request.legId,
        executionIntentId: request.executionIntentId,
        executionRecordId: record.executionId,
        venue: target.leg.venue,
        accountId: target.leg.accountId,
        instrumentId: target.leg.instrumentId,
        originalStatus: "UNKNOWN",
        sealStatus: "LEGACY_UNRESOLVED_MANUALLY_SEALED",
        reason: request.reason,
        businessPayloadFingerprint: fingerprint,
        sealedAt,
      });
      return Object.freeze({ ...result, providerMutationCount: 0 });
    } catch (error) {
      throw operatorError("recovery_conflict", safeStoreConflict(error));
    }
  }

  readAnomalies(authenticatedUserId: string, input: unknown = {}) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const filters = parseFilters(input);
    return Object.freeze(this.detector.scan({ userId }).anomalies.filter((item) =>
      (filters.classification === undefined || item.classification === filters.classification)
      && (filters.arbitrageId === undefined || item.arbitrageId === filters.arbitrageId)
      && (filters.executionIntentId === undefined || item.executionIntentId === filters.executionIntentId)));
  }

  async repairLegacyPartialConfirmed(authenticatedUserId: string, input: unknown) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseRepairRequest(input);
    const target = this.requireTarget(userId, request);
    if (target.instance.status !== "CLOSED" && target.instance.status !== "FAILED") {
      throw operatorError("manual_review_required", "Legacy historical repair requires a terminal instance.");
    }
    const currentAnomaly = this.detector.scan({ userId }).anomalies.find((item) =>
      item.code === "LEGACY_PARTIAL_CONFIRMED"
      && item.arbitrageId === request.arbitrageId
      && item.legId === request.legId
      && item.executionIntentId === request.executionIntentId);
    if (!currentAnomaly) {
      throw operatorError("recovery_conflict", "Legacy partial-CONFIRMED evidence no longer matches current data.");
    }
    const record = await this.requireExecutionRecord(userId, target);
    const runtimeResult = await this.reconcileProvider(target.leg.venue, userId, record.executionId);
    assertRuntimeIdentity(runtimeResult.executionRecord, record, target);
    const confirmedQuantity = runtimeResult.confirmedQuantity;
    const providerStatus = runtimeResult.executionRecord.status;
    if (confirmedQuantity === null
      || (providerStatus !== "CONFIRMED" && providerStatus !== "FAILED")) {
      throw operatorError("manual_review_required", "Provider terminal execution evidence remains unavailable.");
    }
    const checkedAt = runtimeResult.executionRecord.updatedAt;
    const updated = this.instances.repairLegacyPartialConfirmed(userId, request.arbitrageId, {
      recoveryId: request.recoveryId,
      actorId: userId,
      executionIntentId: request.executionIntentId,
      status: providerStatus,
      confirmedQuantity,
      evidenceCategory: "PROVIDER_AUTHORITATIVE_TERMINAL_ORDER",
      checkedAt,
      updatedAt: checkedAt,
    });
    const repaired = updated.executionReferences.find(
      ({ executionIntentId }) => executionIntentId === request.executionIntentId,
    )!;
    return Object.freeze({ instance: updated, reference: repaired, providerMutationCount: 0 });
  }

  async backfillSpotAttribution(authenticatedUserId: string, input: unknown) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseRepairRequest(input);
    const target = this.requireTarget(userId, request);
    const currentAnomaly = this.detector.scan({ userId }).anomalies.find((item) =>
      item.code === "MISSING_SPOT_ATTRIBUTION_EVIDENCE"
      && item.arbitrageId === request.arbitrageId
      && item.legId === request.legId
      && item.executionIntentId === request.executionIntentId);
    if (!currentAnomaly || !target.leg.instrumentId.endsWith("-SPOT")
      || target.reference.phase !== "OPENING" || target.reference.quantityEffect !== "INCREASE"
      || target.reference.status !== "CONFIRMED"
      || target.reference.confirmedQuantity !== target.reference.requestedQuantity) {
      throw operatorError("recovery_conflict", "Missing Spot attribution evidence no longer matches current data.");
    }
    if (this.instances.readSpotOpeningAttributionEvidence(
      userId,
      request.arbitrageId,
      request.legId,
    ).length > 0) {
      throw operatorError("manual_review_required", "Existing Spot attribution evidence cannot be overwritten.");
    }
    const record = await this.requireExecutionRecord(userId, target);
    if (record.status !== "CONFIRMED" || !record.remoteOrderId) {
      throw operatorError("manual_review_required", "Spot opening ExecutionRecord is not authoritatively confirmed.");
    }
    const source = this.spotSources[target.leg.venue];
    if (!source) throw operatorError("recovery_evidence_unavailable", "Spot attribution source is unavailable.");
    const context = await this.contexts.load(target.leg.venue, target.leg.instrumentId);
    if (context.instrument.instrumentId !== target.leg.instrumentId) {
      throw operatorError("manual_review_required", "Spot instrument identity is inconsistent.");
    }
    const checkedAt = now(this.clock);
    let attributableBaseQuantity: string;
    try {
      attributableBaseQuantity = await source.readAttributableBaseQuantity(userId, {
        accountId: target.leg.accountId,
        instrumentId: target.leg.instrumentId,
        providerSymbol: context.instrument.providerSymbol,
        baseAsset: context.instrument.baseAsset.symbol,
        executionIntentId: target.reference.executionIntentId,
        executionRecordId: record.executionId,
        grossConfirmedQuantity: target.reference.confirmedQuantity,
      });
    } catch {
      throw operatorError("manual_review_required", "Authoritative Spot fill evidence remains unavailable.");
    }
    const evidence = this.instances.recordSpotOpeningAttributionEvidence(userId, {
      arbitrageId: request.arbitrageId,
      legId: request.legId,
      executionIntentId: request.executionIntentId,
      executionRecordId: record.executionId,
      attributableBaseQuantity,
      source: "PROVIDER_ORDER_FILLS",
      confirmedAt: Math.max(checkedAt, target.reference.updatedAt),
      venue: target.leg.venue,
      accountId: target.leg.accountId,
      instrumentId: target.leg.instrumentId,
    }, {
      recoveryId: request.recoveryId,
      actorId: userId,
      checkedAt,
    });
    return Object.freeze({ evidence, providerMutationCount: 0 });
  }

  private requireTarget(
    userId: string,
    request: Pick<RepairRequest, "arbitrageId" | "legId" | "executionIntentId">,
  ) {
    const instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) throw operatorError("recovery_target_not_found", "Recovery instance was not found.");
    const leg = instance.legs.find(({ legId }) => legId === request.legId);
    const reference = instance.executionReferences.find(
      ({ executionIntentId }) => executionIntentId === request.executionIntentId,
    );
    if (!leg || !reference || reference.legId !== leg.legId) {
      throw operatorError("recovery_target_not_found", "Recovery execution identity was not found.");
    }
    return { instance, leg, reference } as const;
  }

  private async requireExecutionRecord(
    userId: string,
    target: ReturnType<ArbitrageRecoveryOperatorService["requireTarget"]>,
  ) {
    if (!target.reference.executionRecordId) {
      throw operatorError("manual_review_required", "ExecutionRecord linkage is unavailable.");
    }
    const record = await this.records.loadForUser(userId, target.reference.executionRecordId);
    if (!record) throw operatorError("manual_review_required", "ExecutionRecord is unavailable.");
    assertRecordIdentity(record, userId, target);
    return record;
  }

  private async reconcileProvider(venue: ExecutionVenue, userId: string, executionId: string) {
    try {
      return await this.runtimes.resolve(venue).reconcile(userId, executionId);
    } catch {
      throw operatorError("recovery_evidence_unavailable", "Provider execution evidence is unavailable.");
    }
  }
}

type RepairRequest = Readonly<{
  recoveryId: string;
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  confirmed: true;
}>;

type LegacySealRequest = Readonly<{
  commandId: string;
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  reason: "LEGACY_RECOVERY_IDENTITY_GAP";
  confirmed: true;
}>;

function parseLegacySealRequest(input: unknown): LegacySealRequest {
  const value = object(input);
  if (value.confirmed !== true || value.reason !== "LEGACY_RECOVERY_IDENTITY_GAP") {
    throw operatorError("invalid_recovery_request", "Legacy UNKNOWN seal requires explicit confirmation and reason.");
  }
  return Object.freeze({
    commandId: identifier(value.commandId, "commandId"),
    arbitrageId: identifier(value.arbitrageId, "arbitrageId"),
    legId: identifier(value.legId, "legId"),
    executionIntentId: identifier(value.executionIntentId, "executionIntentId"),
    reason: value.reason,
    confirmed: true,
  });
}

function parseRepairRequest(input: unknown): RepairRequest {
  const value = object(input);
  if (value.confirmed !== true) {
    throw operatorError("invalid_recovery_request", "Historical recovery requires explicit confirmation.");
  }
  return Object.freeze({
    recoveryId: identifier(value.recoveryId, "recoveryId"),
    arbitrageId: identifier(value.arbitrageId, "arbitrageId"),
    legId: identifier(value.legId, "legId"),
    executionIntentId: identifier(value.executionIntentId, "executionIntentId"),
    confirmed: true,
  });
}

function parseFilters(input: unknown) {
  const value = object(input);
  const classification = value.classification === undefined ? undefined : classificationValue(value.classification);
  return Object.freeze({
    ...(classification === undefined ? {} : { classification }),
    ...(value.arbitrageId === undefined ? {} : { arbitrageId: identifier(value.arbitrageId, "arbitrageId") }),
    ...(value.executionIntentId === undefined
      ? {}
      : { executionIntentId: identifier(value.executionIntentId, "executionIntentId") }),
  });
}

function classificationValue(value: unknown): RecoveryAnomalyClassification {
  if (value !== "RECOVERABLE" && value !== "MANUAL_REVIEW_REQUIRED" && value !== "DATA_INTEGRITY_ERROR") {
    throw operatorError("invalid_recovery_request", "Recovery anomaly classification is invalid.");
  }
  return value;
}

function assertRecordIdentity(
  record: ExecutionRecord,
  userId: string,
  target: ReturnType<ArbitrageRecoveryOperatorService["requireTarget"]>,
) {
  if (record.intentId !== target.reference.executionIntentId || record.userId !== userId
    || record.venue !== target.leg.venue || record.accountId !== target.leg.accountId
    || record.instrumentId !== target.leg.instrumentId) {
    throw operatorError("manual_review_required", "ExecutionRecord immutable identity is inconsistent.");
  }
}

function assertRuntimeIdentity(
  observed: ExecutionRecord,
  persisted: ExecutionRecord,
  target: ReturnType<ArbitrageRecoveryOperatorService["requireTarget"]>,
) {
  if (observed.executionId !== persisted.executionId || observed.intentId !== persisted.intentId
    || observed.userId !== persisted.userId || observed.venue !== target.leg.venue
    || observed.accountId !== target.leg.accountId || observed.instrumentId !== target.leg.instrumentId) {
    throw operatorError("manual_review_required", "Provider reconciliation identity is inconsistent.");
  }
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw operatorError("invalid_recovery_request", "Recovery request is invalid.");
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw operatorError("invalid_recovery_request", `${name} is invalid.`);
  }
  return value.trim();
}

function now(clock: () => number) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Recovery clock is invalid.");
  return value;
}

function operatorError(
  category: ArbitrageRecoveryOperatorError["category"],
  message: string,
) {
  return new ArbitrageRecoveryOperatorError(category, message);
}

function safeStoreConflict(error: unknown) {
  return error instanceof Error && /idempotency conflict/iu.test(error.message)
    ? "Legacy UNKNOWN seal command conflicts with an existing operation."
    : "Legacy UNKNOWN no longer satisfies the strict seal eligibility boundary.";
}
