import { type ProviderCommandTrace, summarizeProviderTraces } from "../ProviderRequestTrace";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  absoluteDifference,
  activeManagedQuantity,
  addUnsignedDecimals,
  compareUnsignedDecimals,
  managedCurrentQuantity,
  normalizePositiveDecimal,
  normalizeSignedDecimal,
  normalizeUnsignedDecimal,
  type ArbitrageExecutionPhase,
  type ArbitrageExecutionReference,
  type ArbitrageExecutionReferenceStatus,
  type ArbitrageInstance,
  type ArbitrageInstanceLeg,
  type ArbitrageLegManagementRelease,
  type ArbitrageLegacyUnresolvedExecutionSeal,
  type ArbitrageInstanceStatus,
  type ArbitragePnlSummary,
  type ArbitrageQuantityEffect,
  type NewArbitrageInstance,
} from "./ArbitrageInstance";
import { recoveryAuditSchema } from "./ArbitrageRecoveryAuditSchema";
import {
  openingSetupSourcePlanId,
  type ArbitrageOpeningSetup,
} from "../../arbitrage-execution/ArbitrageOpeningSetup";
import type { ExecutionAccountingFactCandidate } from "./ExecutionAccountingFact";
import type { ExecutionAccountingFact } from "./ExecutionAccountingFact";
import { createExecutionAccountingEvidence } from "../ExecutionAccountingEvidence";

const ACTIVE_STATUSES: readonly ArbitrageInstanceStatus[] = ["OPENING", "HOLDING", "RESIDUAL", "CLOSING"];
const HISTORY_STATUSES: readonly ArbitrageInstanceStatus[] = ["CLOSED", "FAILED"];
const UNRESOLVED_REFERENCE_STATUSES: readonly ArbitrageExecutionReferenceStatus[] = [
  "CLAIMED",
  "LINKED",
  "PENDING_CONFIRMATION",
  "UNKNOWN",
];

export type ExecutionReferenceClaim = Readonly<{
  legId: string;
  phase: ArbitrageExecutionPhase;
  quantityEffect: ArbitrageQuantityEffect;
  executionIntentId: string;
  requestedQuantity: string;
  acceptedResidualQuantity?: string;
  commandId?: string;
  operationType?: "EXECUTION_OPEN" | "EXECUTION_CLOSE";
  businessPayloadFingerprint?: string;
  createdAt: number;
}>;

export type ExecutionResultUpdate = Readonly<{
  executionIntentId: string;
  status: "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN";
  confirmedQuantity: string;
  mutationDisposition?: "NOT_DISPATCHED";
  updatedAt: number;
  accountingEvidence?: ExecutionAccountingFactCandidate;
}>;

export type LegacyHistoricalRepair = ExecutionResultUpdate & Readonly<{
  status: "FAILED" | "CONFIRMED";
  recoveryId: string;
  actorId: string;
  evidenceCategory: "PROVIDER_AUTHORITATIVE_TERMINAL_ORDER";
  checkedAt: number;
}>;

export type HistoricalReconcileAudit = Readonly<{
  recoveryId: string;
  actorId: string;
  checkedAt: number;
}>;

export type ManagementReleaseClaim = ArbitrageLegManagementRelease & Readonly<{
  commandId: string;
  operationType: "MANAGEMENT_RELEASE";
  businessPayloadFingerprint: string;
}>;

export type ArbitrageCommandFingerprint = Readonly<{
  commandId: string;
  operationType: "EXECUTION_OPEN" | "EXECUTION_CLOSE" | "MANAGEMENT_RELEASE";
  requestedByUserId: string;
  arbitrageId: string;
  legId: string;
  referenceId: string;
  businessPayloadFingerprint: string;
}>;

export type ArbitrageCommandOutcomeAudit = Readonly<{
  commandId: string;
  requestedByUserId: string;
  arbitrageId: string;
  operation: "START" | "EXIT";
  terminalStatus: string;
  stopPhase: string | null;
  stopReason: string | null;
  failedLegId: string | null;
  completedLegIds: readonly string[];
  currentManagedExposure: readonly Readonly<{ legId: string; quantity: string }>[];
  mutationDisposition?: "NOT_DISPATCHED" | "DISPATCHED_OR_POSSIBLE" | "UNKNOWN" | null;
  diagnosticCategory?: string | null;
  failureStage?: string | null;
  providerCode?: string | null;
  dustReadAttempts?: readonly Readonly<{
    attempt: number;
    substage: "LOCAL_STATE" | "SPOT_BALANCE";
    result: "SUCCESS" | "FAILED";
    retryDecision: "COMPLETE" | "RETRY" | "STOP";
    delayMs: number;
    category: string | null;
    providerCode: string | null;
  }>[];
  reconcileAttempts?: readonly Readonly<{
    attempt: number;
    venue: string;
    substage: string | null;
    result: "SUCCESS" | "FAILED";
    retryDecision: "COMPLETE" | "RETRY" | "STOP";
    delayMs: number;
    category: string | null;
    providerCode: string | null;
  }>[];
  terminalAt: number;
  businessPayloadFingerprint: string;
}>;

export type ManagementReleaseResult = Readonly<{
  instance: ArbitrageInstance;
  release: ArbitrageLegManagementRelease;
  idempotentReplay: boolean;
}>;

export type UnstartedArbitrageAbandonmentClaim = Readonly<{
  commandId: string;
  operationType: "ABANDON_UNSTARTED_ARBITRAGE";
  requestedByUserId: string;
  arbitrageId: string;
  reason: "USER_ABANDONED_BEFORE_EXECUTION";
  businessPayloadFingerprint: string;
  requestedAt: number;
  confirmedAt: number;
}>;

export type UnstartedArbitrageAbandonmentAudit = Readonly<{
  commandId: string;
  operationType: "ABANDON_UNSTARTED_ARBITRAGE";
  requestedByUserId: string;
  arbitrageId: string;
  previousStatus: "OPENING";
  newStatus: "FAILED";
  reason: "USER_ABANDONED_BEFORE_EXECUTION";
  businessPayloadFingerprint: string;
  requestedAt: number;
  confirmedAt: number;
}>;

export type UnstartedArbitrageAbandonmentResult = Readonly<{
  instance: ArbitrageInstance;
  audit: UnstartedArbitrageAbandonmentAudit;
  idempotentReplay: boolean;
}>;

export type LegacyUnresolvedExecutionSealClaim = ArbitrageLegacyUnresolvedExecutionSeal;

export type LegacyUnresolvedExecutionSealResult = Readonly<{
  instance: ArbitrageInstance;
  seal: ArbitrageLegacyUnresolvedExecutionSeal;
  idempotentReplay: boolean;
}>;

export type TargetQuantityUpdate = Readonly<{
  legId: string;
  plannedQuantity: string;
}>;

export type SecondLegHedgePreparation = Readonly<{
  firstExecutionIntentId: string;
  secondLegId: string;
  targetBaseQuantity: string;
  executableBaseQuantity: string;
  updatedAt: number;
}>;

export type SpotOpeningAttributionEvidence = Readonly<{
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  executionRecordId: string;
  attributableBaseQuantity: string;
  source: "PROVIDER_ORDER_FILLS";
  confirmedAt: number;
  venue: ArbitrageInstanceLeg["venue"];
  accountId: string;
  instrumentId: string;
}>;

export type SpotAttributionRecoveryAudit = Readonly<{
  recoveryId: string;
  actorId: string;
  checkedAt: number;
}>;

type PreparedSecondLegHedge = Readonly<{
  targetBaseQuantity: string;
  executableBaseQuantity: string;
  residualBaseQuantity: string;
}>;

export type ArbitrageHistoryPageQuery = Readonly<{
  limit: number;
  offset: number;
}>;

export type UnresolvedExecutionRecoveryCandidate = Readonly<{
  userId: string;
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  executionRecordId: string | null;
  status: Extract<ArbitrageExecutionReferenceStatus, "CLAIMED" | "LINKED" | "PENDING_CONFIRMATION" | "UNKNOWN">;
  phase: ArbitrageExecutionPhase;
  quantityEffect: ArbitrageQuantityEffect;
  requestedQuantity: string;
  confirmedQuantity: string;
  venue: ArbitrageInstanceLeg["venue"];
  accountId: string;
  instrumentId: string;
  role: ArbitrageInstanceLeg["role"];
  createdAt: number;
  updatedAt: number;
}>;

type InstanceRow = Readonly<{
  arbitrageId: string;
  userId: string;
  strategyType: string;
  sourcePlanId: string | null;
  maxResidualBaseQuantity: string;
  status: string;
  createdAt: number;
  openedAt: number | null;
  updatedAt: number;
  closedAt: number | null;
  pnlAsset: string | null;
  cumulativeFundingPnl: string | null;
  realizedTradingPnl: string | null;
  feesCosts: string | null;
  cumulativeNetPnl: string | null;
  pnlUpdatedAt: number | null;
}>;

type LegRow = Readonly<{
  arbitrageId: string;
  legId: string;
  role: string;
  venue: string;
  accountId: string;
  instrumentId: string;
  plannedQuantity: string;
  confirmedOpenedQuantity: string;
  confirmedClosedQuantity: string;
}>;

type ReferenceRow = Readonly<{
  arbitrageId: string;
  legId: string;
  phase: string;
  quantityEffect: string;
  executionIntentId: string;
  executionRecordId: string | null;
  requestedQuantity: string;
  confirmedQuantity: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}>;

type ExecutionAccountingFactRow = Readonly<{
  executionRecordId: string;
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  providerOrderId: string;
  executionPhase: string;
  quantityEffect: string;
  terminalExecutionStatus: string;
  filledQuantity: string;
  averageFillPrice: string | null;
  feeAmountProvider: string | null;
  feeAsset: string | null;
  tradingFeeNetCostUsdt: string | null;
  confirmedAt: number;
  priceCompleteness: string;
  feeCompleteness: string;
  integrityStatus: string;
  completeness: string;
  createdAt: number;
}>;

type UnresolvedRecoveryCandidateRow = Readonly<{
  userId: string;
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  executionRecordId: string | null;
  status: string;
  phase: string;
  quantityEffect: string;
  requestedQuantity: string;
  confirmedQuantity: string;
  venue: string;
  accountId: string;
  instrumentId: string;
  role: string;
  createdAt: number;
  updatedAt: number;
}>;

type ManagementReleaseRow = Readonly<{
  releaseId: string;
  arbitrageId: string;
  legId: string;
  releasedQuantity: string;
  reason: string;
  source: string;
  requestedByUserId: string;
  requestedAt: number;
  confirmedAt: number;
  venue: string;
  accountId: string;
  instrumentId: string;
  positionMode: string;
  actualQuantity: string;
  actualSignedNetQuantity: string | null;
  actualLongQuantity: string;
  actualShortQuantity: string;
  availableQuantity: string | null;
  realityCheckedAt: number;
}>;

type CommandIdempotencyRow = Readonly<{
  commandId: string;
  operationType: string;
  requestedByUserId: string;
  arbitrageId: string;
  legId: string;
  referenceId: string;
  businessPayloadFingerprint: string | null;
  createdAt: number;
}>;

type CommandOutcomeAuditRow = Readonly<{
  commandId: string;
  requestedByUserId: string;
  arbitrageId: string;
  operation: "START" | "EXIT";
  terminalStatus: string;
  stopPhase: string | null;
  stopReason: string | null;
  failedLegId: string | null;
  completedLegIdsJson: string;
  currentManagedExposureJson: string;
  mutationDisposition: "NOT_DISPATCHED" | "DISPATCHED_OR_POSSIBLE" | "UNKNOWN" | null;
  diagnosticCategory: string | null;
  failureStage: string | null;
  providerCode: string | null;
  dustReadAttemptsJson: string;
  reconcileAttemptsJson: string;
  terminalAt: number;
  businessPayloadFingerprint: string;
}>;

type UnstartedArbitrageAbandonmentRow = Readonly<{
  commandId: string;
  operationType: "ABANDON_UNSTARTED_ARBITRAGE";
  requestedByUserId: string;
  arbitrageId: string;
  previousStatus: "OPENING";
  newStatus: "FAILED";
  reason: "USER_ABANDONED_BEFORE_EXECUTION";
  businessPayloadFingerprint: string;
  requestedAt: number;
  confirmedAt: number;
}>;

type LegacyUnresolvedExecutionSealRow = ArbitrageLegacyUnresolvedExecutionSeal;

type SpotOpeningAttributionEvidenceRow = Readonly<{
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  executionRecordId: string;
  attributableBaseQuantity: string;
  source: string;
  confirmedAt: number;
  venue: string;
  accountId: string;
  instrumentId: string;
}>;

type OpeningSetupRow = Readonly<{
  arbitrageId: string;
  sourcePlanId: string;
  opportunityId: string;
  horizonDays: number;
  quantityInputJson: string;
  executionMode: string;
  createdAt: number;
}>;

export class ArbitrageInstanceStore {
  private readonly db: DatabaseSync;

