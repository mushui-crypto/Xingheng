import type { CexVenue } from "../CexCanonicalModels";
import type { FundingSpreadConfidence, FundingSpreadPlan } from "./FundingSpreadPlan";

export type FundingOpportunitySort = "estimatedNetYield" | "confidence" | "expiresAt";

export type FundingOpportunityQuery = Readonly<{
  sort?: FundingOpportunitySort;
  confidence?: FundingSpreadConfidence | "all";
  symbol?: string;
}>;

export type FundingOpportunityView = Readonly<{
  symbol: string;
  longVenue: CexVenue;
  shortVenue: CexVenue;
  fundingSpread: number;
  estimatedCost: number;
  estimatedNetYield: number;
  confidence: FundingSpreadConfidence;
  createdAt: number;
  expiresAt: number;
}>;

export type FundingOpportunityQuerySnapshot = Readonly<{
  generatedAt: number;
  opportunities: FundingOpportunityView[];
}>;

export type FundingSpreadPlanSource = () => Promise<readonly FundingSpreadPlan[]>;

export class FundingOpportunityQueryService {
  constructor(
    private readonly source: FundingSpreadPlanSource = async () => [],
    private readonly now: () => number = Date.now,
  ) {}

  async list(query: FundingOpportunityQuery = {}): Promise<FundingOpportunityQuerySnapshot> {
    const plans = await this.source();
    const symbol = query.symbol?.trim().toUpperCase();
    const confidence = query.confidence ?? "all";
    const sort = query.sort ?? "estimatedNetYield";
    const opportunities = plans
      .map(toOpportunityView)
      .filter((opportunity) => !symbol || opportunity.symbol.toUpperCase() === symbol)
      .filter((opportunity) => confidence === "all" || opportunity.confidence === confidence)
      .sort((left, right) => compareOpportunityViews(left, right, sort));

    return {
      generatedAt: this.now(),
      opportunities,
    };
  }
}

export function toOpportunityView(plan: FundingSpreadPlan): FundingOpportunityView {
  return {
    symbol: plan.symbol,
    longVenue: plan.longVenue,
    shortVenue: plan.shortVenue,
    fundingSpread: plan.fundingSpread,
    estimatedCost: plan.estimatedCost,
    estimatedNetYield: plan.estimatedNetYield,
    confidence: plan.confidence,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
  };
}

function compareOpportunityViews(
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

function confidenceRank(confidence: FundingSpreadConfidence) {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}
