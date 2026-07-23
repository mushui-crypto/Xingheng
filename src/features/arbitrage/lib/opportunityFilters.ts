import type {
  ArbitrageEntryStatus,
  ArbitrageOpportunity,
  ArbitrageRecommendation,
  ArbitrageVenue,
} from "../model/types";

export function matchesOpportunityRecommendation(
  opportunity: ArbitrageOpportunity,
  recommendation: "all" | ArbitrageRecommendation,
) {
  return recommendation === "all" || opportunity.recommendation === recommendation;
}

export function matchesOpportunityEntryStatus(
  opportunity: ArbitrageOpportunity,
  entryStatus: "all" | ArbitrageEntryStatus,
) {
  return entryStatus === "all" || opportunity.entryStatus === entryStatus;
}

export function matchesOpportunityVenue(
  opportunity: ArbitrageOpportunity,
  longVenue: "all" | ArbitrageVenue,
  shortVenue: "all" | ArbitrageVenue,
) {
  return (longVenue === "all" || opportunity.longLeg.venue === longVenue)
    && (shortVenue === "all" || opportunity.shortLeg.venue === shortVenue);
}

export function opportunityLegVenues(
  opportunities: ArbitrageOpportunity[],
  leg: "long" | "short",
) {
  return new Set(opportunities.map((opportunity) => (
    leg === "long" ? opportunity.longLeg.venue : opportunity.shortLeg.venue
  )));
}