  constructor(options: Readonly<{ dbPath?: string }> = {}) {
    const dbPath = options.dbPath
      ?? process.env.TRADING_DB_PATH
      ?? resolve(process.cwd(), "server/data/trading.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
    // Optional observability must not block execution/store startup.
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS provider_command_traces (
        traceId TEXT PRIMARY KEY, userId TEXT NOT NULL, instanceId TEXT NOT NULL,
        commandId TEXT NOT NULL, startedAt INTEGER NOT NULL, traceJson TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS provider_traces_command ON provider_command_traces(userId, commandId);
      CREATE INDEX IF NOT EXISTS provider_traces_instance ON provider_command_traces(userId, instanceId);`);
    } catch { /* best effort; missing trace means incomplete evidence */ }
  }

  recordProviderTrace(trace: ProviderCommandTrace) {
    this.db.prepare(`INSERT OR IGNORE INTO provider_command_traces
      (traceId,userId,instanceId,commandId,startedAt,traceJson) VALUES (?,?,?,?,?,?)`)
      .run(trace.traceId, trace.userId, trace.instanceId, trace.commandId, trace.startedAt, JSON.stringify(trace));
    // Only this observational table is pruned; never execution/reference/ledger/outcome audit.
    this.db.prepare("DELETE FROM provider_command_traces WHERE startedAt < ?")
      .run(Date.now() - 30 * 24 * 60 * 60 * 1000);
    this.db.exec(`DELETE FROM provider_command_traces WHERE traceId IN
      (SELECT traceId FROM provider_command_traces ORDER BY startedAt DESC LIMIT -1 OFFSET 5000)`);
  }

  readProviderTraces(userId: string, instanceId: string, commandId?: string) {
    const rows = this.db.prepare(`SELECT traceJson FROM provider_command_traces
      WHERE userId=? AND instanceId=? ${commandId === undefined ? "" : "AND commandId=?"} ORDER BY startedAt`)
      .all(...(commandId === undefined ? [userId, instanceId] : [userId, instanceId, commandId])) as { traceJson: string }[];
    const traces = rows.map(row => JSON.parse(row.traceJson) as ProviderCommandTrace);
    return { traces, summary: summarizeProviderTraces(traces) };
  }

  create(input: NewArbitrageInstance, openingSetup?: ArbitrageOpeningSetup): ArbitrageInstance {
    const instance = normalizeNewInstance(input);
    const normalizedOpeningSetup = openingSetup === undefined ? null : normalizeOpeningSetup(openingSetup);
    if (normalizedOpeningSetup && instance.sourcePlanId !== openingSetupSourcePlanId(normalizedOpeningSetup)) {
      throw new Error("Arbitrage opening setup does not match source plan identity.");
    }
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO arbitrage_instances (
        arbitrageId, userId, strategyType, sourcePlanId, maxResidualBaseQuantity,
        status, createdAt, openedAt, updatedAt, closedAt,
        pnlAsset, cumulativeFundingPnl, realizedTradingPnl, feesCosts,
        cumulativeNetPnl, pnlUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, 'OPENING', ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`).run(
        instance.arbitrageId,
        instance.userId,
        instance.strategyType,
        instance.sourcePlanId,
        instance.maxResidualBaseQuantity,
        instance.createdAt,
        instance.createdAt,
      );
      const insertLeg = this.db.prepare(`INSERT INTO arbitrage_instance_legs (
        arbitrageId, legId, role, venue, accountId, instrumentId,
        plannedQuantity, confirmedOpenedQuantity, confirmedClosedQuantity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', '0')`);
      for (const leg of instance.legs) {
        insertLeg.run(
          instance.arbitrageId,
          leg.legId,
          leg.role,
          leg.venue,
          leg.accountId,
          leg.instrumentId,
          leg.plannedQuantity,
        );
      }
      if (normalizedOpeningSetup) {
        this.db.prepare(`INSERT INTO arbitrage_instance_opening_setups (
          arbitrageId, sourcePlanId, opportunityId, horizonDays,
          quantityInputJson, executionMode, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          instance.arbitrageId,
          instance.sourcePlanId,
          normalizedOpeningSetup.opportunityId,
          normalizedOpeningSetup.horizonDays,
          JSON.stringify(normalizedOpeningSetup.quantityInput),
          normalizedOpeningSetup.executionMode,
          instance.createdAt,
        );
      }
      return this.requireForUser(instance.userId, instance.arbitrageId);
    });
  }

  readUnstartedOpeningSetup(userId: string, arbitrageId: string): ArbitrageOpeningSetup | null {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const instance = this.get(normalizedUserId, normalizedArbitrageId);
    if (!instance || !this.isStrictlyUnstarted(instance)) return null;
    const row = this.db.prepare(`SELECT setup.* FROM arbitrage_instance_opening_setups setup
      JOIN arbitrage_instances owner ON owner.arbitrageId = setup.arbitrageId
      WHERE owner.userId = ? AND setup.arbitrageId = ?`).get(
        normalizedUserId,
        normalizedArbitrageId,
      ) as OpeningSetupRow | undefined;
    if (!row || row.sourcePlanId !== instance.sourcePlanId) return null;
    const setup = openingSetupFromRow(row);
    if (openingSetupSourcePlanId(setup) !== row.sourcePlanId) {
      throw new Error("Persisted arbitrage opening setup identity is invalid.");
    }
    return setup;
  }

  private isStrictlyUnstarted(instance: ArbitrageInstance) {
    if (!isUnstartedEmptyOpening(instance)
      || instance.legs.some((leg) => leg.confirmedOpenedQuantity !== "0"
        || leg.confirmedClosedQuantity !== "0" || activeManagedQuantity(instance, leg) !== "0")
      || (instance.managementReleases?.length ?? 0) !== 0) return false;
    return !(
      this.db.prepare(`SELECT 1 FROM arbitrage_execution_references WHERE arbitrageId = ? LIMIT 1`).get(instance.arbitrageId)
      ?? this.db.prepare(`SELECT 1 FROM arbitrage_command_idempotency
        WHERE arbitrageId = ? AND operationType IN ('EXECUTION_OPEN', 'EXECUTION_CLOSE') LIMIT 1`).get(instance.arbitrageId)
      ?? this.db.prepare(`SELECT 1 FROM arbitrage_spot_opening_attribution_evidence
        WHERE arbitrageId = ? LIMIT 1`).get(instance.arbitrageId)
    );
  }

  get(userId: string, arbitrageId: string): ArbitrageInstance | null {
    const row = this.instanceRow(identifier(userId, "userId"), identifier(arbitrageId, "arbitrageId"));
    return row ? this.instanceFromRow(row) : null;
  }

  recordCommandOutcome(
    userId: string,
    outcome: Omit<ArbitrageCommandOutcomeAudit, "businessPayloadFingerprint">,
  ): ArbitrageCommandOutcomeAudit {
    const normalized = normalizeCommandOutcomeAudit(userId, outcome);
    return this.transaction(() => {
      const owner = this.requireForUser(normalized.requestedByUserId, normalized.arbitrageId);
      if (owner.arbitrageId !== normalized.arbitrageId) {
        throw new Error("Arbitrage command outcome owner is invalid.");
      }
      const existing = this.commandOutcomeByCommand(normalized.commandId);
      if (existing) {
        if (existing.businessPayloadFingerprint !== normalized.businessPayloadFingerprint) {
          throw new Error("Arbitrage command outcome idempotency conflict.");
        }
        return commandOutcomeAuditFromRow(existing);
      }
      this.db.prepare(`INSERT INTO arbitrage_command_outcome_audits (
        commandId, requestedByUserId, arbitrageId, operation, terminalStatus,
        stopPhase, stopReason, failedLegId, completedLegIdsJson,
        currentManagedExposureJson, mutationDisposition, diagnosticCategory,
        failureStage, providerCode, dustReadAttemptsJson, reconcileAttemptsJson,
        terminalAt, businessPayloadFingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        normalized.commandId,
        normalized.requestedByUserId,
        normalized.arbitrageId,
        normalized.operation,
        normalized.terminalStatus,
        normalized.stopPhase,
        normalized.stopReason,
        normalized.failedLegId,
        JSON.stringify(normalized.completedLegIds),
        JSON.stringify(normalized.currentManagedExposure),
        normalized.mutationDisposition ?? null,
        normalized.diagnosticCategory ?? null,
        normalized.failureStage ?? null,
        normalized.providerCode ?? null,
        JSON.stringify(normalized.dustReadAttempts ?? []),
        JSON.stringify(normalized.reconcileAttempts ?? []),
        normalized.terminalAt,
        normalized.businessPayloadFingerprint,
      );
      const persisted = this.commandOutcomeByCommand(normalized.commandId);
      if (!persisted) throw new Error("Arbitrage command outcome audit persistence failed.");
      return commandOutcomeAuditFromRow(persisted);
    });
  }

  listCommandOutcomesForUser(userId: string): readonly ArbitrageCommandOutcomeAudit[] {
    const rows = this.db.prepare(`SELECT outcome.*
      FROM arbitrage_command_outcome_audits outcome
      JOIN arbitrage_instances owner ON owner.arbitrageId = outcome.arbitrageId
      WHERE owner.userId = ? ORDER BY outcome.terminalAt DESC, outcome.commandId ASC`).all(
        identifier(userId, "userId"),
      ) as unknown as CommandOutcomeAuditRow[];
    return Object.freeze(rows.map(commandOutcomeAuditFromRow));
  }

  readSpotOpeningAttributionEvidence(userId: string, arbitrageId: string, legId: string) {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalizedLegId = identifier(legId, "legId");
    const instance = this.get(normalizedUserId, normalizedArbitrageId);
    if (!instance || !instance.legs.some((leg) => leg.legId === normalizedLegId)) return Object.freeze([]);
    const rows = this.db.prepare(`SELECT * FROM arbitrage_spot_opening_attribution_evidence
      WHERE arbitrageId = ? AND legId = ? ORDER BY confirmedAt, executionIntentId`).all(
      normalizedArbitrageId,
      normalizedLegId,
    ) as unknown as SpotOpeningAttributionEvidenceRow[];
    return Object.freeze(rows.map(spotOpeningAttributionEvidenceFromRow));
  }

  recordSpotOpeningAttributionEvidence(
    userId: string,
    evidence: SpotOpeningAttributionEvidence,
    recoveryAudit?: SpotAttributionRecoveryAudit,
  ): SpotOpeningAttributionEvidence {
    const normalizedUserId = identifier(userId, "userId");
    const normalized = normalizeSpotOpeningAttributionEvidence(evidence);
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalized.arbitrageId);
      const leg = instance.legs.find((candidate) => candidate.legId === normalized.legId);
      if (!leg || !leg.instrumentId.endsWith("-SPOT") || leg.role !== "LONG"
        || leg.venue !== normalized.venue || leg.accountId !== normalized.accountId
        || leg.instrumentId !== normalized.instrumentId) {
        throw new Error("Spot opening attribution evidence leg identity is invalid.");
      }
      const reference = instance.executionReferences.find((candidate) =>
        candidate.executionIntentId === normalized.executionIntentId);
      const fullyConfirmed = reference?.status === "CONFIRMED"
        && reference.confirmedQuantity === reference.requestedQuantity;
      const terminalPartial = reference?.status === "FAILED"
        && compareUnsignedDecimals(reference.confirmedQuantity, "0") > 0
        && compareUnsignedDecimals(reference.confirmedQuantity, reference.requestedQuantity) < 0;
      if (!reference || reference.legId !== leg.legId || reference.phase !== "OPENING"
        || reference.quantityEffect !== "INCREASE" || (!fullyConfirmed && !terminalPartial)
        || reference.executionRecordId !== normalized.executionRecordId) {
        throw new Error("Spot opening attribution evidence requires authoritative terminal opening fill evidence.");
      }
      if (normalized.confirmedAt < reference.updatedAt) {
        throw new Error("Spot opening attribution evidence cannot predate its confirmed reference.");
      }
      const existing = this.db.prepare(`SELECT * FROM arbitrage_spot_opening_attribution_evidence
        WHERE arbitrageId = ? AND executionIntentId = ?`).get(
        normalized.arbitrageId,
        normalized.executionIntentId,
      ) as unknown as SpotOpeningAttributionEvidenceRow | undefined;
      if (existing) {
        const persisted = spotOpeningAttributionEvidenceFromRow(existing);
        if (!sameSpotOpeningAttributionEvidence(persisted, normalized)) {
          throw new Error("Spot opening attribution evidence is immutable.");
        }
        return persisted;
      }
      this.db.prepare(`INSERT INTO arbitrage_spot_opening_attribution_evidence (
        arbitrageId, legId, executionIntentId, executionRecordId,
        attributableBaseQuantity, source, confirmedAt, venue, accountId, instrumentId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        normalized.arbitrageId,
        normalized.legId,
        normalized.executionIntentId,
        normalized.executionRecordId,
        normalized.attributableBaseQuantity,
        normalized.source,
        normalized.confirmedAt,
        normalized.venue,
        normalized.accountId,
        normalized.instrumentId,
      );
      if (recoveryAudit !== undefined) {
        const recoveryId = identifier(recoveryAudit.recoveryId, "recoveryId");
        const actorId = identifier(recoveryAudit.actorId, "actorId");
        const checkedAt = timestamp(recoveryAudit.checkedAt, "checkedAt");
        this.db.prepare(`INSERT INTO arbitrage_recovery_audit (
          recoveryId, source, actorId, arbitrageId, legId, executionIntentId,
          action, oldStatus, oldQuantity, newStatus, newQuantity, evidenceCategory,
          checkedAt, completedAt, result
        ) VALUES (?, 'AUTHENTICATED_API', ?, ?, ?, ?, 'SPOT_ATTRIBUTION_BACKFILL',
          'MISSING', '0', 'CONFIRMED', ?, 'PROVIDER_AUTHORITATIVE_SPOT_FILLS',
          ?, ?, 'COMPLETED')`).run(
            recoveryId,
            actorId,
            normalized.arbitrageId,
            normalized.legId,
            normalized.executionIntentId,
            normalized.attributableBaseQuantity,
            checkedAt,
            normalized.confirmedAt,
          );
      }
      return normalized;
    });
  }

  failEmptyOpening(userId: string, arbitrageId: string, updatedAt: number): ArbitrageInstance | null {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const timestampValue = timestamp(updatedAt, "updatedAt");
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      const empty = isUnstartedEmptyOpening(instance);
      if (!empty) return null;
      this.persistLifecycle(normalizedUserId, normalizedArbitrageId, {
        status: "FAILED",
        openedAt: instance.openedAt,
        closedAt: null,
        updatedAt: Math.max(timestampValue, instance.updatedAt),
      });
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  abandonUnstarted(
    userId: string,
    arbitrageId: string,
    claim: UnstartedArbitrageAbandonmentClaim,
  ): UnstartedArbitrageAbandonmentResult {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalized = normalizeUnstartedArbitrageAbandonmentClaim(claim);
    if (normalized.requestedByUserId !== normalizedUserId
      || normalized.arbitrageId !== normalizedArbitrageId) {
      throw new Error("Unstarted arbitrage abandonment identity does not match the authenticated instance.");
    }
    return this.transaction(() => {
      const byCommand = this.unstartedAbandonmentByCommand(normalized.commandId);
      if (byCommand) {
        if (!sameUnstartedArbitrageAbandonment(byCommand, normalized)) {
          throw new Error("Unstarted arbitrage abandonment command idempotency conflict.");
        }
        return this.unstartedAbandonmentReplay(normalizedUserId, normalizedArbitrageId, byCommand);
      }
      if (this.commandFingerprint(normalized.commandId)) {
        throw new Error("Unstarted arbitrage abandonment command idempotency conflict.");
      }
      const byFingerprint = this.unstartedAbandonmentByFingerprint(normalized.businessPayloadFingerprint);
      if (byFingerprint) {
        if (!sameUnstartedArbitrageAbandonment(byFingerprint, normalized, false)) {
          throw new Error("Unstarted arbitrage abandonment fingerprint conflict.");
        }
        return this.unstartedAbandonmentReplay(normalizedUserId, normalizedArbitrageId, byFingerprint);
      }
      if (this.unstartedAbandonmentByArbitrageId(normalizedArbitrageId)) {
        throw new Error("Arbitrage instance already has a conflicting abandonment audit.");
      }

      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      if (!isUnstartedEmptyOpening(instance)
        || instance.legs.some((leg) => leg.confirmedOpenedQuantity !== "0"
          || leg.confirmedClosedQuantity !== "0" || activeManagedQuantity(instance, leg) !== "0")
        || (instance.managementReleases?.length ?? 0) !== 0) {
        throw new Error("Arbitrage instance has execution or managed-position facts and cannot be abandoned.");
      }
      const persistedExecutionFacts = this.db.prepare(`SELECT 1
        FROM arbitrage_execution_references WHERE arbitrageId = ? LIMIT 1`).get(normalizedArbitrageId)
        ?? this.db.prepare(`SELECT 1 FROM arbitrage_command_idempotency
          WHERE arbitrageId = ? AND operationType IN ('EXECUTION_OPEN', 'EXECUTION_CLOSE') LIMIT 1`).get(
            normalizedArbitrageId,
          )
        ?? this.db.prepare(`SELECT 1 FROM arbitrage_spot_opening_attribution_evidence
          WHERE arbitrageId = ? LIMIT 1`).get(normalizedArbitrageId);
      if (persistedExecutionFacts) {
        throw new Error("Arbitrage instance has an execution intent, record, or Provider identity and cannot be abandoned.");
      }
      const confirmedAt = Math.max(normalized.confirmedAt, normalized.requestedAt, instance.updatedAt);
      this.db.prepare(`INSERT INTO arbitrage_unstarted_abandonments (
        commandId, operationType, requestedByUserId, arbitrageId, previousStatus,
        newStatus, reason, businessPayloadFingerprint, requestedAt, confirmedAt
      ) VALUES (?, ?, ?, ?, 'OPENING', 'FAILED', ?, ?, ?, ?)`).run(
        normalized.commandId,
        normalized.operationType,
        normalized.requestedByUserId,
        normalized.arbitrageId,
        normalized.reason,
        normalized.businessPayloadFingerprint,
        normalized.requestedAt,
        confirmedAt,
      );
      this.persistLifecycle(normalizedUserId, normalizedArbitrageId, {
        status: "FAILED",
        openedAt: instance.openedAt,
        closedAt: null,
        updatedAt: confirmedAt,
      });
      const row = this.unstartedAbandonmentByCommand(normalized.commandId);
      if (!row) throw new Error("Unstarted arbitrage abandonment audit persistence failed.");
      return Object.freeze({
        instance: this.requireForUser(normalizedUserId, normalizedArbitrageId),
        audit: unstartedArbitrageAbandonmentFromRow(row),
        idempotentReplay: false,
      });
    });
  }

  listUnstartedArbitrageAbandonmentsForUser(
    userId: string,
  ): readonly UnstartedArbitrageAbandonmentAudit[] {
    const rows = this.db.prepare(`SELECT abandonment.*
      FROM arbitrage_unstarted_abandonments abandonment
      JOIN arbitrage_instances owner ON owner.arbitrageId = abandonment.arbitrageId
      WHERE owner.userId = ? ORDER BY abandonment.confirmedAt DESC, abandonment.commandId ASC`).all(
        identifier(userId, "userId"),
      ) as unknown as UnstartedArbitrageAbandonmentRow[];
    return Object.freeze(rows.map(unstartedArbitrageAbandonmentFromRow));
  }

  sealLegacyUnresolvedExecution(
    userId: string,
    arbitrageId: string,
    claim: LegacyUnresolvedExecutionSealClaim,
  ): LegacyUnresolvedExecutionSealResult {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalized = normalizeLegacyUnresolvedExecutionSealClaim(claim);
    if (normalized.requestedByUserId !== normalizedUserId || normalized.arbitrageId !== normalizedArbitrageId) {
      throw new Error("Legacy unresolved execution seal identity does not match the authenticated instance.");
    }
    return this.transaction(() => {
      const byCommand = this.legacySealByCommand(normalized.commandId);
      if (byCommand) {
        if (!sameLegacyUnresolvedExecutionSeal(byCommand, normalized)) {
          throw new Error("Legacy unresolved execution seal command idempotency conflict.");
        }
        return this.legacySealReplay(normalizedUserId, normalizedArbitrageId, byCommand);
      }
      if (this.commandFingerprint(normalized.commandId)) {
        throw new Error("Legacy unresolved execution seal command idempotency conflict.");
      }
      const byFingerprint = this.legacySealByFingerprint(normalized.businessPayloadFingerprint);
      if (byFingerprint) return this.legacySealReplay(normalizedUserId, normalizedArbitrageId, byFingerprint);

      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      const leg = instance.legs.find((candidate) => candidate.legId === normalized.legId);
      const reference = instance.executionReferences.find(
        (candidate) => candidate.executionIntentId === normalized.executionIntentId,
      );
      if (instance.status !== "OPENING" || !leg || !reference || reference.legId !== normalized.legId
        || reference.executionRecordId !== normalized.executionRecordId
        || reference.phase !== "OPENING" || reference.quantityEffect !== "INCREASE"
        || reference.status !== "UNKNOWN" || reference.confirmedQuantity !== "0") {
        throw new Error("Legacy unresolved execution is not eligible for sealing.");
      }
      if (leg.venue !== normalized.venue || leg.accountId !== normalized.accountId
        || leg.instrumentId !== normalized.instrumentId
        || instance.legs.some((candidate) => candidate.confirmedOpenedQuantity !== "0"
          || candidate.confirmedClosedQuantity !== "0" || activeManagedQuantity(instance, candidate) !== "0")
        || (instance.managementReleases?.length ?? 0) !== 0
        || instance.executionReferences.filter((candidate) => UNRESOLVED_REFERENCE_STATUSES.includes(candidate.status)).length !== 1) {
        throw new Error("Legacy unresolved execution has managed exposure or conflicting unresolved facts.");
      }
      const record = this.db.prepare(`SELECT * FROM execution_records
        WHERE executionId = ? AND userId = ? AND intentId = ?`).get(
          normalized.executionRecordId, normalizedUserId, normalized.executionIntentId,
        ) as Record<string, unknown> | undefined;
      if (!record || record.state !== "UNKNOWN" || record.venue !== normalized.venue
        || record.accountId !== normalized.accountId || record.instrumentId !== normalized.instrumentId
        || record.executionAttemptId !== null || record.remoteOrderId !== null) {
        throw new Error("Legacy unresolved execution still has recoverable identity or inconsistent facts.");
      }
      const hasOrderReference = this.tableExists("execution_order_references")
        && Boolean(this.db.prepare(`SELECT 1 FROM execution_order_references
          WHERE executionId = ? LIMIT 1`).get(normalized.executionRecordId));
      if (hasOrderReference) throw new Error("Legacy unresolved execution has recoverable Provider identity.");
      const hasAttribution = Boolean(this.db.prepare(`SELECT 1 FROM arbitrage_spot_opening_attribution_evidence
        WHERE arbitrageId = ? LIMIT 1`).get(normalizedArbitrageId));
      if (hasAttribution) throw new Error("Legacy unresolved execution already has opening attribution evidence.");
      const otherDomainUnresolved = this.db.prepare(`SELECT 1
        FROM arbitrage_execution_references candidateReference
        JOIN arbitrage_instance_legs candidateLeg
          ON candidateLeg.arbitrageId = candidateReference.arbitrageId
          AND candidateLeg.legId = candidateReference.legId
        JOIN arbitrage_instances owner ON owner.arbitrageId = candidateReference.arbitrageId
        WHERE owner.userId = ? AND candidateLeg.venue = ? AND candidateLeg.accountId = ?
          AND candidateLeg.instrumentId = ? AND candidateReference.phase = 'OPENING'
          AND candidateReference.quantityEffect = 'INCREASE'
          AND candidateReference.status IN ('CLAIMED', 'LINKED', 'PENDING_CONFIRMATION', 'UNKNOWN')
          AND NOT (candidateReference.arbitrageId = ? AND candidateReference.executionIntentId = ?)
          AND NOT EXISTS (SELECT 1 FROM arbitrage_legacy_unresolved_execution_seals priorSeal
            WHERE priorSeal.arbitrageId = candidateReference.arbitrageId
              AND priorSeal.executionIntentId = candidateReference.executionIntentId)
        LIMIT 1`).get(
          normalizedUserId, normalized.venue, normalized.accountId, normalized.instrumentId,
          normalizedArbitrageId, normalized.executionIntentId,
        );
      if (otherDomainUnresolved) {
        throw new Error("Legacy unresolved execution domain has a newer unresolved execution.");
      }

      const sealedAt = Math.max(normalized.sealedAt, instance.updatedAt, reference.updatedAt);
      this.db.prepare(`INSERT INTO arbitrage_legacy_unresolved_execution_seals (
        commandId, operationType, requestedByUserId, arbitrageId, legId, executionIntentId,
        executionRecordId, venue, accountId, instrumentId, originalStatus, sealStatus,
        reason, businessPayloadFingerprint, sealedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        normalized.commandId, normalized.operationType, normalized.requestedByUserId,
        normalized.arbitrageId, normalized.legId, normalized.executionIntentId,
        normalized.executionRecordId, normalized.venue, normalized.accountId,
        normalized.instrumentId, normalized.originalStatus, normalized.sealStatus,
        normalized.reason, normalized.businessPayloadFingerprint, sealedAt,
      );
      this.persistLifecycle(normalizedUserId, normalizedArbitrageId, {
        status: "CLOSED", openedAt: instance.openedAt, closedAt: sealedAt, updatedAt: sealedAt,
      });
      const row = this.legacySealByCommand(normalized.commandId);
      if (!row) throw new Error("Legacy unresolved execution seal audit persistence failed.");
      return Object.freeze({
        instance: this.requireForUser(normalizedUserId, normalizedArbitrageId),
        seal: legacyUnresolvedExecutionSealFromRow(row), idempotentReplay: false,
      });
    });
  }

  listLegacyUnresolvedExecutionSealsForUser(userId: string) {
    const rows = this.db.prepare(`SELECT seal.* FROM arbitrage_legacy_unresolved_execution_seals seal
      JOIN arbitrage_instances owner ON owner.arbitrageId = seal.arbitrageId
      WHERE owner.userId = ? ORDER BY seal.sealedAt DESC, seal.commandId ASC`).all(
        identifier(userId, "userId"),
      ) as unknown as LegacyUnresolvedExecutionSealRow[];
    return Object.freeze(rows.map(legacyUnresolvedExecutionSealFromRow));
  }

  listActive(userId: string) {
    return this.listForStatuses(identifier(userId, "userId"), ACTIVE_STATUSES);
  }

  listHistory(userId: string, pagination?: ArbitrageHistoryPageQuery) {
    return this.listForStatuses(
      identifier(userId, "userId"),
      HISTORY_STATUSES,
      pagination === undefined ? undefined : normalizeHistoryPageQuery(pagination),
    );
  }

  listUnresolvedExecutionReferencesForRecovery(): readonly UnresolvedExecutionRecoveryCandidate[] {
    const rows = this.db.prepare(`SELECT
      owner.userId,
      reference.arbitrageId,
      reference.legId,
      reference.executionIntentId,
      reference.executionRecordId,
      reference.status,
      reference.phase,
      reference.quantityEffect,
      reference.requestedQuantity,
      reference.confirmedQuantity,
      leg.venue,
      leg.accountId,
      leg.instrumentId,
      leg.role,
      reference.createdAt,
      reference.updatedAt
      FROM arbitrage_execution_references reference
      JOIN arbitrage_instances owner ON owner.arbitrageId = reference.arbitrageId
      JOIN arbitrage_instance_legs leg
        ON leg.arbitrageId = reference.arbitrageId AND leg.legId = reference.legId
      WHERE reference.status IN ('CLAIMED', 'LINKED', 'PENDING_CONFIRMATION', 'UNKNOWN')
        AND NOT EXISTS (SELECT 1 FROM arbitrage_legacy_unresolved_execution_seals seal
          WHERE seal.arbitrageId = reference.arbitrageId
            AND seal.executionIntentId = reference.executionIntentId)
      ORDER BY reference.createdAt ASC, reference.executionIntentId ASC`).all() as unknown as UnresolvedRecoveryCandidateRow[];
    return Object.freeze(rows.map(unresolvedRecoveryCandidateFromRow));
  }

  terminalizeClaimedReferenceWithLocalNotDispatchedProof(
    userId: string,
    arbitrageId: string,
    executionIntentId: string,
    checkedAt: number,
    auditActor: Readonly<{
      source: "AUTHENTICATED_API" | "SYSTEM_RECOVERY";
      actorId: string;
    }> = { source: "SYSTEM_RECOVERY", actorId: "SYSTEM_RECOVERY" },
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalizedIntentId = identifier(executionIntentId, "executionIntentId");
    const normalizedCheckedAt = timestamp(checkedAt, "checkedAt");
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      const reference = this.referenceRow(normalizedArbitrageId, normalizedIntentId);
      if (!reference
        || reference.status !== "CLAIMED"
        || reference.executionRecordId !== null
        || reference.confirmedQuantity !== "0") {
        throw new Error("Local NOT_DISPATCHED proof no longer matches a zero-quantity CLAIMED reference.");
      }
      const projectedAt = Math.max(instance.updatedAt, reference.updatedAt, normalizedCheckedAt);
      const result = this.db.prepare(`UPDATE arbitrage_execution_references
        SET status = 'FAILED', updatedAt = ?
        WHERE arbitrageId = ? AND executionIntentId = ?
          AND status = 'CLAIMED' AND executionRecordId IS NULL AND confirmedQuantity = '0'`).run(
            projectedAt,
            normalizedArbitrageId,
            normalizedIntentId,
          );
      if (result.changes !== 1) {
        throw new Error("Local NOT_DISPATCHED proof conflicted with another execution update.");
      }
      this.db.prepare(`INSERT INTO arbitrage_recovery_audit (
        recoveryId, source, actorId, arbitrageId, legId, executionIntentId,
        action, oldStatus, oldQuantity, newStatus, newQuantity, evidenceCategory,
        checkedAt, completedAt, result
      ) VALUES (?, ?, ?, ?, ?, ?,
        'LOCAL_NOT_DISPATCHED_TERMINALIZATION', 'CLAIMED', '0', 'FAILED', '0',
        'LOCAL_PRE_DISPATCH_PROOF', ?, ?, 'COMPLETED')`).run(
          recoveryAuditId("LOCAL_NOT_DISPATCHED_TERMINALIZATION", normalizedArbitrageId, normalizedIntentId),
          auditActor.source,
          identifier(auditActor.actorId, "audit actorId"),
          normalizedArbitrageId,
          reference.legId,
          normalizedIntentId,
          normalizedCheckedAt,
          projectedAt,
        );
      const updated = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      const next = this.deriveLifecycle(updated, projectedAt, "NOT_DISPATCHED");
      this.persistLifecycle(normalizedUserId, normalizedArbitrageId, next);
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  readCommandReplay(fingerprint: ArbitrageCommandFingerprint) {
    const normalized = normalizeCommandFingerprint(fingerprint);
    const existing = this.commandFingerprint(normalized.commandId);
    if (!existing) return null;
    if (!sameCommandFingerprint(existing, normalized)) {
      throw new Error("Arbitrage command idempotency conflict.");
    }
    return existing.referenceId;
  }

  claimExecutionReference(
    userId: string,
    arbitrageId: string,
    claim: ExecutionReferenceClaim,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalizedClaim = normalizeClaim(claim);
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      if (normalizedClaim.commandId !== undefined) {
        const existingCommand = this.commandFingerprint(normalizedClaim.commandId);
        if (existingCommand) {
          if (!sameCommandFingerprint(existingCommand, {
            commandId: normalizedClaim.commandId,
            operationType: normalizedClaim.operationType!,
            requestedByUserId: normalizedUserId,
            arbitrageId: normalizedArbitrageId,
            legId: normalizedClaim.legId,
            referenceId: normalizedClaim.executionIntentId,
            businessPayloadFingerprint: normalizedClaim.businessPayloadFingerprint!,
          })) throw new Error("Arbitrage command idempotency conflict.");
          throw new Error("Arbitrage command idempotent replay.");
        }
      }
      if (instance.status === "CLOSED" || instance.status === "FAILED") {
        throw new Error("Terminal arbitrage instance cannot claim another execution.");
      }
      assertPhaseAllowed(instance.status, normalizedClaim.phase);
      if (normalizedClaim.phase === "OPENING" && normalizedClaim.quantityEffect !== "INCREASE") {
        throw new Error("Opening execution must increase managed exposure.");
      }
      if (normalizedClaim.phase === "CLOSING" && normalizedClaim.quantityEffect !== "DECREASE") {
        throw new Error("Closing execution must decrease managed exposure.");
      }
      const leg = instance.legs.find((candidate) => candidate.legId === normalizedClaim.legId);
      if (!leg) throw new Error("Execution reference leg does not belong to the arbitrage instance.");
      if (instance.managementReleases?.some((release) => release.legId === leg.legId)) {
        throw new Error("Released arbitrage leg cannot claim another execution.");
      }
      // Only a formal command claim can dispatch a new Provider mutation.
      // Claims without an operation fingerprint are persisted historical/test
      // facts and must not be mistaken for a fresh dispatch request.
      if (normalizedClaim.phase === "OPENING" && normalizedClaim.operationType === "EXECUTION_OPEN") {
        this.assertOpeningClaimAllowed(instance, leg, normalizedClaim);
      }
      if (normalizedClaim.phase === "CLOSING"
        && compareUnsignedDecimals(normalizedClaim.requestedQuantity, activeManagedQuantity(instance, leg)) > 0) {
        throw new Error("Closing execution cannot exceed active managed quantity.");
      }
      const firstClosingClaim = normalizedClaim.phase === "CLOSING"
        && !instance.executionReferences.some((reference) => reference.phase === "CLOSING");
      if (firstClosingClaim) {
        this.db.prepare(`UPDATE arbitrage_instances SET maxResidualBaseQuantity = '0'
          WHERE userId = ? AND arbitrageId = ?`).run(normalizedUserId, normalizedArbitrageId);
      }
      if (normalizedClaim.acceptedResidualQuantity !== undefined) {
        if (normalizedClaim.phase !== "CLOSING" || normalizedClaim.quantityEffect !== "DECREASE") {
          throw new Error("Accepted residual quantity is only valid for a closing decrease.");
        }
        const currentAcceptedResidual = firstClosingClaim ? "0" : instance.maxResidualBaseQuantity;
        if (compareUnsignedDecimals(normalizedClaim.acceptedResidualQuantity, currentAcceptedResidual) > 0) {
          this.db.prepare(`UPDATE arbitrage_instances SET maxResidualBaseQuantity = ?
            WHERE userId = ? AND arbitrageId = ?`).run(
            normalizedClaim.acceptedResidualQuantity,
            normalizedUserId,
            normalizedArbitrageId,
          );
        }
      }
      if (normalizedClaim.phase === "CLOSING" && instance.executionReferences.some((reference) => (
        reference.legId === normalizedClaim.legId
        && reference.phase === "CLOSING"
        && UNRESOLVED_REFERENCE_STATUSES.includes(reference.status)
      ))) {
        throw new Error("Arbitrage leg already has an unresolved closing execution.");
      }
      try {
        this.db.prepare(`INSERT INTO arbitrage_execution_references (
          arbitrageId, legId, phase, quantityEffect, executionIntentId,
          executionRecordId, requestedQuantity, confirmedQuantity, status, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, '0', 'CLAIMED', ?, ?)`).run(
          normalizedArbitrageId,
          normalizedClaim.legId,
          normalizedClaim.phase,
          normalizedClaim.quantityEffect,
          normalizedClaim.executionIntentId,
          normalizedClaim.requestedQuantity,
          normalizedClaim.createdAt,
          normalizedClaim.createdAt,
        );
        if (normalizedClaim.commandId !== undefined) {
          this.insertCommandFingerprint({
            commandId: normalizedClaim.commandId,
            operationType: normalizedClaim.operationType!,
            requestedByUserId: normalizedUserId,
            arbitrageId: normalizedArbitrageId,
            legId: normalizedClaim.legId,
            referenceId: normalizedClaim.executionIntentId,
            businessPayloadFingerprint: normalizedClaim.businessPayloadFingerprint!,
            createdAt: normalizedClaim.createdAt,
          });
        }
      } catch (error) {
        if (isConstraintError(error)) {
          throw new Error("Execution intent is already claimed by an arbitrage instance.");
        }
        throw error;
      }
      if (normalizedClaim.phase === "CLOSING") {
        this.updateInstanceStatus(normalizedUserId, normalizedArbitrageId, "CLOSING", normalizedClaim.createdAt);
      } else {
        this.touchInstance(normalizedUserId, normalizedArbitrageId, normalizedClaim.createdAt);
      }
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  linkExecutionRecord(
    userId: string,
    arbitrageId: string,
    executionIntentId: string,
    executionRecordId: string,
    updatedAt: number,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalizedIntentId = identifier(executionIntentId, "executionIntentId");
    const normalizedRecordId = identifier(executionRecordId, "executionRecordId");
    const timestampValue = timestamp(updatedAt, "updatedAt");
    return this.transaction(() => {
      this.requireForUser(normalizedUserId, normalizedArbitrageId);
      const reference = this.referenceRow(normalizedArbitrageId, normalizedIntentId);
      if (!reference) throw new Error("Execution reference was not found for the arbitrage instance.");
      if (timestampValue < reference.updatedAt) throw new Error("Execution reference time cannot move backwards.");
      if (reference.executionRecordId !== null) {
        if (reference.executionRecordId === normalizedRecordId) {
          return this.requireForUser(normalizedUserId, normalizedArbitrageId);
        }
        throw new Error("Execution reference is already linked to another execution record.");
      }
      try {
        const result = this.db.prepare(`UPDATE arbitrage_execution_references
          SET executionRecordId = ?, status = 'LINKED', updatedAt = ?
          WHERE arbitrageId = ? AND executionIntentId = ? AND executionRecordId IS NULL`).run(
          normalizedRecordId,
          timestampValue,
          normalizedArbitrageId,
          normalizedIntentId,
        );
        if (result.changes !== 1) throw new Error("Execution reference could not be linked.");
      } catch (error) {
        if (isConstraintError(error)) {
          throw new Error("Execution record is already linked to another arbitrage execution.");
        }
        throw error;
      }
      this.touchInstance(normalizedUserId, normalizedArbitrageId, timestampValue);
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  applyExecutionResult(
    userId: string,
    arbitrageId: string,
    update: ExecutionResultUpdate,
  ): ArbitrageInstance {
    let projected: ArbitrageInstance;
    try {
      projected = this.applyExecutionProjection(userId, arbitrageId, update, false);
    } catch (error) {
      this.markAccountingQuantityConflict(userId, arbitrageId, update);
      throw error;
    }
    this.persistExecutionAccountingEvidence(userId, arbitrageId, update, false);
    return projected;
  }

  listExecutionAccountingFacts(userId: string, arbitrageId: string): readonly ExecutionAccountingFact[] {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    if (!this.get(normalizedUserId, normalizedArbitrageId)) return Object.freeze([]);
    const rows = this.db.prepare(`SELECT fact.* FROM execution_accounting_facts fact
      JOIN arbitrage_instances owner ON owner.arbitrageId = fact.arbitrageId
      WHERE owner.userId = ? AND fact.arbitrageId = ?
      ORDER BY fact.confirmedAt, fact.executionRecordId`).all(
        normalizedUserId,
        normalizedArbitrageId,
      ) as unknown as ExecutionAccountingFactRow[];
    return Object.freeze(rows.map(executionAccountingFactFromRow));
  }

  private persistExecutionAccountingEvidence(
    userId: string,
    arbitrageId: string,
    update: ExecutionResultUpdate,
    authoritativeCorrection: boolean,
  ) {
    if (update.accountingEvidence === undefined) return;
    try {
      this.upsertExecutionAccountingFact(
        userId,
        arbitrageId,
        update.executionIntentId,
        update.accountingEvidence,
        authoritativeCorrection,
      );
    } catch (error) {
      console.error("[accounting] authoritative execution fact upsert failed",
        error instanceof Error ? error.message : "unknown error");
    }
  }

  private upsertExecutionAccountingFact(
    userId: string,
    arbitrageId: string,
    executionIntentId: string,
    evidence: ExecutionAccountingFactCandidate,
    authoritativeCorrection: boolean,
  ) {
    const normalizedEvidence = createExecutionAccountingEvidence(evidence);
    const instance = this.requireForUser(identifier(userId, "userId"), identifier(arbitrageId, "arbitrageId"));
    const reference = instance.executionReferences.find((candidate) => candidate.executionIntentId === executionIntentId);
    if (!reference?.executionRecordId || (reference.phase !== "OPENING" && reference.phase !== "CLOSING")
      || (reference.status !== "CONFIRMED" && reference.status !== "FAILED")
      || reference.confirmedQuantity === "0") return;
    if (normalizeUnsignedDecimal(normalizedEvidence.filledQuantity, "accounting filledQuantity")
      !== normalizeUnsignedDecimal(reference.confirmedQuantity, "reference confirmedQuantity")) {
      throw new Error("Accounting evidence quantity does not match the terminal execution reference.");
    }
    const record = this.db.prepare(`SELECT remoteOrderId FROM execution_records
      WHERE executionId = ? AND intentId = ?`).get(
        reference.executionRecordId,
        reference.executionIntentId,
      ) as { remoteOrderId: string | null } | undefined;
    if (!record?.remoteOrderId || record.remoteOrderId !== normalizedEvidence.providerOrderId) {
      throw new Error("Accounting evidence Provider order identity does not match the execution record.");
    }
    const existingRow = this.db.prepare(`SELECT * FROM execution_accounting_facts
      WHERE executionRecordId = ?`).get(reference.executionRecordId) as ExecutionAccountingFactRow | undefined;
    if (existingRow) {
      const existing = executionAccountingFactFromRow(existingRow);
      this.updateExecutionAccountingFact(existing, normalizedEvidence, reference.status, authoritativeCorrection);
      return;
    }
    const priceCompleteness = normalizedEvidence.averageFillPrice === null ? "INCOMPLETE" : "COMPLETE";
    const feeCompleteness = normalizedEvidence.feeAmountProvider === null
      || normalizedEvidence.tradingFeeNetCostUsdt === null ? "INCOMPLETE" : "COMPLETE";
    const completeness = priceCompleteness === "COMPLETE" && feeCompleteness === "COMPLETE"
      ? "COMPLETE" : "INCOMPLETE";
    this.db.prepare(`INSERT INTO execution_accounting_facts (
      executionRecordId, arbitrageId, legId, executionIntentId, providerOrderId,
      executionPhase, quantityEffect, terminalExecutionStatus, filledQuantity,
      averageFillPrice, feeAmountProvider, feeAsset, tradingFeeNetCostUsdt,
      confirmedAt, priceCompleteness, feeCompleteness, integrityStatus, completeness, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?)`).run(
      reference.executionRecordId,
      instance.arbitrageId,
      reference.legId,
      reference.executionIntentId,
      normalizedEvidence.providerOrderId,
      reference.phase,
      reference.quantityEffect,
      reference.status,
      normalizeUnsignedDecimal(normalizedEvidence.filledQuantity, "accounting filledQuantity"),
      normalizedEvidence.averageFillPrice,
      normalizedEvidence.feeAmountProvider,
      normalizedEvidence.feeAsset,
      normalizedEvidence.tradingFeeNetCostUsdt,
      timestamp(normalizedEvidence.confirmedAt, "accounting confirmedAt"),
      priceCompleteness,
      feeCompleteness,
      completeness,
      timestamp(normalizedEvidence.confirmedAt, "accounting createdAt"),
    );
  }

  private updateExecutionAccountingFact(
    existing: ExecutionAccountingFact,
    evidence: ReturnType<typeof createExecutionAccountingEvidence>,
    terminalStatus: "CONFIRMED" | "FAILED",
    authoritativeCorrection: boolean,
  ) {
    if (existing.providerOrderId !== evidence.providerOrderId) {
      throw new Error("Accounting evidence Provider order identity cannot change.");
    }
    const quantityComparison = compareUnsignedDecimals(evidence.filledQuantity, existing.filledQuantity);
    if (quantityComparison < 0) {
      this.db.prepare(`UPDATE execution_accounting_facts
        SET integrityStatus = 'NEEDS_CHECK', completeness = 'INCOMPLETE'
        WHERE executionRecordId = ?`).run(existing.executionRecordId);
      return;
    }
    const quantityExpanded = quantityComparison > 0;
    const price = mergeAccountingField(
      existing.averageFillPrice,
      evidence.averageFillPrice,
      quantityExpanded,
      authoritativeCorrection,
    );
    const feeEvidenceChanged = existing.feeAmountProvider !== evidence.feeAmountProvider
      || existing.feeAsset !== evidence.feeAsset
      || existing.tradingFeeNetCostUsdt !== evidence.tradingFeeNetCostUsdt;
    const feeReliable = evidence.feeAmountProvider !== null && evidence.tradingFeeNetCostUsdt !== null;
    const existingFeeReliable = existing.feeCompleteness === "COMPLETE"
      && existing.feeAmountProvider !== null && existing.tradingFeeNetCostUsdt !== null;
    const acceptFee = feeReliable && (!existingFeeReliable || quantityExpanded || authoritativeCorrection || !feeEvidenceChanged);
    const conflictingStrongReplay = !authoritativeCorrection && !quantityExpanded
      && ((existing.averageFillPrice !== null && evidence.averageFillPrice !== null
        && existing.averageFillPrice !== evidence.averageFillPrice)
        || (existingFeeReliable && feeReliable && feeEvidenceChanged));
    const integrityStatus = authoritativeCorrection
      ? "VERIFIED"
      : conflictingStrongReplay || existing.integrityStatus === "NEEDS_CHECK" ? "NEEDS_CHECK" : "VERIFIED";
    const feeAmountProvider = acceptFee ? evidence.feeAmountProvider : existing.feeAmountProvider;
    const feeAsset = acceptFee ? evidence.feeAsset : existing.feeAsset;
    const tradingFeeNetCostUsdt = acceptFee
      ? evidence.tradingFeeNetCostUsdt : existing.tradingFeeNetCostUsdt;
    const priceCompleteness = price.reliable ? "COMPLETE" : "INCOMPLETE";
    const feeCompleteness = acceptFee
      ? "COMPLETE"
      : quantityExpanded ? "INCOMPLETE" : existing.feeCompleteness;
    const evidenceEnriched = existing.priceCompleteness === "INCOMPLETE" && priceCompleteness === "COMPLETE"
      || existing.feeCompleteness === "INCOMPLETE" && feeCompleteness === "COMPLETE";
    const confirmedAt = quantityExpanded || authoritativeCorrection
      || evidenceEnriched || existing.terminalExecutionStatus !== terminalStatus
      ? Math.max(existing.confirmedAt, evidence.confirmedAt)
      : existing.confirmedAt;
    const completeness = integrityStatus === "VERIFIED"
      && priceCompleteness === "COMPLETE" && feeCompleteness === "COMPLETE"
      ? "COMPLETE" : "INCOMPLETE";
    this.db.prepare(`UPDATE execution_accounting_facts SET
      terminalExecutionStatus = ?, filledQuantity = ?, averageFillPrice = ?,
      feeAmountProvider = ?, feeAsset = ?, tradingFeeNetCostUsdt = ?, confirmedAt = ?,
      priceCompleteness = ?, feeCompleteness = ?, integrityStatus = ?, completeness = ?
      WHERE executionRecordId = ?`).run(
        terminalStatus,
        evidence.filledQuantity,
        price.value,
        feeAmountProvider,
        feeAsset,
        tradingFeeNetCostUsdt,
        confirmedAt,
        priceCompleteness,
        feeCompleteness,
        integrityStatus,
        completeness,
        existing.executionRecordId,
      );
  }

  applyHistoricalExecutionCorrection(
    userId: string,
    arbitrageId: string,
    update: ExecutionResultUpdate,
    recoveryAudit?: HistoricalReconcileAudit,
  ): ArbitrageInstance {
    let projected: ArbitrageInstance;
    try {
      projected = this.applyExecutionProjection(userId, arbitrageId, update, true, recoveryAudit);
    } catch (error) {
      this.markAccountingQuantityConflict(userId, arbitrageId, update);
      throw error;
    }
    this.persistExecutionAccountingEvidence(userId, arbitrageId, update, true);
    return projected;
  }

  private markAccountingQuantityConflict(userId: string, arbitrageId: string, update: ExecutionResultUpdate) {
    if (update.accountingEvidence === undefined) return;
    try {
      const evidence = createExecutionAccountingEvidence(update.accountingEvidence);
      const row = this.db.prepare(`SELECT fact.* FROM execution_accounting_facts fact
        JOIN arbitrage_instances owner ON owner.arbitrageId = fact.arbitrageId
        WHERE owner.userId = ? AND fact.arbitrageId = ? AND fact.executionIntentId = ?`).get(
          identifier(userId, "userId"),
          identifier(arbitrageId, "arbitrageId"),
          identifier(update.executionIntentId, "executionIntentId"),
        ) as ExecutionAccountingFactRow | undefined;
      if (!row) return;
      const existing = executionAccountingFactFromRow(row);
      if (existing.providerOrderId !== evidence.providerOrderId
        || compareUnsignedDecimals(evidence.filledQuantity, existing.filledQuantity) >= 0) return;
      this.db.prepare(`UPDATE execution_accounting_facts
        SET integrityStatus = 'NEEDS_CHECK', completeness = 'INCOMPLETE'
        WHERE executionRecordId = ?`).run(existing.executionRecordId);
    } catch {
      // Never replace the authoritative execution projection error with accounting diagnostics.
    }
  }

  repairLegacyPartialConfirmed(
    userId: string,
    arbitrageId: string,
    update: LegacyHistoricalRepair,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalizedUpdate = normalizeExecutionResult(update);
    const recoveryId = identifier(update.recoveryId, "recoveryId");
    const actorId = identifier(update.actorId, "actorId");
    const checkedAt = timestamp(update.checkedAt, "checkedAt");
    if (update.evidenceCategory !== "PROVIDER_AUTHORITATIVE_TERMINAL_ORDER") {
      throw new Error("Legacy historical repair evidence is invalid.");
    }
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      if (instance.status !== "CLOSED" && instance.status !== "FAILED") {
        throw new Error("Legacy historical repair requires a terminal arbitrage instance.");
      }
      const reference = this.referenceRow(normalizedArbitrageId, normalizedUpdate.executionIntentId);
      if (!reference || reference.executionRecordId === null
        || reference.status !== "CONFIRMED"
        || compareUnsignedDecimals(reference.confirmedQuantity, reference.requestedQuantity) >= 0) {
        throw new Error("Legacy partial-CONFIRMED evidence no longer matches.");
      }
      const quantityComparison = compareUnsignedDecimals(
        normalizedUpdate.confirmedQuantity,
        reference.requestedQuantity,
      );
      const validProviderTerminal = normalizedUpdate.status === "CONFIRMED"
        ? quantityComparison === 0
        : normalizedUpdate.status === "FAILED" && quantityComparison < 0;
      if (!validProviderTerminal
        || compareUnsignedDecimals(normalizedUpdate.confirmedQuantity, reference.confirmedQuantity) < 0) {
        throw new Error("Legacy repair requires a monotonic authoritative Provider terminal result.");
      }
      const projectedAt = Math.max(instance.updatedAt, reference.updatedAt, normalizedUpdate.updatedAt, checkedAt);
      const confirmedDelta = subtractForDelta(normalizedUpdate.confirmedQuantity, reference.confirmedQuantity);
      if (confirmedDelta !== "0") this.applyQuantityDelta(normalizedArbitrageId, reference, confirmedDelta);
      const changed = this.db.prepare(`UPDATE arbitrage_execution_references
        SET confirmedQuantity = ?, status = ?, updatedAt = ?
        WHERE arbitrageId = ? AND executionIntentId = ?
          AND status = 'CONFIRMED' AND confirmedQuantity = ? AND requestedQuantity = ?`).run(
            normalizedUpdate.confirmedQuantity,
            normalizedUpdate.status,
            projectedAt,
            normalizedArbitrageId,
            normalizedUpdate.executionIntentId,
            reference.confirmedQuantity,
            reference.requestedQuantity,
          );
      if (changed.changes !== 1) throw new Error("Legacy historical repair conflicted with another writer.");
      this.persistLifecycle(normalizedUserId, normalizedArbitrageId, {
        status: instance.status,
        openedAt: instance.openedAt,
        closedAt: instance.closedAt,
        updatedAt: projectedAt,
      });
      this.db.prepare(`INSERT INTO arbitrage_recovery_audit (
        recoveryId, source, actorId, arbitrageId, legId, executionIntentId,
        action, oldStatus, oldQuantity, newStatus, newQuantity, evidenceCategory,
        checkedAt, completedAt, result
      ) VALUES (?, 'AUTHENTICATED_API', ?, ?, ?, ?, 'LEGACY_HISTORICAL_REPAIR',
        'CONFIRMED', ?, ?, ?, ?, ?, ?, 'COMPLETED')`).run(
          recoveryId,
          actorId,
          normalizedArbitrageId,
          reference.legId,
          normalizedUpdate.executionIntentId,
          reference.confirmedQuantity,
          normalizedUpdate.status,
          normalizedUpdate.confirmedQuantity,
          update.evidenceCategory,
          checkedAt,
          projectedAt,
        );
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  private applyExecutionProjection(
    userId: string,
    arbitrageId: string,
    update: ExecutionResultUpdate,
    historicalCorrection: boolean,
    recoveryAudit?: HistoricalReconcileAudit,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalizedUpdate = normalizeExecutionResult(update);
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      const instanceTerminal = instance.status === "CLOSED" || instance.status === "FAILED";
      if (historicalCorrection !== instanceTerminal) {
        throw new Error(historicalCorrection
          ? "Historical execution correction requires a terminal arbitrage instance."
          : "Terminal arbitrage instance requires the historical execution correction path.");
      }
      const reference = this.referenceRow(normalizedArbitrageId, normalizedUpdate.executionIntentId);
      if (!reference) throw new Error("Execution reference was not found for the arbitrage instance.");
      if (reference.executionRecordId === null) {
        throw new Error("Execution reference must link an ExecutionRecord before applying a result.");
      }
      if (historicalCorrection && reference.status !== "CONFIRMED" && reference.status !== "FAILED") {
        throw new Error("Historical execution correction requires an existing terminal execution reference.");
      }
      if (reference.status === "CONFIRMED" || reference.status === "FAILED") {
        if (!terminalStatusCorrectionAllowed(reference, normalizedUpdate)) {
          throw new Error("Terminal execution status cannot be changed.");
        }
        if (compareUnsignedDecimals(normalizedUpdate.confirmedQuantity, reference.confirmedQuantity) < 0) {
          throw new Error("Confirmed execution quantity cannot move backwards.");
        }
        if (compareUnsignedDecimals(normalizedUpdate.confirmedQuantity, reference.requestedQuantity) > 0) {
          throw new Error("Confirmed execution quantity cannot exceed requested quantity.");
        }
        if (reference.status === "CONFIRMED"
          && normalizedUpdate.confirmedQuantity !== reference.requestedQuantity) {
          throw new Error("CONFIRMED execution quantity must equal requested quantity.");
        }
        if (reference.status === normalizedUpdate.status
          && reference.confirmedQuantity === normalizedUpdate.confirmedQuantity) return instance;
      } else {
        if (normalizedUpdate.updatedAt < reference.updatedAt) {
          throw new Error("Execution result time cannot move backwards.");
        }
      }
      if (compareUnsignedDecimals(normalizedUpdate.confirmedQuantity, reference.confirmedQuantity) < 0) {
        throw new Error("Confirmed execution quantity cannot move backwards.");
      }
      if (compareUnsignedDecimals(normalizedUpdate.confirmedQuantity, reference.requestedQuantity) > 0) {
        throw new Error("Confirmed execution quantity cannot exceed requested quantity.");
      }
      if (normalizedUpdate.status === "CONFIRMED"
        && normalizedUpdate.confirmedQuantity !== reference.requestedQuantity) {
        throw new Error("CONFIRMED execution quantity must equal requested quantity.");
      }

      const projectedAt = Math.max(instance.updatedAt, reference.updatedAt, normalizedUpdate.updatedAt);

      const confirmedDelta = subtractForDelta(
        normalizedUpdate.confirmedQuantity,
        reference.confirmedQuantity,
      );
      if (confirmedDelta !== "0") {
        this.applyQuantityDelta(normalizedArbitrageId, reference, confirmedDelta);
      }
      this.db.prepare(`UPDATE arbitrage_execution_references
        SET confirmedQuantity = ?, status = ?, updatedAt = ?
        WHERE arbitrageId = ? AND executionIntentId = ?`).run(
          normalizedUpdate.confirmedQuantity,
          normalizedUpdate.status,
          projectedAt,
          normalizedArbitrageId,
          normalizedUpdate.executionIntentId,
        );

      const next = historicalCorrection
        ? {
            status: instance.status,
            openedAt: instance.openedAt,
            closedAt: instance.closedAt,
            updatedAt: projectedAt,
          }
        : this.deriveLifecycle(
            this.requireForUser(normalizedUserId, normalizedArbitrageId),
            projectedAt,
            normalizedUpdate.mutationDisposition,
          );
      this.persistLifecycle(normalizedUserId, normalizedArbitrageId, next);
      if (historicalCorrection && recoveryAudit !== undefined) {
        const recoveryId = identifier(recoveryAudit.recoveryId, "recoveryId");
        const actorId = identifier(recoveryAudit.actorId, "actorId");
        const checkedAt = timestamp(recoveryAudit.checkedAt, "checkedAt");
        this.db.prepare(`INSERT INTO arbitrage_recovery_audit (
          recoveryId, source, actorId, arbitrageId, legId, executionIntentId,
          action, oldStatus, oldQuantity, newStatus, newQuantity, evidenceCategory,
          checkedAt, completedAt, result
        ) VALUES (?, 'AUTHENTICATED_API', ?, ?, ?, ?, 'HISTORICAL_RECONCILE',
          ?, ?, ?, ?, 'PROVIDER_AUTHORITATIVE_ORDER_QUERY', ?, ?, 'COMPLETED')`).run(
            recoveryId,
            actorId,
            normalizedArbitrageId,
            reference.legId,
            normalizedUpdate.executionIntentId,
            reference.status,
            reference.confirmedQuantity,
            normalizedUpdate.status,
            normalizedUpdate.confirmedQuantity,
            checkedAt,
            projectedAt,
          );
      }
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  releaseLegManagement(
    userId: string,
    arbitrageId: string,
    claim: ManagementReleaseClaim,
  ): ManagementReleaseResult {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalized = normalizeManagementReleaseClaim(claim);
    if (normalized.arbitrageId !== normalizedArbitrageId || normalized.requestedByUserId !== normalizedUserId) {
      throw new Error("Management release identity does not match the authenticated instance.");
    }
    return this.transaction(() => {
      const existingCommand = this.commandFingerprint(normalized.commandId);
      if (existingCommand) {
        if (!sameCommandFingerprint(existingCommand, {
          commandId: normalized.commandId,
          operationType: normalized.operationType,
          requestedByUserId: normalized.requestedByUserId,
          arbitrageId: normalized.arbitrageId,
          legId: normalized.legId,
          referenceId: normalized.releaseId,
          businessPayloadFingerprint: normalized.businessPayloadFingerprint,
        })) throw new Error("Management release command idempotency conflict.");
        const replayInstance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
        const replay = replayInstance.managementReleases?.find((release) => release.releaseId === normalized.releaseId);
        if (!replay) throw new Error("Management release command exists without its release audit record.");
        return Object.freeze({ instance: replayInstance, release: replay, idempotentReplay: true });
      }
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      const replay = instance.managementReleases?.find((release) => release.releaseId === normalized.releaseId);
      if (replay) return Object.freeze({ instance, release: replay, idempotentReplay: true });
      if (instance.status === "CLOSED" || instance.status === "FAILED") {
        throw new Error("Terminal arbitrage instance cannot release managed exposure.");
      }
      if (normalized.confirmedAt < instance.updatedAt) {
        throw new Error("Management release time cannot move backwards.");
      }
      const leg = instance.legs.find((candidate) => candidate.legId === normalized.legId);
      if (!leg) throw new Error("Management release leg does not belong to the arbitrage instance.");
      if (leg.venue !== normalized.venue || leg.accountId !== normalized.accountId
        || leg.instrumentId !== normalized.instrumentId) {
        throw new Error("Management release reality identity does not match the arbitrage leg.");
      }
      if (instance.managementReleases?.some((release) => release.legId === leg.legId)) {
        throw new Error("Arbitrage leg management has already been released.");
      }
      if (instance.executionReferences.some((reference) => UNRESOLVED_REFERENCE_STATUSES.includes(reference.status))) {
        throw new Error("Management release requires every execution reference to be resolved.");
      }
      const activeQuantity = activeManagedQuantity(instance, leg);
      if (activeQuantity === "0") throw new Error("Arbitrage leg has no active managed quantity to release.");
      if (normalized.releasedQuantity !== activeQuantity) {
        throw new Error("Management release must release the full active managed quantity.");
      }
      try {
        this.db.prepare(`INSERT INTO arbitrage_leg_management_releases (
          releaseId, arbitrageId, legId, releasedQuantity, reason, source,
          requestedByUserId, requestedAt, confirmedAt, venue, accountId,
          instrumentId, positionMode, actualQuantity, actualSignedNetQuantity,
          actualLongQuantity, actualShortQuantity, availableQuantity, realityCheckedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          normalized.releaseId,
          normalized.arbitrageId,
          normalized.legId,
          normalized.releasedQuantity,
          normalized.reason,
          normalized.source,
          normalized.requestedByUserId,
          normalized.requestedAt,
          normalized.confirmedAt,
          normalized.venue,
          normalized.accountId,
          normalized.instrumentId,
          normalized.positionMode,
          normalized.actualQuantity,
          normalized.actualSignedNetQuantity,
          normalized.actualLongQuantity,
          normalized.actualShortQuantity,
          normalized.availableQuantity,
          normalized.realityCheckedAt,
        );
        this.insertCommandFingerprint({
          commandId: normalized.commandId,
          operationType: normalized.operationType,
          requestedByUserId: normalized.requestedByUserId,
          arbitrageId: normalized.arbitrageId,
          legId: normalized.legId,
          referenceId: normalized.releaseId,
          businessPayloadFingerprint: normalized.businessPayloadFingerprint,
          createdAt: normalized.requestedAt,
        });
      } catch (error) {
        if (isConstraintError(error)) throw new Error("Management release command idempotency conflict.");
        throw error;
      }
      const updated = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      const next = this.deriveLifecycle(updated, normalized.confirmedAt);
      this.persistLifecycle(normalizedUserId, normalizedArbitrageId, next);
      const persisted = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      const release = persisted.managementReleases?.find((candidate) => candidate.releaseId === normalized.releaseId);
      if (!release) throw new Error("Management release persistence failed.");
      return Object.freeze({ instance: persisted, release, idempotentReplay: false });
    });
  }

  updateTargetQuantities(
    userId: string,
    arbitrageId: string,
    updates: readonly TargetQuantityUpdate[],
    updatedAt: number,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const timestampValue = timestamp(updatedAt, "updatedAt");
    if (!updates.length) throw new Error("At least one target quantity update is required.");
    const normalizedUpdates = updates.map((update) => ({
      legId: identifier(update.legId, "legId"),
      plannedQuantity: normalizePositiveDecimal(update.plannedQuantity, "plannedQuantity"),
    }));
    if (new Set(normalizedUpdates.map(({ legId }) => legId)).size !== normalizedUpdates.length) {
      throw new Error("Target quantity updates contain a duplicate legId.");
    }
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      if (instance.status === "CLOSED" || instance.status === "FAILED") {
        throw new Error("Terminal arbitrage instance cannot update target quantities.");
      }
      if (timestampValue < instance.updatedAt) throw new Error("Arbitrage instance time cannot move backwards.");
      for (const update of normalizedUpdates) {
        if (instance.managementReleases?.some((release) => release.legId === update.legId)) {
          throw new Error("Released arbitrage leg cannot update its target quantity.");
        }
        const result = this.db.prepare(`UPDATE arbitrage_instance_legs
          SET plannedQuantity = ? WHERE arbitrageId = ? AND legId = ?`).run(
          update.plannedQuantity,
          normalizedArbitrageId,
          update.legId,
        );
        if (result.changes !== 1) throw new Error("Target quantity leg was not found for the arbitrage instance.");
      }
      this.touchInstance(normalizedUserId, normalizedArbitrageId, timestampValue);
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  prepareSecondLegHedge(
    userId: string,
    arbitrageId: string,
    input: SecondLegHedgePreparation,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const firstExecutionIntentId = identifier(input.firstExecutionIntentId, "firstExecutionIntentId");
    const secondLegId = identifier(input.secondLegId, "secondLegId");
    const targetBaseQuantity = normalizePositiveDecimal(input.targetBaseQuantity, "targetBaseQuantity");
    const executableBaseQuantity = normalizePositiveDecimal(input.executableBaseQuantity, "executableBaseQuantity");
    const updatedAt = timestamp(input.updatedAt, "updatedAt");
    if (compareUnsignedDecimals(executableBaseQuantity, targetBaseQuantity) > 0) {
      throw new Error("Second-leg executable quantity cannot exceed the first-leg exposure target.");
    }
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      if (instance.status === "CLOSED" || instance.status === "FAILED") {
        throw new Error("Terminal arbitrage instance cannot prepare a second-leg hedge.");
      }
      if ((instance.managementReleases?.length ?? 0) > 0) {
        throw new Error("Released arbitrage instance cannot prepare a second-leg hedge.");
      }
      if (updatedAt < instance.updatedAt) throw new Error("Arbitrage instance time cannot move backwards.");
      const firstReference = this.referenceRow(normalizedArbitrageId, firstExecutionIntentId);
      if (!firstReference
        || firstReference.phase !== "OPENING"
        || firstReference.quantityEffect !== "INCREASE"
        || (firstReference.status !== "CONFIRMED"
          && !(firstReference.status === "FAILED"
            && compareUnsignedDecimals(firstReference.confirmedQuantity, "0") > 0
            && compareUnsignedDecimals(firstReference.confirmedQuantity, firstReference.requestedQuantity) < 0))) {
        throw new Error("Second-leg hedge requires one confirmed or terminal-partial first-leg opening reference.");
      }
      const firstLeg = instance.legs.find((leg) => leg.legId === firstReference.legId);
      const secondLeg = instance.legs.find((leg) => leg.legId === secondLegId);
      if (!firstLeg || !secondLeg || firstLeg.legId === secondLeg.legId) {
        throw new Error("Second-leg hedge leg identity is invalid.");
      }
      const prepared = preparedSecondLegHedge(instance, firstReference, secondLegId);
      if (prepared) {
        if (prepared.targetBaseQuantity !== targetBaseQuantity
          || prepared.executableBaseQuantity !== executableBaseQuantity) {
          throw new Error("Second-leg hedge quantities are already frozen.");
        }
        return instance;
      }
      if (firstLeg.confirmedClosedQuantity !== "0" || secondLeg.confirmedOpenedQuantity !== "0"
        || secondLeg.confirmedClosedQuantity !== "0"
        || instance.executionReferences.some((reference) => reference.legId === secondLegId)) {
        throw new Error("Second-leg hedge cannot replace existing execution state.");
      }
      if (firstLeg.confirmedOpenedQuantity !== firstReference.confirmedQuantity) {
        throw new Error("First-leg managed exposure no longer matches its confirmed opening fact.");
      }
      if (updatedAt <= firstReference.updatedAt) {
        throw new Error("Second-leg hedge preparation must follow the confirmed first-leg fact.");
      }
      this.db.prepare(`UPDATE arbitrage_instance_legs
        SET plannedQuantity = ?, confirmedOpenedQuantity = ?
        WHERE arbitrageId = ? AND legId = ?`).run(
        targetBaseQuantity,
        targetBaseQuantity,
        normalizedArbitrageId,
        firstLeg.legId,
      );
      this.db.prepare(`UPDATE arbitrage_instance_legs SET plannedQuantity = ?
        WHERE arbitrageId = ? AND legId = ?`).run(
        executableBaseQuantity,
        normalizedArbitrageId,
        secondLegId,
      );
      this.db.prepare(`UPDATE arbitrage_instances SET maxResidualBaseQuantity = ?
        WHERE userId = ? AND arbitrageId = ?`).run(
        absoluteDifference(targetBaseQuantity, executableBaseQuantity),
        normalizedUserId,
        normalizedArbitrageId,
      );
      const next = this.deriveLifecycle(
        this.requireForUser(normalizedUserId, normalizedArbitrageId),
        updatedAt,
      );
      this.persistLifecycle(normalizedUserId, normalizedArbitrageId, next);
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  readPreparedSecondLegHedge(
    userId: string,
    arbitrageId: string,
    firstExecutionIntentId: string,
    secondLegId: string,
  ): PreparedSecondLegHedge | null {
    const normalizedIntentId = identifier(firstExecutionIntentId, "firstExecutionIntentId");
    const instance = this.requireForUser(identifier(userId, "userId"), identifier(arbitrageId, "arbitrageId"));
    const reference = instance.executionReferences.find((candidate) =>
      candidate.executionIntentId === normalizedIntentId);
    if (!reference) return null;
    return preparedSecondLegHedge(instance, reference, identifier(secondLegId, "secondLegId"));
  }

  updateCumulativeReturns(
    userId: string,
    arbitrageId: string,
    pnl: ArbitragePnlSummary,
    updatedAt: number,
  ): ArbitrageInstance {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const timestampValue = timestamp(updatedAt, "updatedAt");
    const normalizedPnl = normalizePnl(pnl);
    return this.transaction(() => {
      const instance = this.requireForUser(normalizedUserId, normalizedArbitrageId);
      if (timestampValue < instance.updatedAt) throw new Error("Arbitrage instance time cannot move backwards.");
      this.db.prepare(`UPDATE arbitrage_instances SET
        pnlAsset = ?, cumulativeFundingPnl = ?, realizedTradingPnl = ?, feesCosts = ?,
        cumulativeNetPnl = ?, pnlUpdatedAt = ?, updatedAt = ?
        WHERE userId = ? AND arbitrageId = ?`).run(
        normalizedPnl.asset,
        normalizedPnl.cumulativeFundingPnl,
        normalizedPnl.realizedTradingPnl,
        normalizedPnl.feesCosts,
        normalizedPnl.cumulativeNetPnl,
        normalizedPnl.updatedAt,
        timestampValue,
        normalizedUserId,
        normalizedArbitrageId,
      );
      return this.requireForUser(normalizedUserId, normalizedArbitrageId);
    });
  }

  close() {
    this.db.close();
  }

  private listForStatuses(
    userId: string,
    statuses: readonly ArbitrageInstanceStatus[],
    pagination?: ArbitrageHistoryPageQuery,
  ) {
    const placeholders = statuses.map(() => "?").join(", ");
    const query = `SELECT * FROM arbitrage_instances
      WHERE userId = ? AND status IN (${placeholders})
      ORDER BY createdAt DESC, arbitrageId ASC${pagination ? " LIMIT ? OFFSET ?" : ""}`;
    const parameters = pagination
      ? [userId, ...statuses, pagination.limit, pagination.offset]
      : [userId, ...statuses];
    const rows = this.db.prepare(query).all(...parameters) as unknown as InstanceRow[];
    return rows.map((row) => this.instanceFromRow(row));
  }

  private requireForUser(userId: string, arbitrageId: string) {
    const instance = this.get(userId, arbitrageId);
    if (!instance) throw new Error("Arbitrage instance was not found for the authenticated user.");
    return instance;
  }

  private instanceRow(userId: string, arbitrageId: string) {
    return this.db.prepare(`SELECT * FROM arbitrage_instances
      WHERE userId = ? AND arbitrageId = ?`).get(userId, arbitrageId) as unknown as InstanceRow | undefined;
  }

  private referenceRow(arbitrageId: string, executionIntentId: string) {
    return this.db.prepare(`SELECT * FROM arbitrage_execution_references
      WHERE arbitrageId = ? AND executionIntentId = ?`).get(
      arbitrageId,
      executionIntentId,
    ) as unknown as ReferenceRow | undefined;
  }

  private commandFingerprint(commandId: string) {
    return this.db.prepare(`SELECT commandId, operationType, requestedByUserId, arbitrageId,
        legId, referenceId, businessPayloadFingerprint, createdAt
      FROM arbitrage_command_idempotency WHERE commandId = ?
      UNION ALL
      SELECT commandId, operationType, requestedByUserId, arbitrageId,
        'INSTANCE' AS legId, arbitrageId AS referenceId, businessPayloadFingerprint,
        confirmedAt AS createdAt
      FROM arbitrage_unstarted_abandonments WHERE commandId = ?
      UNION ALL
      SELECT commandId, operationType, requestedByUserId, arbitrageId,
        legId, executionRecordId AS referenceId, businessPayloadFingerprint,
        sealedAt AS createdAt
      FROM arbitrage_legacy_unresolved_execution_seals WHERE commandId = ?
      LIMIT 1`).get(commandId, commandId, commandId) as unknown as CommandIdempotencyRow | undefined;
  }

  private commandOutcomeByCommand(commandId: string) {
    return this.db.prepare(`SELECT * FROM arbitrage_command_outcome_audits
      WHERE commandId = ?`).get(commandId) as unknown as CommandOutcomeAuditRow | undefined;
  }

  private legacySealByCommand(commandId: string) {
    return this.db.prepare(`SELECT * FROM arbitrage_legacy_unresolved_execution_seals
      WHERE commandId = ?`).get(commandId) as unknown as LegacyUnresolvedExecutionSealRow | undefined;
  }

  private legacySealByFingerprint(businessPayloadFingerprint: string) {
    return this.db.prepare(`SELECT * FROM arbitrage_legacy_unresolved_execution_seals
      WHERE businessPayloadFingerprint = ?`).get(
        businessPayloadFingerprint,
      ) as unknown as LegacyUnresolvedExecutionSealRow | undefined;
  }

  private legacySealReplay(userId: string, arbitrageId: string, row: LegacyUnresolvedExecutionSealRow) {
    const instance = this.requireForUser(userId, arbitrageId);
    const reference = instance.executionReferences.find(
      (candidate) => candidate.executionIntentId === row.executionIntentId,
    );
    if (instance.status !== "CLOSED" || instance.closedAt !== row.sealedAt
      || !reference || reference.status !== "UNKNOWN" || reference.confirmedQuantity !== "0"
      || instance.legs.some((leg) => leg.confirmedOpenedQuantity !== "0"
        || leg.confirmedClosedQuantity !== "0" || activeManagedQuantity(instance, leg) !== "0")) {
      throw new Error("Legacy unresolved execution seal audit does not match its lifecycle projection.");
    }
    return Object.freeze({ instance, seal: legacyUnresolvedExecutionSealFromRow(row), idempotentReplay: true });
  }

  private tableExists(name: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  }

  private unstartedAbandonmentByCommand(commandId: string) {
    return this.db.prepare(`SELECT * FROM arbitrage_unstarted_abandonments
      WHERE commandId = ?`).get(commandId) as unknown as UnstartedArbitrageAbandonmentRow | undefined;
  }

  private unstartedAbandonmentByFingerprint(businessPayloadFingerprint: string) {
    return this.db.prepare(`SELECT * FROM arbitrage_unstarted_abandonments
      WHERE businessPayloadFingerprint = ?`).get(
      businessPayloadFingerprint,
    ) as unknown as UnstartedArbitrageAbandonmentRow | undefined;
  }

  private unstartedAbandonmentByArbitrageId(arbitrageId: string) {
    return this.db.prepare(`SELECT * FROM arbitrage_unstarted_abandonments
      WHERE arbitrageId = ?`).get(arbitrageId) as unknown as UnstartedArbitrageAbandonmentRow | undefined;
  }

  private unstartedAbandonmentReplay(
    userId: string,
    arbitrageId: string,
    row: UnstartedArbitrageAbandonmentRow,
  ): UnstartedArbitrageAbandonmentResult {
    const instance = this.requireForUser(userId, arbitrageId);
    if (instance.status !== "FAILED" || instance.executionReferences.length !== 0
      || instance.legs.some((leg) => leg.confirmedOpenedQuantity !== "0"
        || leg.confirmedClosedQuantity !== "0" || managedCurrentQuantity(leg) !== "0")) {
      throw new Error("Unstarted arbitrage abandonment audit does not match its lifecycle projection.");
    }
    return Object.freeze({
      instance,
      audit: unstartedArbitrageAbandonmentFromRow(row),
      idempotentReplay: true,
    });
  }

  private insertCommandFingerprint(row: CommandIdempotencyRow) {
    this.db.prepare(`INSERT INTO arbitrage_command_idempotency (
      commandId, operationType, requestedByUserId, arbitrageId, legId, referenceId,
      businessPayloadFingerprint, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.commandId,
      row.operationType,
      row.requestedByUserId,
      row.arbitrageId,
      row.legId,
      row.referenceId,
      row.businessPayloadFingerprint,
      row.createdAt,
    );
  }

  private instanceFromRow(row: InstanceRow): ArbitrageInstance {
    const legs = this.db.prepare(`SELECT * FROM arbitrage_instance_legs
      WHERE arbitrageId = ? ORDER BY CASE role WHEN 'LONG' THEN 0 ELSE 1 END`).all(
      row.arbitrageId,
    ) as unknown as LegRow[];
    if (legs.length !== 2) throw new Error("Persisted arbitrage instance must contain exactly two legs.");
    const references = this.db.prepare(`SELECT * FROM arbitrage_execution_references
      WHERE arbitrageId = ? ORDER BY createdAt ASC, executionIntentId ASC`).all(
      row.arbitrageId,
    ) as unknown as ReferenceRow[];
    const releases = this.db.prepare(`SELECT * FROM arbitrage_leg_management_releases
      WHERE arbitrageId = ? ORDER BY confirmedAt ASC, releaseId ASC`).all(
      row.arbitrageId,
    ) as unknown as ManagementReleaseRow[];
    const legacySeals = this.db.prepare(`SELECT * FROM arbitrage_legacy_unresolved_execution_seals
      WHERE arbitrageId = ? ORDER BY sealedAt ASC, commandId ASC`).all(
        row.arbitrageId,
      ) as unknown as LegacyUnresolvedExecutionSealRow[];
    return Object.freeze({
      arbitrageId: row.arbitrageId,
      userId: row.userId,
      strategyType: strategyType(row.strategyType),
      sourcePlanId: row.sourcePlanId,
      maxResidualBaseQuantity: normalizeUnsignedDecimal(row.maxResidualBaseQuantity, "maxResidualBaseQuantity"),
      status: instanceStatus(row.status),
      createdAt: row.createdAt,
      openedAt: row.openedAt,
      updatedAt: row.updatedAt,
      closedAt: row.closedAt,
      legs: Object.freeze(legs.map(legFromRow)) as unknown as readonly [ArbitrageInstanceLeg, ArbitrageInstanceLeg],
      executionReferences: Object.freeze(references.map(referenceFromRow)),
      managementReleases: Object.freeze(releases.map(managementReleaseFromRow)),
      legacyUnresolvedExecutionSeals: Object.freeze(legacySeals.map(legacyUnresolvedExecutionSealFromRow)),
      pnl: Object.freeze({
        asset: row.pnlAsset,
        cumulativeFundingPnl: row.cumulativeFundingPnl,
        realizedTradingPnl: row.realizedTradingPnl,
        feesCosts: row.feesCosts,
        cumulativeNetPnl: row.cumulativeNetPnl,
        updatedAt: row.pnlUpdatedAt,
      }),
    });
  }

  private applyQuantityDelta(arbitrageId: string, reference: ReferenceRow, delta: string) {
    const column = reference.quantityEffect === "INCREASE"
      ? "confirmedOpenedQuantity"
      : "confirmedClosedQuantity";
    const leg = this.db.prepare(`SELECT * FROM arbitrage_instance_legs
      WHERE arbitrageId = ? AND legId = ?`).get(arbitrageId, reference.legId) as unknown as LegRow | undefined;
    if (!leg) throw new Error("Execution reference leg was not found.");
    const current = column === "confirmedOpenedQuantity"
      ? leg.confirmedOpenedQuantity
      : leg.confirmedClosedQuantity;
    const next = addUnsignedDecimals(current, delta);
    if (column === "confirmedClosedQuantity"
      && compareUnsignedDecimals(next, leg.confirmedOpenedQuantity) > 0) {
      throw new Error("Confirmed closed quantity cannot exceed confirmed opened quantity.");
    }
    this.db.prepare(`UPDATE arbitrage_instance_legs SET ${column} = ?
      WHERE arbitrageId = ? AND legId = ?`).run(next, arbitrageId, reference.legId);
  }

  private assertOpeningClaimAllowed(
    instance: ArbitrageInstance,
    leg: ArbitrageInstanceLeg,
    claim: ExecutionReferenceClaim,
  ) {
    const unresolvedForMutationDomain = this.db.prepare(`SELECT 1
      FROM arbitrage_execution_references reference
      JOIN arbitrage_instance_legs candidate
        ON candidate.arbitrageId = reference.arbitrageId AND candidate.legId = reference.legId
      JOIN arbitrage_instances owner ON owner.arbitrageId = reference.arbitrageId
      WHERE owner.userId = ? AND candidate.venue = ? AND candidate.accountId = ?
        AND candidate.instrumentId = ? AND reference.phase = 'OPENING'
        AND reference.quantityEffect = 'INCREASE'
        AND reference.status IN ('CLAIMED', 'LINKED', 'PENDING_CONFIRMATION', 'UNKNOWN')
        AND NOT EXISTS (SELECT 1 FROM arbitrage_legacy_unresolved_execution_seals seal
          WHERE seal.arbitrageId = reference.arbitrageId
            AND seal.executionIntentId = reference.executionIntentId)
      LIMIT 1`).get(instance.userId, leg.venue, leg.accountId, leg.instrumentId);
    if (unresolvedForMutationDomain) {
      throw new Error("Provider mutation domain already has an unresolved risk-increasing opening execution.");
    }

    const openingReferences = instance.executionReferences.filter((reference) => reference.phase === "OPENING");
    if (openingReferences.some((reference) => reference.legId === leg.legId)) {
      throw new Error("Arbitrage leg already has an opening execution reference.");
    }
    if (openingReferences.length === 0) return;
    if (openingReferences.length !== 1) {
      throw new Error("Arbitrage instance does not have a unique first-leg opening execution.");
    }
    const first = openingReferences[0]!;
    const fullConfirmed = first.status === "CONFIRMED"
      && first.confirmedQuantity === first.requestedQuantity;
    const terminalPartial = first.status === "FAILED"
      && compareUnsignedDecimals(first.confirmedQuantity, "0") > 0
      && compareUnsignedDecimals(first.confirmedQuantity, first.requestedQuantity) < 0;
    if (!fullConfirmed && !terminalPartial) {
      throw new Error("Arbitrage first-leg opening is not authoritatively confirmed.");
    }
    if (preparedSecondLegHedge(instance, first, claim.legId) === null) {
      throw new Error("Arbitrage second-leg opening has no authoritative prepared exposure.");
    }
  }

  private deriveLifecycle(
    instance: ArbitrageInstance,
    updatedAt: number,
    mutationDisposition?: "NOT_DISPATCHED",
  ) {
    const quantities = instance.legs.map((leg) => activeManagedQuantity(instance, leg)) as [string, string];
    const hasExposure = quantities.some((quantity) => quantity !== "0");
    const bothExposed = quantities.every((quantity) => quantity !== "0");
    const residualWithinThreshold = compareUnsignedDecimals(
      absoluteDifference(quantities[0], quantities[1]),
      instance.maxResidualBaseQuantity,
    ) <= 0;
    const unresolved = instance.executionReferences.some((reference) =>
      UNRESOLVED_REFERENCE_STATUSES.includes(reference.status));
    const hasClosingExecution = instance.executionReferences.some((reference) =>
      reference.phase === "CLOSING" && reference.quantityEffect === "DECREASE");

    let status: ArbitrageInstanceStatus;
    if (!hasExposure && !unresolved
      && ((instance.managementReleases?.length ?? 0) > 0 || hasClosingExecution)) {
      status = "CLOSED";
    } else if (instance.status === "CLOSING") {
      status = !hasExposure && !unresolved
        ? "CLOSED"
        : unresolved
          ? "CLOSING"
          : "RESIDUAL";
    } else if (hasExposure) {
      status = bothExposed && residualWithinThreshold && !unresolved ? "HOLDING" : "RESIDUAL";
    } else {
      const openingReferences = instance.executionReferences.filter(({ phase }) => phase === "OPENING");
      const notDispatchedFirstLegFailure = mutationDisposition === "NOT_DISPATCHED"
        && instance.executionReferences.length === 1
        && openingReferences.length === 1
        && openingReferences[0]?.quantityEffect === "INCREASE"
        && openingReferences[0]?.status === "FAILED"
        && openingReferences[0]?.confirmedQuantity === "0";
      const attemptedLegIds = new Set(openingReferences.map(({ legId }) => legId));
      const openingTerminated = instance.legs.every(({ legId }) => attemptedLegIds.has(legId))
        && openingReferences.every(({ status: referenceStatus }) =>
          referenceStatus === "CONFIRMED" || referenceStatus === "FAILED");
      status = (notDispatchedFirstLegFailure || openingTerminated) && !unresolved ? "FAILED" : "OPENING";
    }
    return {
      status,
      openedAt: status === "HOLDING" && instance.openedAt === null ? updatedAt : instance.openedAt,
      closedAt: status === "CLOSED" ? updatedAt : null,
      updatedAt,
    };
  }

  private persistLifecycle(
    userId: string,
    arbitrageId: string,
    lifecycle: Readonly<{
      status: ArbitrageInstanceStatus;
      openedAt: number | null;
      closedAt: number | null;
      updatedAt: number;
    }>,
  ) {
    const result = this.db.prepare(`UPDATE arbitrage_instances
      SET status = ?, openedAt = ?, closedAt = ?, updatedAt = ?
      WHERE userId = ? AND arbitrageId = ?`).run(
      lifecycle.status,
      lifecycle.openedAt,
      lifecycle.closedAt,
      lifecycle.updatedAt,
      userId,
      arbitrageId,
    );
    if (result.changes !== 1) throw new Error("Arbitrage lifecycle update failed.");
  }

  private updateInstanceStatus(
    userId: string,
    arbitrageId: string,
    status: ArbitrageInstanceStatus,
    updatedAt: number,
  ) {
    const instance = this.requireForUser(userId, arbitrageId);
    if (updatedAt < instance.updatedAt) throw new Error("Arbitrage instance time cannot move backwards.");
    this.persistLifecycle(userId, arbitrageId, {
      status,
      openedAt: instance.openedAt,
      closedAt: null,
      updatedAt,
    });
  }

  private touchInstance(userId: string, arbitrageId: string, updatedAt: number) {
    const instance = this.requireForUser(userId, arbitrageId);
    if (updatedAt < instance.updatedAt) throw new Error("Arbitrage instance time cannot move backwards.");
    this.db.prepare(`UPDATE arbitrage_instances SET updatedAt = ?
      WHERE userId = ? AND arbitrageId = ?`).run(updatedAt, userId, arbitrageId);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private migrate() {
    this.db.exec(`${recoveryAuditSchema}

    CREATE TABLE IF NOT EXISTS arbitrage_instances (
      arbitrageId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      strategyType TEXT NOT NULL CHECK (strategyType IN ('PERPETUAL_PERPETUAL', 'SPOT_PERPETUAL')),
      sourcePlanId TEXT,
      maxResidualBaseQuantity TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('OPENING', 'HOLDING', 'RESIDUAL', 'CLOSING', 'CLOSED', 'FAILED')),
      createdAt INTEGER NOT NULL,
      openedAt INTEGER,
      updatedAt INTEGER NOT NULL,
      closedAt INTEGER,
      pnlAsset TEXT,
      cumulativeFundingPnl TEXT,
      realizedTradingPnl TEXT,
      feesCosts TEXT,
      cumulativeNetPnl TEXT,
      pnlUpdatedAt INTEGER
    ) STRICT;

    CREATE INDEX IF NOT EXISTS arbitrage_instances_user_status_created
      ON arbitrage_instances(userId, status, createdAt DESC);

    CREATE TABLE IF NOT EXISTS arbitrage_instance_legs (
      arbitrageId TEXT NOT NULL,
      legId TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('LONG', 'SHORT')),
      venue TEXT NOT NULL CHECK (venue IN ('binance', 'okx', 'bybit', 'bitget')),
      accountId TEXT NOT NULL,
      instrumentId TEXT NOT NULL,
      plannedQuantity TEXT NOT NULL,
      confirmedOpenedQuantity TEXT NOT NULL,
      confirmedClosedQuantity TEXT NOT NULL,
      PRIMARY KEY (arbitrageId, legId),
      UNIQUE (arbitrageId, role),
      FOREIGN KEY (arbitrageId) REFERENCES arbitrage_instances(arbitrageId)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS arbitrage_instance_opening_setups (
      arbitrageId TEXT PRIMARY KEY,
      sourcePlanId TEXT NOT NULL,
      opportunityId TEXT NOT NULL,
      horizonDays INTEGER NOT NULL CHECK (horizonDays IN (90, 365)),
      quantityInputJson TEXT NOT NULL,
      executionMode TEXT NOT NULL CHECK (executionMode IN ('PRICE_PRIORITY', 'EXECUTION_PRIORITY')),
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (arbitrageId) REFERENCES arbitrage_instances(arbitrageId)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS arbitrage_execution_references (
      arbitrageId TEXT NOT NULL,
      legId TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('OPENING', 'ADJUSTMENT', 'CLOSING')),
      quantityEffect TEXT NOT NULL CHECK (quantityEffect IN ('INCREASE', 'DECREASE')),
      executionIntentId TEXT NOT NULL UNIQUE,
      executionRecordId TEXT UNIQUE,
      requestedQuantity TEXT NOT NULL,
      confirmedQuantity TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'CLAIMED', 'LINKED', 'PENDING_CONFIRMATION', 'CONFIRMED', 'FAILED', 'UNKNOWN'
      )),
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (arbitrageId, executionIntentId),
      FOREIGN KEY (arbitrageId, legId) REFERENCES arbitrage_instance_legs(arbitrageId, legId)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS arbitrage_leg_management_releases (
      releaseId TEXT PRIMARY KEY,
      arbitrageId TEXT NOT NULL,
      legId TEXT NOT NULL,
      releasedQuantity TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('USER_CONFIRMED_STOP_MANAGEMENT')),
      source TEXT NOT NULL CHECK (source IN ('AUTHENTICATED_API')),
      requestedByUserId TEXT NOT NULL,
      requestedAt INTEGER NOT NULL,
      confirmedAt INTEGER NOT NULL,
      venue TEXT NOT NULL CHECK (venue IN ('binance', 'okx', 'bybit', 'bitget')),
      accountId TEXT NOT NULL,
      instrumentId TEXT NOT NULL,
      positionMode TEXT NOT NULL CHECK (positionMode IN ('ONE_WAY', 'HEDGE')),
      actualQuantity TEXT NOT NULL,
      actualSignedNetQuantity TEXT,
      actualLongQuantity TEXT NOT NULL,
      actualShortQuantity TEXT NOT NULL,
      availableQuantity TEXT,
      realityCheckedAt INTEGER NOT NULL,
      UNIQUE (arbitrageId, legId),
      FOREIGN KEY (arbitrageId, legId) REFERENCES arbitrage_instance_legs(arbitrageId, legId)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS arbitrage_command_idempotency (
      commandId TEXT PRIMARY KEY,
      operationType TEXT NOT NULL CHECK (operationType IN (
        'EXECUTION_OPEN', 'EXECUTION_CLOSE', 'MANAGEMENT_RELEASE'
      )),
      requestedByUserId TEXT NOT NULL,
      arbitrageId TEXT NOT NULL,
      legId TEXT NOT NULL,
      referenceId TEXT NOT NULL UNIQUE,
      businessPayloadFingerprint TEXT,
      createdAt INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS arbitrage_command_outcome_audits (
      commandId TEXT PRIMARY KEY,
      requestedByUserId TEXT NOT NULL,
      arbitrageId TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('START', 'EXIT')),
      terminalStatus TEXT NOT NULL,
      stopPhase TEXT,
      stopReason TEXT,
      failedLegId TEXT,
      completedLegIdsJson TEXT NOT NULL,
      currentManagedExposureJson TEXT NOT NULL,
      mutationDisposition TEXT CHECK (mutationDisposition IN (
        'NOT_DISPATCHED', 'DISPATCHED_OR_POSSIBLE', 'UNKNOWN'
      )),
      diagnosticCategory TEXT,
      failureStage TEXT,
      providerCode TEXT,
      dustReadAttemptsJson TEXT NOT NULL DEFAULT '[]',
      reconcileAttemptsJson TEXT NOT NULL DEFAULT '[]',
      terminalAt INTEGER NOT NULL,
      businessPayloadFingerprint TEXT NOT NULL UNIQUE,
      FOREIGN KEY (arbitrageId) REFERENCES arbitrage_instances(arbitrageId)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS arbitrage_command_outcomes_user_time
      ON arbitrage_command_outcome_audits(requestedByUserId, terminalAt DESC);

    CREATE TABLE IF NOT EXISTS arbitrage_spot_opening_attribution_evidence (
      arbitrageId TEXT NOT NULL,
      legId TEXT NOT NULL,
      executionIntentId TEXT NOT NULL,
      executionRecordId TEXT NOT NULL UNIQUE,
      attributableBaseQuantity TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('PROVIDER_ORDER_FILLS')),
      confirmedAt INTEGER NOT NULL,
      venue TEXT NOT NULL CHECK (venue IN ('binance', 'okx', 'bybit', 'bitget')),
      accountId TEXT NOT NULL,
      instrumentId TEXT NOT NULL,
      PRIMARY KEY (arbitrageId, executionIntentId),
      FOREIGN KEY (arbitrageId, legId) REFERENCES arbitrage_instance_legs(arbitrageId, legId),
      FOREIGN KEY (arbitrageId, executionIntentId)
        REFERENCES arbitrage_execution_references(arbitrageId, executionIntentId)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS execution_accounting_facts (
      executionRecordId TEXT PRIMARY KEY,
      arbitrageId TEXT NOT NULL,
      legId TEXT NOT NULL,
      executionIntentId TEXT NOT NULL UNIQUE,
      providerOrderId TEXT NOT NULL,
      executionPhase TEXT NOT NULL CHECK (executionPhase IN ('OPENING', 'CLOSING')),
      quantityEffect TEXT NOT NULL CHECK (quantityEffect IN ('INCREASE', 'DECREASE')),
      terminalExecutionStatus TEXT NOT NULL CHECK (terminalExecutionStatus IN ('CONFIRMED', 'FAILED')),
      filledQuantity TEXT NOT NULL,
      averageFillPrice TEXT,
      feeAmountProvider TEXT,
      feeAsset TEXT,
      tradingFeeNetCostUsdt TEXT,
      confirmedAt INTEGER NOT NULL,
      priceCompleteness TEXT NOT NULL CHECK (priceCompleteness IN ('COMPLETE', 'INCOMPLETE')),
      feeCompleteness TEXT NOT NULL CHECK (feeCompleteness IN ('COMPLETE', 'INCOMPLETE')),
      integrityStatus TEXT NOT NULL CHECK (integrityStatus IN ('VERIFIED', 'NEEDS_CHECK')),
      completeness TEXT NOT NULL CHECK (completeness IN ('COMPLETE', 'INCOMPLETE')),
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (arbitrageId, legId) REFERENCES arbitrage_instance_legs(arbitrageId, legId),
      FOREIGN KEY (arbitrageId, executionIntentId)
        REFERENCES arbitrage_execution_references(arbitrageId, executionIntentId),
      FOREIGN KEY (executionRecordId) REFERENCES execution_records(executionId)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS execution_accounting_facts_instance_time
      ON execution_accounting_facts(arbitrageId, confirmedAt, executionRecordId);

    CREATE TABLE IF NOT EXISTS arbitrage_unstarted_abandonments (
      commandId TEXT PRIMARY KEY,
      operationType TEXT NOT NULL CHECK (operationType = 'ABANDON_UNSTARTED_ARBITRAGE'),
      requestedByUserId TEXT NOT NULL,
      arbitrageId TEXT NOT NULL UNIQUE,
      previousStatus TEXT NOT NULL CHECK (previousStatus = 'OPENING'),
      newStatus TEXT NOT NULL CHECK (newStatus = 'FAILED'),
      reason TEXT NOT NULL CHECK (reason = 'USER_ABANDONED_BEFORE_EXECUTION'),
      businessPayloadFingerprint TEXT NOT NULL UNIQUE,
      requestedAt INTEGER NOT NULL,
      confirmedAt INTEGER NOT NULL,
      FOREIGN KEY (arbitrageId) REFERENCES arbitrage_instances(arbitrageId)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS arbitrage_legacy_unresolved_execution_seals (
      commandId TEXT PRIMARY KEY,
      operationType TEXT NOT NULL CHECK (operationType = 'SEAL_LEGACY_UNRESOLVED_EXECUTION'),
      requestedByUserId TEXT NOT NULL,
      arbitrageId TEXT NOT NULL UNIQUE,
      legId TEXT NOT NULL,
      executionIntentId TEXT NOT NULL UNIQUE,
      executionRecordId TEXT NOT NULL UNIQUE,
      venue TEXT NOT NULL CHECK (venue IN ('binance', 'okx', 'bybit', 'bitget')),
      accountId TEXT NOT NULL,
      instrumentId TEXT NOT NULL,
      originalStatus TEXT NOT NULL CHECK (originalStatus = 'UNKNOWN'),
      sealStatus TEXT NOT NULL CHECK (sealStatus = 'LEGACY_UNRESOLVED_MANUALLY_SEALED'),
      reason TEXT NOT NULL CHECK (reason = 'LEGACY_RECOVERY_IDENTITY_GAP'),
      businessPayloadFingerprint TEXT NOT NULL UNIQUE,
      sealedAt INTEGER NOT NULL,
      FOREIGN KEY (arbitrageId, legId) REFERENCES arbitrage_instance_legs(arbitrageId, legId),
      FOREIGN KEY (arbitrageId, executionIntentId)
        REFERENCES arbitrage_execution_references(arbitrageId, executionIntentId)
    ) STRICT;`);
    const commandColumns = new Set((this.db.prepare(
      "PRAGMA table_info(arbitrage_command_idempotency)",
    ).all() as Array<{ name: string }>).map(({ name }) => name));
    if (!commandColumns.has("businessPayloadFingerprint")) {
      // Existing rows cannot be truthfully backfilled from the former partial
      // fingerprint. NULL therefore means legacy/unverifiable and fails closed.
      this.db.exec("ALTER TABLE arbitrage_command_idempotency ADD COLUMN businessPayloadFingerprint TEXT");
    }
    const outcomeColumns = new Set((this.db.prepare(
      "PRAGMA table_info(arbitrage_command_outcome_audits)",
    ).all() as Array<{ name: string }>).map(({ name }) => name));
    if (!outcomeColumns.has("mutationDisposition")) {
      this.db.exec(`ALTER TABLE arbitrage_command_outcome_audits ADD COLUMN mutationDisposition TEXT
        CHECK (mutationDisposition IN ('NOT_DISPATCHED', 'DISPATCHED_OR_POSSIBLE', 'UNKNOWN'))`);
    }
    if (!outcomeColumns.has("diagnosticCategory")) {
      this.db.exec("ALTER TABLE arbitrage_command_outcome_audits ADD COLUMN diagnosticCategory TEXT");
    }
    if (!outcomeColumns.has("failureStage")) {
      this.db.exec("ALTER TABLE arbitrage_command_outcome_audits ADD COLUMN failureStage TEXT");
    }
    if (!outcomeColumns.has("providerCode")) {
      this.db.exec("ALTER TABLE arbitrage_command_outcome_audits ADD COLUMN providerCode TEXT");
    }
    if (!outcomeColumns.has("dustReadAttemptsJson")) {
      this.db.exec("ALTER TABLE arbitrage_command_outcome_audits ADD COLUMN dustReadAttemptsJson TEXT NOT NULL DEFAULT '[]'");
    }
    if (!outcomeColumns.has("reconcileAttemptsJson")) {
      this.db.exec("ALTER TABLE arbitrage_command_outcome_audits ADD COLUMN reconcileAttemptsJson TEXT NOT NULL DEFAULT '[]'");
    }
  }
}

function recoveryAuditId(action: string, arbitrageId: string, executionIntentId: string) {
  return `recovery:${createHash("sha256").update(`${action}\u0000${arbitrageId}\u0000${executionIntentId}`).digest("hex")}`;
}

function normalizeOpeningSetup(setup: ArbitrageOpeningSetup): ArbitrageOpeningSetup {
  const quantityInput = setup.quantityInput.mode === "NOTIONAL_USDT"
    ? (() => {
        normalizePositiveDecimal(setup.quantityInput.amountUsdt, "opening amountUsdt");
        return Object.freeze({ mode: "NOTIONAL_USDT" as const, amountUsdt: setup.quantityInput.amountUsdt });
      })()
    : (() => {
        normalizePositiveDecimal(setup.quantityInput.quantity, "opening quantity");
        return Object.freeze({ mode: "ASSET_QUANTITY" as const, quantity: setup.quantityInput.quantity });
      })();
  if (setup.horizonDays !== 90 && setup.horizonDays !== 365) {
    throw new Error("Arbitrage opening setup horizon is invalid.");
  }
  if (setup.executionMode !== "PRICE_PRIORITY" && setup.executionMode !== "EXECUTION_PRIORITY") {
    throw new Error("Arbitrage opening setup execution mode is invalid.");
  }
  return Object.freeze({
    opportunityId: identifier(setup.opportunityId, "opening opportunityId"),
    horizonDays: setup.horizonDays,
    quantityInput,
    executionMode: setup.executionMode,
  });
}

function openingSetupFromRow(row: OpeningSetupRow): ArbitrageOpeningSetup {
  let quantityInput: unknown;
  try {
    quantityInput = JSON.parse(row.quantityInputJson);
  } catch {
    throw new Error("Persisted arbitrage opening quantity input is invalid.");
  }
  if (!quantityInput || typeof quantityInput !== "object" || Array.isArray(quantityInput)) {
    throw new Error("Persisted arbitrage opening quantity input is invalid.");
  }
  const value = quantityInput as Record<string, unknown>;
  const parsed = value.mode === "NOTIONAL_USDT"
    ? { mode: "NOTIONAL_USDT" as const, amountUsdt: value.amountUsdt }
    : value.mode === "ASSET_QUANTITY"
      ? { mode: "ASSET_QUANTITY" as const, quantity: value.quantity }
      : null;
  if (!parsed || ("amountUsdt" in parsed && typeof parsed.amountUsdt !== "string")
    || ("quantity" in parsed && typeof parsed.quantity !== "string")) {
    throw new Error("Persisted arbitrage opening quantity input is invalid.");
  }
  return normalizeOpeningSetup({
    opportunityId: row.opportunityId,
    horizonDays: row.horizonDays as 90 | 365,
    quantityInput: parsed as ArbitrageOpeningSetup["quantityInput"],
    executionMode: row.executionMode as ArbitrageOpeningSetup["executionMode"],
  });
}

function isUnstartedEmptyOpening(instance: ArbitrageInstance) {
  return instance.status === "OPENING"
    && instance.executionReferences.length === 0
    && (instance.managementReleases?.length ?? 0) === 0
    && instance.legs.every((leg) => leg.confirmedOpenedQuantity === "0"
      && leg.confirmedClosedQuantity === "0"
      && managedCurrentQuantity(leg) === "0"
      && activeManagedQuantity(instance, leg) === "0");
}

function normalizeCommandOutcomeAudit(
  authenticatedUserId: string,
  outcome: Omit<ArbitrageCommandOutcomeAudit, "businessPayloadFingerprint">,
): ArbitrageCommandOutcomeAudit {
  const requestedByUserId = identifier(outcome.requestedByUserId, "requestedByUserId");
  if (requestedByUserId !== identifier(authenticatedUserId, "userId")) {
    throw new Error("Arbitrage command outcome user scope is invalid.");
  }
  if (outcome.operation !== "START" && outcome.operation !== "EXIT") {
    throw new Error("Arbitrage command outcome operation is invalid.");
  }
  const commandId = identifier(outcome.commandId, "commandId");
  const arbitrageId = identifier(outcome.arbitrageId, "arbitrageId");
  const terminalStatus = controlledOutcomeCode(outcome.terminalStatus, "terminalStatus");
  const stopPhase = outcome.stopPhase === null ? null : controlledOutcomeCode(outcome.stopPhase, "stopPhase");
  const stopReason = outcome.stopReason === null ? null : controlledOutcomeCode(outcome.stopReason, "stopReason");
  const failedLegId = outcome.failedLegId === null ? null : identifier(outcome.failedLegId, "failedLegId");
  const completedLegIds = Object.freeze(outcome.completedLegIds.map((legId) => identifier(legId, "completedLegId")));
  if (new Set(completedLegIds).size !== completedLegIds.length) {
    throw new Error("Arbitrage command outcome completed leg identities are duplicated.");
  }
  const currentManagedExposure = Object.freeze(outcome.currentManagedExposure.map((entry) => Object.freeze({
    legId: identifier(entry.legId, "managed exposure legId"),
    quantity: normalizeUnsignedDecimal(entry.quantity, "managed exposure quantity"),
  })));
  if (new Set(currentManagedExposure.map(({ legId }) => legId)).size !== currentManagedExposure.length) {
    throw new Error("Arbitrage command outcome managed exposure leg identities are duplicated.");
  }
  const mutationDisposition = outcome.mutationDisposition ?? null;
  if (mutationDisposition !== null && mutationDisposition !== "NOT_DISPATCHED"
    && mutationDisposition !== "DISPATCHED_OR_POSSIBLE" && mutationDisposition !== "UNKNOWN") {
    throw new Error("Arbitrage command outcome mutation disposition is invalid.");
  }
  const diagnosticCategory = outcome.diagnosticCategory == null
    ? null
    : controlledOutcomeCode(outcome.diagnosticCategory, "diagnosticCategory");
  const failureStage = outcome.failureStage == null
    ? null
    : controlledOutcomeCode(outcome.failureStage, "failureStage");
  const providerCode = outcome.providerCode == null
    ? null
    : controlledProviderCode(outcome.providerCode);
  const dustReadAttempts = Object.freeze((outcome.dustReadAttempts ?? []).map((entry) => {
    if (!Number.isSafeInteger(entry.attempt) || entry.attempt <= 0
      || (entry.substage !== "LOCAL_STATE" && entry.substage !== "SPOT_BALANCE")
      || (entry.result !== "SUCCESS" && entry.result !== "FAILED")
      || (entry.retryDecision !== "COMPLETE" && entry.retryDecision !== "RETRY" && entry.retryDecision !== "STOP")
      || !Number.isSafeInteger(entry.delayMs) || entry.delayMs < 0) {
      throw new Error("Arbitrage command outcome dust read attempt is invalid.");
    }
    return Object.freeze({
      attempt: entry.attempt,
      substage: entry.substage,
      result: entry.result,
      retryDecision: entry.retryDecision,
      delayMs: entry.delayMs,
      category: entry.category === null ? null : controlledOutcomeCode(entry.category, "dustReadCategory"),
      providerCode: entry.providerCode === null ? null : controlledProviderCode(entry.providerCode),
    });
  }));
  const reconcileAttempts = Object.freeze((outcome.reconcileAttempts ?? []).map((entry) => {
    if (!Number.isSafeInteger(entry.attempt) || entry.attempt <= 0
      || (entry.result !== "SUCCESS" && entry.result !== "FAILED")
      || (entry.retryDecision !== "COMPLETE" && entry.retryDecision !== "RETRY" && entry.retryDecision !== "STOP")
      || !Number.isSafeInteger(entry.delayMs) || entry.delayMs < 0) {
      throw new Error("Arbitrage command outcome reconcile attempt is invalid.");
    }
    return Object.freeze({
      attempt: entry.attempt,
      venue: controlledOutcomeCode(entry.venue.toUpperCase(), "reconcileVenue"),
      substage: entry.substage === null ? null : controlledOutcomeCode(entry.substage, "reconcileSubstage"),
      result: entry.result,
      retryDecision: entry.retryDecision,
      delayMs: entry.delayMs,
      category: entry.category === null ? null : controlledOutcomeCode(entry.category, "reconcileCategory"),
      providerCode: entry.providerCode === null ? null : controlledProviderCode(entry.providerCode),
    });
  }));
  const businessPayloadFingerprint = createHash("sha256").update(JSON.stringify([
    "ARBITRAGE_COMMAND_OUTCOME", requestedByUserId, outcome.operation, arbitrageId, commandId,
  ])).digest("hex");
  return Object.freeze({
    commandId,
    requestedByUserId,
    arbitrageId,
    operation: outcome.operation,
    terminalStatus,
    stopPhase,
    stopReason,
    failedLegId,
    completedLegIds,
    currentManagedExposure,
    mutationDisposition,
    diagnosticCategory,
    failureStage,
    providerCode,
    dustReadAttempts,
    reconcileAttempts,
    terminalAt: timestamp(outcome.terminalAt, "terminalAt"),
    businessPayloadFingerprint,
  });
}

function commandOutcomeAuditFromRow(row: CommandOutcomeAuditRow): ArbitrageCommandOutcomeAudit {
  let completedLegIds: unknown;
  let currentManagedExposure: unknown;
  let dustReadAttempts: unknown;
  let reconcileAttempts: unknown;
  try {
    completedLegIds = JSON.parse(row.completedLegIdsJson);
    currentManagedExposure = JSON.parse(row.currentManagedExposureJson);
    dustReadAttempts = JSON.parse(row.dustReadAttemptsJson ?? "[]");
    reconcileAttempts = JSON.parse(row.reconcileAttemptsJson ?? "[]");
  } catch {
    throw new Error("Persisted arbitrage command outcome audit is invalid.");
  }
  if (!Array.isArray(completedLegIds) || !Array.isArray(currentManagedExposure)
    || !Array.isArray(dustReadAttempts) || !Array.isArray(reconcileAttempts)) {
    throw new Error("Persisted arbitrage command outcome audit is invalid.");
  }
  const normalized = normalizeCommandOutcomeAudit(row.requestedByUserId, {
    commandId: row.commandId,
    requestedByUserId: row.requestedByUserId,
    arbitrageId: row.arbitrageId,
    operation: row.operation,
    terminalStatus: row.terminalStatus,
    stopPhase: row.stopPhase,
    stopReason: row.stopReason,
    failedLegId: row.failedLegId,
    completedLegIds: completedLegIds as string[],
    currentManagedExposure: currentManagedExposure as Array<{ legId: string; quantity: string }>,
    mutationDisposition: row.mutationDisposition,
    diagnosticCategory: row.diagnosticCategory,
    failureStage: row.failureStage,
    providerCode: row.providerCode,
    dustReadAttempts: dustReadAttempts as NonNullable<ArbitrageCommandOutcomeAudit["dustReadAttempts"]>,
    reconcileAttempts: reconcileAttempts as NonNullable<ArbitrageCommandOutcomeAudit["reconcileAttempts"]>,
    terminalAt: row.terminalAt,
  });
  if (normalized.businessPayloadFingerprint !== row.businessPayloadFingerprint) {
    throw new Error("Persisted arbitrage command outcome fingerprint is invalid.");
  }
  return normalized;
}

function controlledOutcomeCode(value: string, label: string) {
  if (!/^[A-Z][A-Z0-9_]{0,95}$/u.test(value)) {
    throw new Error(`Arbitrage command outcome ${label} is not a controlled code.`);
  }
  return value;
}

function controlledProviderCode(value: string) {
  const code = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/u.test(code)) {
    throw new Error("Arbitrage command outcome providerCode is not a controlled code.");
  }
  return code;
}

function normalizeUnstartedArbitrageAbandonmentClaim(
  claim: UnstartedArbitrageAbandonmentClaim,
): UnstartedArbitrageAbandonmentClaim {
  if (claim.operationType !== "ABANDON_UNSTARTED_ARBITRAGE"
    || claim.reason !== "USER_ABANDONED_BEFORE_EXECUTION") {
    throw new Error("Unstarted arbitrage abandonment semantics are invalid.");
  }
  const requestedAt = timestamp(claim.requestedAt, "requestedAt");
  const confirmedAt = timestamp(claim.confirmedAt, "confirmedAt");
  if (confirmedAt < requestedAt) {
    throw new Error("Unstarted arbitrage abandonment confirmation cannot predate its request.");
  }
  return Object.freeze({
    commandId: identifier(claim.commandId, "commandId"),
    operationType: claim.operationType,
    requestedByUserId: identifier(claim.requestedByUserId, "requestedByUserId"),
    arbitrageId: identifier(claim.arbitrageId, "arbitrageId"),
    reason: claim.reason,
    businessPayloadFingerprint: identifier(
      claim.businessPayloadFingerprint,
      "businessPayloadFingerprint",
    ),
    requestedAt,
    confirmedAt,
  });
}

function normalizeLegacyUnresolvedExecutionSealClaim(
  claim: LegacyUnresolvedExecutionSealClaim,
): LegacyUnresolvedExecutionSealClaim {
  if (claim.operationType !== "SEAL_LEGACY_UNRESOLVED_EXECUTION"
    || claim.originalStatus !== "UNKNOWN"
    || claim.sealStatus !== "LEGACY_UNRESOLVED_MANUALLY_SEALED"
    || claim.reason !== "LEGACY_RECOVERY_IDENTITY_GAP") {
    throw new Error("Legacy unresolved execution seal semantics are invalid.");
  }
  return Object.freeze({
    commandId: identifier(claim.commandId, "commandId"),
    operationType: claim.operationType,
    requestedByUserId: identifier(claim.requestedByUserId, "requestedByUserId"),
    arbitrageId: identifier(claim.arbitrageId, "arbitrageId"),
    legId: identifier(claim.legId, "legId"),
    executionIntentId: identifier(claim.executionIntentId, "executionIntentId"),
    executionRecordId: identifier(claim.executionRecordId, "executionRecordId"),
    venue: venue(claim.venue),
    accountId: identifier(claim.accountId, "accountId"),
    instrumentId: identifier(claim.instrumentId, "instrumentId"),
    originalStatus: claim.originalStatus,
    sealStatus: claim.sealStatus,
    reason: claim.reason,
    businessPayloadFingerprint: identifier(claim.businessPayloadFingerprint, "businessPayloadFingerprint"),
    sealedAt: timestamp(claim.sealedAt, "sealedAt"),
  });
}

function legacyUnresolvedExecutionSealFromRow(
  row: LegacyUnresolvedExecutionSealRow,
): ArbitrageLegacyUnresolvedExecutionSeal {
  return normalizeLegacyUnresolvedExecutionSealClaim(row);
}

function sameLegacyUnresolvedExecutionSeal(
  row: LegacyUnresolvedExecutionSealRow,
  claim: LegacyUnresolvedExecutionSealClaim,
) {
  return row.commandId === claim.commandId
    && row.operationType === claim.operationType
    && row.requestedByUserId === claim.requestedByUserId
    && row.arbitrageId === claim.arbitrageId
    && row.legId === claim.legId
    && row.executionIntentId === claim.executionIntentId
    && row.executionRecordId === claim.executionRecordId
    && row.venue === claim.venue
    && row.accountId === claim.accountId
    && row.instrumentId === claim.instrumentId
    && row.originalStatus === claim.originalStatus
    && row.sealStatus === claim.sealStatus
    && row.reason === claim.reason
    && row.businessPayloadFingerprint === claim.businessPayloadFingerprint;
}

function unstartedArbitrageAbandonmentFromRow(
  row: UnstartedArbitrageAbandonmentRow,
): UnstartedArbitrageAbandonmentAudit {
  if (row.operationType !== "ABANDON_UNSTARTED_ARBITRAGE"
    || row.previousStatus !== "OPENING" || row.newStatus !== "FAILED"
    || row.reason !== "USER_ABANDONED_BEFORE_EXECUTION") {
    throw new Error("Unstarted arbitrage abandonment audit is invalid.");
  }
  return Object.freeze({
    commandId: identifier(row.commandId, "commandId"),
    operationType: row.operationType,
    requestedByUserId: identifier(row.requestedByUserId, "requestedByUserId"),
    arbitrageId: identifier(row.arbitrageId, "arbitrageId"),
    previousStatus: row.previousStatus,
    newStatus: row.newStatus,
    reason: row.reason,
    businessPayloadFingerprint: identifier(
      row.businessPayloadFingerprint,
      "businessPayloadFingerprint",
    ),
    requestedAt: timestamp(row.requestedAt, "requestedAt"),
    confirmedAt: timestamp(row.confirmedAt, "confirmedAt"),
  });
}

function sameUnstartedArbitrageAbandonment(
  row: UnstartedArbitrageAbandonmentRow,
  claim: UnstartedArbitrageAbandonmentClaim,
  includeCommandId = true,
) {
  return (!includeCommandId || row.commandId === claim.commandId)
    && row.operationType === claim.operationType
    && row.requestedByUserId === claim.requestedByUserId
    && row.arbitrageId === claim.arbitrageId
    && row.reason === claim.reason
    && row.businessPayloadFingerprint === claim.businessPayloadFingerprint;
}

function normalizeCommandFingerprint(fingerprint: ArbitrageCommandFingerprint): ArbitrageCommandFingerprint {
  if (fingerprint.operationType !== "EXECUTION_OPEN"
    && fingerprint.operationType !== "EXECUTION_CLOSE"
    && fingerprint.operationType !== "MANAGEMENT_RELEASE") {
    throw new Error("Arbitrage command operation type is invalid.");
  }
  return Object.freeze({
    commandId: identifier(fingerprint.commandId, "commandId"),
    operationType: fingerprint.operationType,
    requestedByUserId: identifier(fingerprint.requestedByUserId, "requestedByUserId"),
    arbitrageId: identifier(fingerprint.arbitrageId, "arbitrageId"),
    legId: identifier(fingerprint.legId, "legId"),
    referenceId: identifier(fingerprint.referenceId, "referenceId"),
    businessPayloadFingerprint: identifier(
      fingerprint.businessPayloadFingerprint,
      "businessPayloadFingerprint",
    ),
  });
}

function sameCommandFingerprint(
  existing: CommandIdempotencyRow,
  expected: Omit<ArbitrageCommandFingerprint, "commandId"> & Readonly<{ commandId: string }>,
) {
  return existing.commandId === expected.commandId
    && existing.operationType === expected.operationType
    && existing.requestedByUserId === expected.requestedByUserId
    && existing.arbitrageId === expected.arbitrageId
    && existing.legId === expected.legId
    && existing.referenceId === expected.referenceId
    && existing.businessPayloadFingerprint !== null
    && existing.businessPayloadFingerprint === expected.businessPayloadFingerprint;
}

function normalizeSpotOpeningAttributionEvidence(
  evidence: SpotOpeningAttributionEvidence,
): SpotOpeningAttributionEvidence {
  if (evidence.source !== "PROVIDER_ORDER_FILLS") {
    throw new Error("Spot opening attribution evidence source is invalid.");
  }
  return Object.freeze({
    arbitrageId: identifier(evidence.arbitrageId, "arbitrageId"),
    legId: identifier(evidence.legId, "legId"),
    executionIntentId: identifier(evidence.executionIntentId, "executionIntentId"),
    executionRecordId: identifier(evidence.executionRecordId, "executionRecordId"),
    attributableBaseQuantity: normalizeUnsignedDecimal(
      evidence.attributableBaseQuantity,
      "attributableBaseQuantity",
    ),
    source: evidence.source,
    confirmedAt: timestamp(evidence.confirmedAt, "confirmedAt"),
    venue: venue(evidence.venue),
    accountId: identifier(evidence.accountId, "accountId"),
    instrumentId: identifier(evidence.instrumentId, "instrumentId"),
  });
}

function spotOpeningAttributionEvidenceFromRow(
  row: SpotOpeningAttributionEvidenceRow,
): SpotOpeningAttributionEvidence {
  return normalizeSpotOpeningAttributionEvidence({
    arbitrageId: row.arbitrageId,
    legId: row.legId,
    executionIntentId: row.executionIntentId,
    executionRecordId: row.executionRecordId,
    attributableBaseQuantity: row.attributableBaseQuantity,
    source: row.source as "PROVIDER_ORDER_FILLS",
    confirmedAt: row.confirmedAt,
    venue: row.venue as ArbitrageInstanceLeg["venue"],
    accountId: row.accountId,
    instrumentId: row.instrumentId,
  });
}

function sameSpotOpeningAttributionEvidence(
  left: SpotOpeningAttributionEvidence,
  right: SpotOpeningAttributionEvidence,
) {
  return left.arbitrageId === right.arbitrageId
    && left.legId === right.legId
    && left.executionIntentId === right.executionIntentId
    && left.executionRecordId === right.executionRecordId
    && left.attributableBaseQuantity === right.attributableBaseQuantity
    && left.source === right.source
    && left.venue === right.venue
    && left.accountId === right.accountId
    && left.instrumentId === right.instrumentId;
}

function preparedSecondLegHedge(
  instance: ArbitrageInstance,
  firstReference: Readonly<{
    legId: string;
    phase: string;
    quantityEffect: string;
    status: string;
    requestedQuantity: string;
    confirmedQuantity: string;
    updatedAt: number;
  }>,
  secondLegId: string,
): PreparedSecondLegHedge | null {
  const terminalPartial = firstReference.status === "FAILED"
    && compareUnsignedDecimals(firstReference.confirmedQuantity, "0") > 0
    && compareUnsignedDecimals(firstReference.confirmedQuantity, firstReference.requestedQuantity) < 0;
  if (firstReference.phase !== "OPENING"
    || firstReference.quantityEffect !== "INCREASE"
    || (firstReference.status !== "CONFIRMED" && !terminalPartial)
    || instance.updatedAt <= firstReference.updatedAt) {
    return null;
  }
  const firstLeg = instance.legs.find((leg) => leg.legId === firstReference.legId);
  const secondLeg = instance.legs.find((leg) => leg.legId === secondLegId);
  if (!firstLeg || !secondLeg || firstLeg.legId === secondLeg.legId
    || firstLeg.confirmedClosedQuantity !== "0"
    || firstLeg.confirmedOpenedQuantity !== firstLeg.plannedQuantity
    || secondLeg.confirmedOpenedQuantity !== "0"
    || secondLeg.confirmedClosedQuantity !== "0"
    || instance.executionReferences.some((reference) => reference.legId === secondLegId)
    || compareUnsignedDecimals(secondLeg.plannedQuantity, firstLeg.plannedQuantity) > 0) {
    return null;
  }
  const residualBaseQuantity = absoluteDifference(firstLeg.plannedQuantity, secondLeg.plannedQuantity);
  if (instance.maxResidualBaseQuantity !== residualBaseQuantity) return null;
  return Object.freeze({
    targetBaseQuantity: firstLeg.plannedQuantity,
    executableBaseQuantity: secondLeg.plannedQuantity,
    residualBaseQuantity,
  });
}

function normalizeHistoryPageQuery(input: ArbitrageHistoryPageQuery): ArbitrageHistoryPageQuery {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new Error("history limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new Error("history offset must be a non-negative integer.");
  }
  return Object.freeze({ limit: input.limit, offset: input.offset });
}

function normalizeNewInstance(input: NewArbitrageInstance) {
  if (!input || typeof input !== "object") throw new Error("New arbitrage instance is invalid.");
  if (!Array.isArray(input.legs) || input.legs.length !== 2) {
    throw new Error("Arbitrage instance must contain exactly two legs.");
  }
  const legs = input.legs.map((leg) => ({
    legId: identifier(leg.legId, "legId"),
    role: legRole(leg.role),
    venue: venue(leg.venue),
    accountId: identifier(leg.accountId, "accountId"),
    instrumentId: instrumentId(leg.instrumentId),
    plannedQuantity: normalizePositiveDecimal(leg.plannedQuantity, "plannedQuantity"),
  }));
  if (new Set(legs.map(({ legId }) => legId)).size !== 2) {
    throw new Error("Arbitrage instance legId values must be unique.");
  }
  if (new Set(legs.map(({ role }) => role)).size !== 2
    || !legs.some(({ role }) => role === "LONG")
    || !legs.some(({ role }) => role === "SHORT")) {
    throw new Error("Arbitrage instance requires exactly one LONG leg and one SHORT leg.");
  }
  return {
    arbitrageId: identifier(input.arbitrageId, "arbitrageId"),
    userId: identifier(input.userId, "userId"),
    strategyType: strategyType(input.strategyType),
    sourcePlanId: input.sourcePlanId == null ? null : identifier(input.sourcePlanId, "sourcePlanId"),
    maxResidualBaseQuantity: normalizeUnsignedDecimal(
      input.maxResidualBaseQuantity,
      "maxResidualBaseQuantity",
    ),
    createdAt: timestamp(input.createdAt, "createdAt"),
    legs: legs as unknown as NewArbitrageInstance["legs"],
  };
}

function normalizeClaim(claim: ExecutionReferenceClaim): ExecutionReferenceClaim {
  if ((claim.commandId === undefined) !== (claim.operationType === undefined)
    || (claim.commandId === undefined) !== (claim.businessPayloadFingerprint === undefined)) {
    throw new Error("Execution command idempotency fields must be provided together.");
  }
  if (claim.operationType !== undefined
    && claim.operationType !== "EXECUTION_OPEN"
    && claim.operationType !== "EXECUTION_CLOSE") {
    throw new Error("Execution command operation type is invalid.");
  }
  return Object.freeze({
    legId: identifier(claim.legId, "legId"),
    phase: executionPhase(claim.phase),
    quantityEffect: quantityEffect(claim.quantityEffect),
    executionIntentId: identifier(claim.executionIntentId, "executionIntentId"),
    requestedQuantity: normalizePositiveDecimal(claim.requestedQuantity, "requestedQuantity"),
    ...(claim.acceptedResidualQuantity === undefined ? {} : {
      acceptedResidualQuantity: normalizePositiveDecimal(
        claim.acceptedResidualQuantity,
        "acceptedResidualQuantity",
      ),
    }),
    ...(claim.commandId === undefined ? {} : {
      commandId: identifier(claim.commandId, "commandId"),
      operationType: claim.operationType,
      businessPayloadFingerprint: identifier(claim.businessPayloadFingerprint, "businessPayloadFingerprint"),
    }),
    createdAt: timestamp(claim.createdAt, "createdAt"),
  });
}

function normalizeManagementReleaseClaim(claim: ManagementReleaseClaim): ManagementReleaseClaim {
  if (claim.operationType !== "MANAGEMENT_RELEASE") {
    throw new Error("Management release operation type is invalid.");
  }
  return Object.freeze({
    ...normalizeManagementRelease(claim),
    commandId: identifier(claim.commandId, "commandId"),
    operationType: claim.operationType,
    businessPayloadFingerprint: identifier(claim.businessPayloadFingerprint, "businessPayloadFingerprint"),
  });
}

function normalizeManagementRelease(claim: ArbitrageLegManagementRelease): ArbitrageLegManagementRelease {
  if (claim.reason !== "USER_CONFIRMED_STOP_MANAGEMENT" || claim.source !== "AUTHENTICATED_API") {
    throw new Error("Management release reason or source is invalid.");
  }
  const requestedAt = timestamp(claim.requestedAt, "requestedAt");
  const confirmedAt = timestamp(claim.confirmedAt, "confirmedAt");
  const realityCheckedAt = timestamp(claim.realityCheckedAt, "realityCheckedAt");
  if (confirmedAt < requestedAt || confirmedAt < realityCheckedAt) {
    throw new Error("Management release timestamps are invalid.");
  }
  const mode = positionMode(claim.positionMode);
  if ((mode === "ONE_WAY" && claim.actualSignedNetQuantity === null)
    || (mode === "HEDGE" && claim.actualSignedNetQuantity !== null)) {
    throw new Error("Management release reality does not match its position mode.");
  }
  return Object.freeze({
    releaseId: identifier(claim.releaseId, "releaseId"),
    arbitrageId: identifier(claim.arbitrageId, "arbitrageId"),
    legId: identifier(claim.legId, "legId"),
    releasedQuantity: normalizePositiveDecimal(claim.releasedQuantity, "releasedQuantity"),
    reason: claim.reason,
    source: claim.source,
    requestedByUserId: identifier(claim.requestedByUserId, "requestedByUserId"),
    requestedAt,
    confirmedAt,
    venue: venue(claim.venue),
    accountId: identifier(claim.accountId, "accountId"),
    instrumentId: instrumentId(claim.instrumentId),
    positionMode: mode,
    actualQuantity: normalizeUnsignedDecimal(claim.actualQuantity, "actualQuantity"),
    actualSignedNetQuantity: claim.actualSignedNetQuantity === null
      ? null
      : normalizeSignedDecimal(claim.actualSignedNetQuantity, "actualSignedNetQuantity"),
    actualLongQuantity: normalizeUnsignedDecimal(claim.actualLongQuantity, "actualLongQuantity"),
    actualShortQuantity: normalizeUnsignedDecimal(claim.actualShortQuantity, "actualShortQuantity"),
    availableQuantity: claim.availableQuantity === null
      ? null
      : normalizeUnsignedDecimal(claim.availableQuantity, "availableQuantity"),
    realityCheckedAt,
  });
}

function normalizeExecutionResult(update: ExecutionResultUpdate): ExecutionResultUpdate {
  if (update.status !== "PENDING_CONFIRMATION" && update.status !== "CONFIRMED"
    && update.status !== "FAILED" && update.status !== "UNKNOWN") {
    throw new Error("Execution result status is invalid.");
  }
  const confirmedQuantity = normalizeUnsignedDecimal(update.confirmedQuantity, "confirmedQuantity");
  if (update.mutationDisposition !== undefined
    && (update.mutationDisposition !== "NOT_DISPATCHED"
      || update.status !== "FAILED"
      || confirmedQuantity !== "0")) {
    throw new Error("NOT_DISPATCHED proof requires a zero-quantity FAILED execution result.");
  }
  return Object.freeze({
    executionIntentId: identifier(update.executionIntentId, "executionIntentId"),
    status: update.status,
    confirmedQuantity,
    ...(update.mutationDisposition === undefined ? {} : { mutationDisposition: update.mutationDisposition }),
    updatedAt: timestamp(update.updatedAt, "updatedAt"),
  });
}

function executionAccountingFactFromRow(row: ExecutionAccountingFactRow): ExecutionAccountingFact {
  if ((row.executionPhase !== "OPENING" && row.executionPhase !== "CLOSING")
    || (row.quantityEffect !== "INCREASE" && row.quantityEffect !== "DECREASE")
    || (row.terminalExecutionStatus !== "CONFIRMED" && row.terminalExecutionStatus !== "FAILED")
    || (row.priceCompleteness !== "COMPLETE" && row.priceCompleteness !== "INCOMPLETE")
    || (row.feeCompleteness !== "COMPLETE" && row.feeCompleteness !== "INCOMPLETE")
    || (row.integrityStatus !== "VERIFIED" && row.integrityStatus !== "NEEDS_CHECK")
    || (row.completeness !== "COMPLETE" && row.completeness !== "INCOMPLETE")) {
    throw new Error("Persisted execution accounting fact enum is invalid.");
  }
  return Object.freeze({
    executionRecordId: identifier(row.executionRecordId, "executionRecordId"),
    arbitrageId: identifier(row.arbitrageId, "arbitrageId"),
    legId: identifier(row.legId, "legId"),
    executionIntentId: identifier(row.executionIntentId, "executionIntentId"),
    providerOrderId: identifier(row.providerOrderId, "providerOrderId"),
    executionPhase: row.executionPhase,
    quantityEffect: row.quantityEffect,
    terminalExecutionStatus: row.terminalExecutionStatus,
    filledQuantity: normalizeUnsignedDecimal(row.filledQuantity, "filledQuantity"),
    averageFillPrice: row.averageFillPrice === null ? null : normalizePositiveDecimal(row.averageFillPrice, "averageFillPrice"),
    feeAmountProvider: row.feeAmountProvider === null ? null : normalizeSignedDecimal(row.feeAmountProvider, "feeAmountProvider"),
    feeAsset: row.feeAsset === null ? null : asset(row.feeAsset),
    tradingFeeNetCostUsdt: row.tradingFeeNetCostUsdt === null
      ? null : normalizeSignedDecimal(row.tradingFeeNetCostUsdt, "tradingFeeNetCostUsdt"),
    confirmedAt: timestamp(row.confirmedAt, "confirmedAt"),
    priceCompleteness: row.priceCompleteness,
    feeCompleteness: row.feeCompleteness,
    integrityStatus: row.integrityStatus,
    completeness: row.completeness,
    createdAt: timestamp(row.createdAt, "createdAt"),
  });
}

function normalizePnl(pnl: ArbitragePnlSummary): ArbitragePnlSummary {
  const values = {
    cumulativeFundingPnl: nullableSignedDecimal(pnl.cumulativeFundingPnl, "cumulativeFundingPnl"),
    realizedTradingPnl: nullableSignedDecimal(pnl.realizedTradingPnl, "realizedTradingPnl"),
    feesCosts: nullableSignedDecimal(pnl.feesCosts, "feesCosts"),
    cumulativeNetPnl: nullableSignedDecimal(pnl.cumulativeNetPnl, "cumulativeNetPnl"),
  };
  const hasValue = Object.values(values).some((value) => value !== null);
  if (hasValue && pnl.asset === null) throw new Error("PnL asset is required when a cumulative value is present.");
  if (!hasValue && pnl.asset !== null) throw new Error("PnL asset must be null while all cumulative values are unknown.");
  if (values.cumulativeNetPnl !== null
    && (values.cumulativeFundingPnl === null || values.realizedTradingPnl === null || values.feesCosts === null)) {
    throw new Error("Cumulative net PnL requires all actual component values.");
  }
  return Object.freeze({
    asset: pnl.asset === null ? null : asset(pnl.asset),
    ...values,
    updatedAt: pnl.updatedAt === null ? null : timestamp(pnl.updatedAt, "pnl.updatedAt"),
  });
}

function legFromRow(row: LegRow): ArbitrageInstanceLeg {
  return Object.freeze({
    legId: row.legId,
    role: legRole(row.role),
    venue: venue(row.venue),
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    plannedQuantity: normalizePositiveDecimal(row.plannedQuantity, "plannedQuantity"),
    confirmedOpenedQuantity: normalizeUnsignedDecimal(row.confirmedOpenedQuantity, "confirmedOpenedQuantity"),
    confirmedClosedQuantity: normalizeUnsignedDecimal(row.confirmedClosedQuantity, "confirmedClosedQuantity"),
  });
}

function referenceFromRow(row: ReferenceRow): ArbitrageExecutionReference {
  return Object.freeze({
    arbitrageId: row.arbitrageId,
    legId: row.legId,
    phase: executionPhase(row.phase),
    quantityEffect: quantityEffect(row.quantityEffect),
    executionIntentId: row.executionIntentId,
    executionRecordId: row.executionRecordId,
    requestedQuantity: normalizePositiveDecimal(row.requestedQuantity, "requestedQuantity"),
    confirmedQuantity: normalizeUnsignedDecimal(row.confirmedQuantity, "confirmedQuantity"),
    status: referenceStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function unresolvedRecoveryCandidateFromRow(
  row: UnresolvedRecoveryCandidateRow,
): UnresolvedExecutionRecoveryCandidate {
  const status = referenceStatus(row.status);
  if (!UNRESOLVED_REFERENCE_STATUSES.includes(status)) {
    throw new Error("Recovery candidate status is terminal.");
  }
  return Object.freeze({
    userId: identifier(row.userId, "userId"),
    arbitrageId: identifier(row.arbitrageId, "arbitrageId"),
    legId: identifier(row.legId, "legId"),
    executionIntentId: identifier(row.executionIntentId, "executionIntentId"),
    executionRecordId: row.executionRecordId === null
      ? null
      : identifier(row.executionRecordId, "executionRecordId"),
    status: status as UnresolvedExecutionRecoveryCandidate["status"],
    phase: executionPhase(row.phase),
    quantityEffect: quantityEffect(row.quantityEffect),
    requestedQuantity: normalizePositiveDecimal(row.requestedQuantity, "requestedQuantity"),
    confirmedQuantity: normalizeUnsignedDecimal(row.confirmedQuantity, "confirmedQuantity"),
    venue: venue(row.venue),
    accountId: identifier(row.accountId, "accountId"),
    instrumentId: instrumentId(row.instrumentId),
    role: legRole(row.role),
    createdAt: timestamp(row.createdAt, "createdAt"),
    updatedAt: timestamp(row.updatedAt, "updatedAt"),
  });
}

function managementReleaseFromRow(row: ManagementReleaseRow): ArbitrageLegManagementRelease {
  return normalizeManagementRelease({
    releaseId: row.releaseId,
    arbitrageId: row.arbitrageId,
    legId: row.legId,
    releasedQuantity: row.releasedQuantity,
    reason: row.reason as ArbitrageLegManagementRelease["reason"],
    source: row.source as ArbitrageLegManagementRelease["source"],
    requestedByUserId: row.requestedByUserId,
    requestedAt: row.requestedAt,
    confirmedAt: row.confirmedAt,
    venue: row.venue as ArbitrageLegManagementRelease["venue"],
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    positionMode: row.positionMode as ArbitrageLegManagementRelease["positionMode"],
    actualQuantity: row.actualQuantity,
    actualSignedNetQuantity: row.actualSignedNetQuantity,
    actualLongQuantity: row.actualLongQuantity,
    actualShortQuantity: row.actualShortQuantity,
    availableQuantity: row.availableQuantity,
    realityCheckedAt: row.realityCheckedAt,
  });
}

function subtractForDelta(left: string, right: string) {
  const normalizedLeft = normalizeUnsignedDecimal(left, "confirmedQuantity");
  const normalizedRight = normalizeUnsignedDecimal(right, "previousConfirmedQuantity");
  const leftParts = decimalParts(normalizedLeft);
  const rightParts = decimalParts(normalizedRight);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftValue = leftParts.value * 10n ** BigInt(scale - leftParts.scale);
  const rightValue = rightParts.value * 10n ** BigInt(scale - rightParts.scale);
  const value = leftValue - rightValue;
  const digits = value.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function terminalStatusCorrectionAllowed(
  reference: Pick<ReferenceRow, "status" | "requestedQuantity">,
  update: ExecutionResultUpdate,
) {
  if (reference.status === update.status) return true;
  return reference.status === "FAILED"
    && update.status === "CONFIRMED"
    && update.confirmedQuantity === reference.requestedQuantity;
}

function mergeAccountingField(
  existing: string | null,
  incoming: string | null,
  quantityExpanded: boolean,
  authoritativeCorrection: boolean,
) {
  if (incoming === null) {
    return { value: existing, reliable: !quantityExpanded && existing !== null } as const;
  }
  if (existing === null || quantityExpanded || authoritativeCorrection || existing === incoming) {
    return { value: incoming, reliable: true } as const;
  }
  return { value: existing, reliable: true } as const;
}

function decimalParts(value: string) {
  const [integer, fraction = ""] = value.split(".");
  return { value: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function nullableSignedDecimal(value: string | null, name: string) {
  return value === null ? null : normalizeSignedDecimal(value, name);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function asset(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z0-9]{2,12}$/u.test(value)) {
    throw new Error("PnL asset is invalid.");
  }
  return value;
}

function instrumentId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}-(?:SPOT|PERP)$/u.test(value)) {
    throw new Error("instrumentId must be a canonical instrument id.");
  }
  return value;
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}

function strategyType(value: unknown) {
  if (value !== "PERPETUAL_PERPETUAL" && value !== "SPOT_PERPETUAL") {
    throw new Error("Arbitrage strategy type is invalid.");
  }
  return value;
}

function instanceStatus(value: unknown): ArbitrageInstanceStatus {
  if (value !== "OPENING" && value !== "HOLDING" && value !== "RESIDUAL"
    && value !== "CLOSING" && value !== "CLOSED" && value !== "FAILED") {
    throw new Error("Arbitrage instance status is invalid.");
  }
  return value;
}

function legRole(value: unknown): ArbitrageInstanceLeg["role"] {
  if (value !== "LONG" && value !== "SHORT") throw new Error("Arbitrage leg role is invalid.");
  return value;
}

function venue(value: unknown): ArbitrageInstanceLeg["venue"] {
  if (value !== "binance" && value !== "okx" && value !== "bybit" && value !== "bitget") {
    throw new Error("Arbitrage leg venue is invalid.");
  }
  return value;
}

function positionMode(value: unknown): ArbitrageLegManagementRelease["positionMode"] {
  if (value !== "ONE_WAY" && value !== "HEDGE") throw new Error("Position mode is invalid.");
  return value;
}

function executionPhase(value: unknown): ArbitrageExecutionPhase {
  if (value !== "OPENING" && value !== "ADJUSTMENT" && value !== "CLOSING") {
    throw new Error("Arbitrage execution phase is invalid.");
  }
  return value;
}

function quantityEffect(value: unknown): ArbitrageQuantityEffect {
  if (value !== "INCREASE" && value !== "DECREASE") {
    throw new Error("Arbitrage quantity effect is invalid.");
  }
  return value;
}

function referenceStatus(value: unknown): ArbitrageExecutionReferenceStatus {
  if (value !== "CLAIMED" && value !== "LINKED" && value !== "PENDING_CONFIRMATION" && value !== "CONFIRMED"
    && value !== "FAILED" && value !== "UNKNOWN") {
    throw new Error("Arbitrage execution reference status is invalid.");
  }
  return value;
}

function assertPhaseAllowed(status: ArbitrageInstanceStatus, phase: ArbitrageExecutionPhase) {
  const allowed = phase === "OPENING"
    ? status === "OPENING" || status === "RESIDUAL"
    : phase === "ADJUSTMENT"
      ? status === "HOLDING" || status === "RESIDUAL"
      : status === "HOLDING" || status === "RESIDUAL" || status === "CLOSING";
  if (!allowed) throw new Error(`Arbitrage instance status ${status} does not accept ${phase} execution.`);
}

function isConstraintError(error: unknown) {
  return error instanceof Error && /constraint|unique|primary key/iu.test(error.message);
}
