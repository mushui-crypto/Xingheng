import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionVenue } from "../cex/ExecutionIntent";

export type HistoricalExecutionEvidence = Readonly<{
  recoveryAnchorRequiredBeforeMutation: boolean;
  exactOrderEvidence: "ABSENT" | "PRESENT" | "UNKNOWN";
  activeOrderEvidence: "NONE" | "PRESENT" | "UNKNOWN";
  absenceScope: "AUTHORITATIVE" | "HISTORICAL_WINDOW_UNCERTAIN" | "UNKNOWN";
  checkedAt: number;
}>;

export type HistoricalExecutionEvidenceRequest = Readonly<{
  instance: ArbitrageInstance;
  executionRecord: ExecutionRecord;
}>;

export interface HistoricalExecutionEvidenceSource {
  readonly venue: ExecutionVenue;
  verify(request: HistoricalExecutionEvidenceRequest): Promise<HistoricalExecutionEvidence>;
}

export interface HistoricalExecutionEvidenceResolver {
  verify(venue: ExecutionVenue, request: HistoricalExecutionEvidenceRequest): Promise<HistoricalExecutionEvidence>;
}

export class HistoricalExecutionEvidenceRegistry implements HistoricalExecutionEvidenceResolver {
  private readonly sources: ReadonlyMap<ExecutionVenue, HistoricalExecutionEvidenceSource>;

  constructor(sources: readonly HistoricalExecutionEvidenceSource[]) {
    this.sources = new Map(sources.map((source) => [source.venue, source]));
  }

  async verify(venue: ExecutionVenue, request: HistoricalExecutionEvidenceRequest) {
    const source = this.sources.get(venue);
    if (!source) return unknownEvidence(Date.now());
    try {
      return await source.verify(request);
    } catch {
      return unknownEvidence(Date.now());
    }
  }
}

function unknownEvidence(checkedAt: number): HistoricalExecutionEvidence {
  return Object.freeze({
    recoveryAnchorRequiredBeforeMutation: false,
    exactOrderEvidence: "UNKNOWN",
    activeOrderEvidence: "UNKNOWN",
    absenceScope: "UNKNOWN",
    checkedAt,
  });
}
