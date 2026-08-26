import type { UnresolvedExecutionRecoveryCandidate } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ExecutionRecordRecoveryStore } from "../cex/ExecutionRecordStore";

export type NotDispatchedEvidenceResult = Readonly<{
  result: "PROVEN_NOT_DISPATCHED" | "DISPATCH_POSSIBLE" | "INSUFFICIENT_EVIDENCE";
  source: "LOCAL_PRE_DISPATCH_PROOF";
  reason:
    | "LOCAL_NO_EXECUTION_RECORD"
    | "LOCAL_EXECUTION_RECORD_EXISTS"
    | "LOCAL_EXECUTION_RECORD_LOOKUP_UNAVAILABLE";
  checkedAt: number;
}>;

type RecordSource = Pick<ExecutionRecordRecoveryStore, "findByIntentId">;

export class LocalNotDispatchedEvidenceEvaluator {
  constructor(
    private readonly records: RecordSource,
    private readonly now: () => number = Date.now,
  ) {}

  async evaluate(
    candidate: UnresolvedExecutionRecoveryCandidate,
  ): Promise<NotDispatchedEvidenceResult> {
    if (candidate.status !== "CLAIMED" || candidate.executionRecordId !== null) {
      return evidence("DISPATCH_POSSIBLE", "LOCAL_EXECUTION_RECORD_EXISTS", this.now());
    }
    try {
      const records = await this.records.findByIntentId(candidate.executionIntentId);
      return records.length === 0
        ? evidence("PROVEN_NOT_DISPATCHED", "LOCAL_NO_EXECUTION_RECORD", this.now())
        : evidence("DISPATCH_POSSIBLE", "LOCAL_EXECUTION_RECORD_EXISTS", this.now());
    } catch {
      return evidence(
        "INSUFFICIENT_EVIDENCE",
        "LOCAL_EXECUTION_RECORD_LOOKUP_UNAVAILABLE",
        this.now(),
      );
    }
  }
}

function evidence(
  result: NotDispatchedEvidenceResult["result"],
  reason: NotDispatchedEvidenceResult["reason"],
  checkedAt: number,
): NotDispatchedEvidenceResult {
  return Object.freeze({ result, source: "LOCAL_PRE_DISPATCH_PROOF", reason, checkedAt });
}
