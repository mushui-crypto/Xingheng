import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import { managedCurrentQuantity } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import type { ExecutionOrderReferenceStore } from "../cex/ExecutionOrderReferenceStore";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import type { HistoricalExecutionEvidence, HistoricalExecutionEvidenceResolver } from "./HistoricalExecutionEvidence";

type InstanceStore = Pick<ArbitrageInstanceStore, "get" | "applyExecutionResult">;
type RecordStore = Pick<ExecutionRecordStore, "loadForUser" | "update">;
type VerificationService = Pick<ArbitragePositionVerificationService, "verify">;

export type HistoricalUnknownRecoveryResult = Readonly<{
  instance: ArbitrageInstance;
  evidence: HistoricalExecutionEvidence;
  idempotentReplay: boolean;
}>;

export class HistoricalUnknownRecoveryError extends Error {
  constructor(
    readonly category:
      | "invalid_historical_recovery"
      | "historical_recovery_instance_not_found"
      | "historical_recovery_proof_incomplete",
    message: string,
  ) {
    super(message);
  }
}

export class HistoricalUnknownNotDispatchedRecoveryService {
  private readonly inFlight = new Map<string, Promise<HistoricalUnknownRecoveryResult>>();

  constructor(
    private readonly instances: InstanceStore,
    private readonly records: RecordStore,
    private readonly orderReferences: Pick<ExecutionOrderReferenceStore, "loadForUser">,
    private readonly positions: VerificationService,
    private readonly evidence: HistoricalExecutionEvidenceResolver,
    private readonly now: () => number = Date.now,
  ) {}

  recover(authenticatedUserId: string, input: unknown) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = recoveryRequest(input);
    const key = `${userId}\u0000${request.arbitrageId}\u0000${request.legId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.recoverOnce(userId, request);
    this.inFlight.set(key, operation);
    return operation.finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
  }

  private async recoverOnce(userId: string, request: RecoveryRequest): Promise<HistoricalUnknownRecoveryResult> {
    const instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) {
      throw new HistoricalUnknownRecoveryError(
        "historical_recovery_instance_not_found",
        "套利实例不存在或不属于当前用户。",
      );
    }
    const leg = instance.legs.find((candidate) => candidate.legId === request.legId);
    if (!leg) throw incomplete("所选套利腿不属于该实例。");
    const reference = instance.executionReferences.find((candidate) => candidate.legId === leg.legId);
    if (instance.status === "FAILED" && reference?.status === "FAILED") {
      return Object.freeze({ instance, evidence: unavailableEvidence(this.now()), idempotentReplay: true });
    }
    if (instance.status !== "OPENING"
      || instance.executionReferences.length !== 1
      || !reference
      || reference.phase !== "OPENING"
      || reference.quantityEffect !== "INCREASE"
      || reference.status !== "UNKNOWN"
      || reference.confirmedQuantity !== "0"
      || !reference.executionRecordId
      || instance.legs.some((candidate) => managedCurrentQuantity(candidate) !== "0")) {
      throw incomplete("历史 UNKNOWN 不满足空仓、单腿、零成交的恢复边界。");
    }
    const record = await this.records.loadForUser(userId, reference.executionRecordId);
    if (!record
      || record.intentId !== reference.executionIntentId
      || record.accountId !== leg.accountId
      || record.venue !== leg.venue
      || record.instrumentId !== leg.instrumentId
      || (record.status !== "UNKNOWN" && record.status !== "FAILED")
      || record.executionAttemptId !== undefined
      || record.remoteOrderId !== undefined) {
      throw incomplete("ExecutionRecord identity 或远端 mutation identity 不满足恢复边界。");
    }
    const anchor = await this.orderReferences.loadForUser(userId, record.executionId, record.venue);
    if (anchor) throw incomplete("执行已存在 recovery/order anchor，不能证明 NOT_DISPATCHED。");

    const verification = await this.positions.verify(userId, instance.arbitrageId);
    if (!verification
      || verification.legs.some((candidate) => candidate.verificationStatus === "UNKNOWN"
        || candidate.actualQuantity !== "0")) {
      throw incomplete("Provider position facts 不能证明实例当前无 managed exposure。");
    }
    const evidence = await this.evidence.verify(record.venue, { instance, executionRecord: record });
    if (!evidence.recoveryAnchorRequiredBeforeMutation
      || evidence.exactOrderEvidence !== "ABSENT"
      || evidence.activeOrderEvidence !== "NONE"
      || evidence.absenceScope !== "AUTHORITATIVE") {
      throw incomplete("Provider order/history facts 不能完整证明 NOT_DISPATCHED。");
    }

    const failedAt = Math.max(record.updatedAt, evidence.checkedAt, this.now());
    if (record.status === "UNKNOWN") {
      await this.records.update({ ...record, status: "FAILED", updatedAt: failedAt }, record);
    }
    const updated = this.instances.applyExecutionResult(userId, instance.arbitrageId, {
      executionIntentId: reference.executionIntentId,
      status: "FAILED",
      confirmedQuantity: "0",
      mutationDisposition: "NOT_DISPATCHED",
      updatedAt: failedAt,
    });
    console.info("[arbitrage-execution] historical UNKNOWN terminalized with complete NOT_DISPATCHED proof", {
      arbitrageId: instance.arbitrageId,
      legId: leg.legId,
      executionId: record.executionId,
      venue: record.venue,
      checkedAt: evidence.checkedAt,
    });
    return Object.freeze({ instance: updated, evidence, idempotentReplay: false });
  }
}

type RecoveryRequest = Readonly<{ arbitrageId: string; legId: string; confirmed: true }>;

function recoveryRequest(input: unknown): RecoveryRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HistoricalUnknownRecoveryError("invalid_historical_recovery", "恢复请求无效。");
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set(["arbitrageId", "legId", "confirmed"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.confirmed !== true) {
    throw new HistoricalUnknownRecoveryError("invalid_historical_recovery", "恢复请求必须显式确认且不能包含 Provider identity。");
  }
  return Object.freeze({
    arbitrageId: identifier(value.arbitrageId, "arbitrageId"),
    legId: identifier(value.legId, "legId"),
    confirmed: true,
  });
}

function incomplete(message: string) {
  return new HistoricalUnknownRecoveryError("historical_recovery_proof_incomplete", message);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new HistoricalUnknownRecoveryError("invalid_historical_recovery", `${name} 无效。`);
  }
  return value.trim();
}

function unavailableEvidence(checkedAt: number): HistoricalExecutionEvidence {
  return Object.freeze({
    recoveryAnchorRequiredBeforeMutation: false,
    exactOrderEvidence: "UNKNOWN",
    activeOrderEvidence: "UNKNOWN",
    absenceScope: "UNKNOWN",
    checkedAt,
  });
}
