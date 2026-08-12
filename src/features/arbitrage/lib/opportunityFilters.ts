import type {
  ArbitrageEntryStatus,
  ArbitrageOpportunity,
  ArbitrageRecommendation,
  ArbitrageVenue,
} from "../model/types";

export type OpportunityProductType = "spot_perpetual" | "perpetual_perpetual";

export function opportunityProductType(
  opportunity: Pick<ArbitrageOpportunity, "longLeg" | "shortLeg">,
): OpportunityProductType | null {
  if (opportunity.longLeg.kind === "spot" && opportunity.shortLeg.kind === "perpetual") {
    return "spot_perpetual";
  }
  if (opportunity.longLeg.kind === "perpetual" && opportunity.shortLeg.kind === "perpetual") {
    return "perpetual_perpetual";
  }
  return null;
}

export function matchesOpportunityProductType(
  opportunity: ArbitrageOpportunity,
  productType: "all" | OpportunityProductType,
) {
  return productType === "all" || opportunityProductType(opportunity) === productType;
}

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
