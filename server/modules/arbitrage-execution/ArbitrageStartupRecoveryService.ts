import type {
  ArbitrageInstanceStore,
  UnresolvedExecutionRecoveryCandidate,
} from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import {
  ArbitrageExecutionCommandError,
  type ArbitrageExecutionCommandService,
} from "./ArbitrageExecutionCommandService";
import type { LocalNotDispatchedEvidenceEvaluator } from "./LocalNotDispatchedEvidenceEvaluator";

type CandidateSource = Pick<ArbitrageInstanceStore, "listUnresolvedExecutionReferencesForRecovery">
  & Partial<Pick<ArbitrageInstanceStore, "terminalizeClaimedReferenceWithLocalNotDispatchedProof">>;
type Reconciler = Pick<ArbitrageExecutionCommandService, "reconcileLeg">;
type LocalEvidence = Pick<LocalNotDispatchedEvidenceEvaluator, "evaluate">;

export type StartupRecoveryOutcomeStatus =
  | "RECOVERED"
  | "STILL_PENDING"
  | "STILL_UNKNOWN"
  | "MANUAL_REVIEW_REQUIRED"
  | "SKIPPED_TERMINAL";

export type StartupRecoveryOutcome = Readonly<{
  source: "SYSTEM_RECOVERY";
  userId: string;
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  venue: UnresolvedExecutionRecoveryCandidate["venue"];
  oldStatus: UnresolvedExecutionRecoveryCandidate["status"];
  newStatus: string;
  oldConfirmedQuantity: string;
  newConfirmedQuantity: string;
  outcome: StartupRecoveryOutcomeStatus;
  reason: string;
}>;

export type StartupRecoverySummary = Readonly<{
  source: "SYSTEM_RECOVERY";
  candidates: number;
  recovered: number;
  stillPending: number;
  stillUnknown: number;
  manualReview: number;
  skippedTerminal: number;
  outcomes: readonly StartupRecoveryOutcome[];
}>;

export type StartupRecoveryLogger = Readonly<{
  info(message: string, facts: Readonly<Record<string, unknown>>): void;
  warn(message: string, facts: Readonly<Record<string, unknown>>): void;
}>;

const consoleLogger: StartupRecoveryLogger = Object.freeze({
  info: (message, facts) => console.info(message, facts),
  warn: (message, facts) => console.warn(message, facts),
});

export class ArbitrageStartupRecoveryService {
  private latestSummary: StartupRecoverySummary | null = null;

  constructor(
    private readonly candidates: CandidateSource,
    private readonly reconciler: Reconciler,
    private readonly logger: StartupRecoveryLogger = consoleLogger,
    private readonly localEvidence?: LocalEvidence,
  ) {}

  discoverCandidates(): readonly UnresolvedExecutionRecoveryCandidate[] {
    return this.candidates.listUnresolvedExecutionReferencesForRecovery();
  }

  readLatestSummary(): StartupRecoverySummary | null {
    return this.latestSummary;
  }

  async runOnce(
    discoveredCandidates: readonly UnresolvedExecutionRecoveryCandidate[] = this.discoverCandidates(),
  ): Promise<StartupRecoverySummary> {
    const outcomes: StartupRecoveryOutcome[] = [];
    for (const candidate of discoveredCandidates) {
      outcomes.push(await this.recoverCandidate(candidate));
    }
    const summary = summarize(discoveredCandidates.length, outcomes);
    this.latestSummary = summary;
    this.logger.info("[arbitrage-startup-recovery] one-shot completed", summaryFacts(summary));
    return summary;
  }

