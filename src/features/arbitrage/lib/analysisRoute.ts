import type {
  ArbitrageDashboardSnapshot,
  ArbitrageHorizon,
  ArbitrageOpportunity,
} from "../model/types";

export const ARBITRAGE_ANALYSIS_PATH = "/app/funding-arbitrage";

export function buildArbitrageAnalysisHref(
  opportunityId: string,
  horizonDays: ArbitrageHorizon,
  resumeArbitrageId?: string | null,
) {
  const params = new URLSearchParams({
    opportunityId,
    horizonDays: String(horizonDays),
  });
  if (resumeArbitrageId) params.set("resumeArbitrageId", resumeArbitrageId);
  return `${ARBITRAGE_ANALYSIS_PATH}?${params.toString()}`;
}

export function buildArbitrageResumeHref(arbitrageId: string) {
  const params = new URLSearchParams({ resumeArbitrageId: arbitrageId });
  return `/app/arbitrage?${params.toString()}`;
}

export function parseArbitrageAnalysisHorizon(value: string | null): ArbitrageHorizon {
  return value === "365" ? 365 : 90;
}

export function findArbitrageAnalysisOpportunity(
  snapshot: ArbitrageDashboardSnapshot | null,
  opportunityId: string | null,
): ArbitrageOpportunity | null {
  if (!snapshot || !opportunityId) return null;
  return snapshot.opportunities.find((opportunity) => opportunity.id === opportunityId) ?? null;
}
