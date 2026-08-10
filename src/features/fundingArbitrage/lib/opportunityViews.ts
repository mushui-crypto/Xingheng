import type {
  FundingOpportunityConfidence,
  FundingOpportunitySort,
  FundingOpportunityVenue,
  FundingOpportunityView,
} from "../model/types";

export type FundingOpportunityFilters = {
  confidence: FundingOpportunityConfidence | "all";
  longVenue: FundingOpportunityVenue | "all";
  shortVenue: FundingOpportunityVenue | "all";
  symbol: string;
};

export function filterFundingOpportunities(
  opportunities: readonly FundingOpportunityView[],
  filters: FundingOpportunityFilters,
) {
  const symbol = filters.symbol.trim().toUpperCase();
  return opportunities
    .filter((opportunity) => !symbol || opportunity.symbol.toUpperCase().includes(symbol))
    .filter((opportunity) => filters.confidence === "all" || opportunity.confidence === filters.confidence)
    .filter((opportunity) => filters.longVenue === "all" || opportunity.longVenue === filters.longVenue)
    .filter((opportunity) => filters.shortVenue === "all" || opportunity.shortVenue === filters.shortVenue);
}

export function sortFundingOpportunities(
  opportunities: readonly FundingOpportunityView[],
  sort: FundingOpportunitySort,
) {
  return [...opportunities].sort((left, right) => compareFundingOpportunity(left, right, sort));
}

export function venueOptions(
  opportunities: readonly FundingOpportunityView[],
  leg: "long" | "short",
) {
  return new Set(opportunities.map((opportunity) => leg === "long" ? opportunity.longVenue : opportunity.shortVenue));
}

export function venueLabel(venue: FundingOpportunityVenue) {
  return venue === "binance" ? "Binance"
    : venue === "okx" ? "OKX"
      : venue === "bybit" ? "Bybit"
        : "Bitget";
}

export function confidenceLabel(confidence: FundingOpportunityConfidence) {
  return confidence === "high" ? "高"
    : confidence === "medium" ? "中"
      : "低";
}

export function formatRate(value: number, signed = false) {
  if (!Number.isFinite(value)) return "-";
  const percentage = value * 100;
  const prefix = signed && percentage > 0 ? "+" : "";
  return `${prefix}${percentage.toFixed(4)}%`;
}

export function formatTime(value: number) {
  if (!Number.isFinite(value)) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function compareFundingOpportunity(
  left: FundingOpportunityView,
  right: FundingOpportunityView,
  sort: FundingOpportunitySort,
) {
  if (sort === "confidence") {
    return confidenceRank(right.confidence) - confidenceRank(left.confidence)
      || right.estimatedNetYield - left.estimatedNetYield
      || left.expiresAt - right.expiresAt;
  }
  if (sort === "expiresAt") {
    return left.expiresAt - right.expiresAt
      || right.estimatedNetYield - left.estimatedNetYield;
  }
  return right.estimatedNetYield - left.estimatedNetYield
    || confidenceRank(right.confidence) - confidenceRank(left.confidence)
    || left.expiresAt - right.expiresAt;
}

function confidenceRank(confidence: FundingOpportunityConfidence) {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}