  private async recoverCandidate(
    candidate: UnresolvedExecutionRecoveryCandidate,
  ): Promise<StartupRecoveryOutcome> {
    try {
      if (candidate.status === "CLAIMED"
        && candidate.executionRecordId === null
        && this.localEvidence !== undefined) {
        const evidence = await this.localEvidence.evaluate(candidate);
        if (evidence.result === "PROVEN_NOT_DISPATCHED") {
          const terminalize = this.candidates.terminalizeClaimedReferenceWithLocalNotDispatchedProof;
          if (!terminalize) throw new Error("Local NOT_DISPATCHED terminalizer is unavailable.");
          const instance = terminalize.call(
            this.candidates,
            candidate.userId,
            candidate.arbitrageId,
            candidate.executionIntentId,
            evidence.checkedAt,
          );
          const terminal = instance.executionReferences.find(
            ({ executionIntentId }) => executionIntentId === candidate.executionIntentId,
          );
          if (!terminal || terminal.status !== "FAILED" || terminal.confirmedQuantity !== "0") {
            throw new Error("Local NOT_DISPATCHED terminal projection is unavailable.");
          }
          this.logger.info("[arbitrage-startup-recovery] execution proven not dispatched", {
            source: "SYSTEM_RECOVERY",
            evidenceSource: evidence.source,
            evidenceReason: evidence.reason,
            executionIntentId: candidate.executionIntentId,
            previousStatus: candidate.status,
            newStatus: terminal.status,
            checkedAt: evidence.checkedAt,
            providerMutationCount: 0,
          });
          return Object.freeze({
            ...identity(candidate),
            newStatus: terminal.status,
            newConfirmedQuantity: terminal.confirmedQuantity,
            outcome: "RECOVERED",
            reason: evidence.reason,
          });
        }
        if (evidence.result === "INSUFFICIENT_EVIDENCE") {
          return Object.freeze({
            ...identity(candidate),
            newStatus: candidate.status,
            newConfirmedQuantity: candidate.confirmedQuantity,
            outcome: "MANUAL_REVIEW_REQUIRED",
            reason: evidence.reason,
          });
        }
      }
      const result = await this.reconciler.reconcileLeg(candidate.userId, {
        arbitrageId: candidate.arbitrageId,
        legId: candidate.legId,
        executionIntentId: candidate.executionIntentId,
      });
      const next = result.executionRecord;
      return Object.freeze({
        ...identity(candidate),
        newStatus: next.status,
        newConfirmedQuantity: next.confirmedQuantity,
        outcome: outcomeForStatus(next.status),
        reason: reasonForStatus(next.status),
      });
    } catch (error) {
      const manualReview = manualReviewRequired(error);
      const reason = safeFailureReason(error);
      const outcome = manualReview ? "MANUAL_REVIEW_REQUIRED" as const : "STILL_UNKNOWN" as const;
      this.logger.warn("[arbitrage-startup-recovery] candidate unresolved", {
        source: "SYSTEM_RECOVERY",
        arbitrageId: candidate.arbitrageId,
        legId: candidate.legId,
        executionIntentId: candidate.executionIntentId,
        venue: candidate.venue,
        outcome,
        reason,
      });
      return Object.freeze({
        ...identity(candidate),
        newStatus: candidate.status,
        newConfirmedQuantity: candidate.confirmedQuantity,
        outcome,
        reason,
      });
    }
  }
}

function identity(candidate: UnresolvedExecutionRecoveryCandidate) {
  return {
    source: "SYSTEM_RECOVERY" as const,
    userId: candidate.userId,
    arbitrageId: candidate.arbitrageId,
    legId: candidate.legId,
    executionIntentId: candidate.executionIntentId,
    venue: candidate.venue,
    oldStatus: candidate.status,
    oldConfirmedQuantity: candidate.confirmedQuantity,
  };
}

function outcomeForStatus(status: string): StartupRecoveryOutcomeStatus {
  if (status === "CONFIRMED" || status === "FAILED") return "RECOVERED";
  if (status === "PENDING_CONFIRMATION" || status === "SUBMITTED") return "STILL_PENDING";
  if (status === "UNKNOWN") return "STILL_UNKNOWN";
  return "STILL_UNKNOWN";
}

function reasonForStatus(status: string) {
  if (status === "CONFIRMED") return "PROVIDER_CONFIRMED";
  if (status === "FAILED") return "PROVIDER_TERMINAL_PARTIAL_OR_ZERO";
  if (status === "PENDING_CONFIRMATION" || status === "SUBMITTED") return "PROVIDER_ORDER_STILL_PENDING";
  return "PROVIDER_FACTS_STILL_UNKNOWN";
}

function manualReviewRequired(error: unknown) {
  return error instanceof ArbitrageExecutionCommandError
    && (error.category === "execution_recovery_record_not_found"
      || error.category === "execution_recovery_identity_conflict"
      || error.category === "manual_reconciliation_required");
}

function safeFailureReason(error: unknown) {
  if (error instanceof ArbitrageExecutionCommandError) return error.category;
  return "RECOVERY_QUERY_UNAVAILABLE";
}

function summarize(candidateCount: number, outcomes: readonly StartupRecoveryOutcome[]): StartupRecoverySummary {
  const count = (status: StartupRecoveryOutcomeStatus) => outcomes.filter(({ outcome }) => outcome === status).length;
  return Object.freeze({
    source: "SYSTEM_RECOVERY",
    candidates: candidateCount,
    recovered: count("RECOVERED"),
    stillPending: count("STILL_PENDING"),
    stillUnknown: count("STILL_UNKNOWN"),
    manualReview: count("MANUAL_REVIEW_REQUIRED"),
    skippedTerminal: count("SKIPPED_TERMINAL"),
    outcomes: Object.freeze([...outcomes]),
  });
}

function summaryFacts(summary: StartupRecoverySummary) {
  return Object.freeze({
    source: summary.source,
    candidates: summary.candidates,
    recovered: summary.recovered,
    stillPending: summary.stillPending,
    stillUnknown: summary.stillUnknown,
    manualReview: summary.manualReview,
    skippedTerminal: summary.skippedTerminal,
  });
}
