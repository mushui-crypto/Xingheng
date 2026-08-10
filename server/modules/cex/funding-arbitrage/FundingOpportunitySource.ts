import type { FundingSpreadPlan } from "./FundingSpreadPlan";

export interface FundingOpportunitySource {
  getOpportunities(): Promise<readonly FundingSpreadPlan[]>;
}

export const emptyFundingOpportunitySource: FundingOpportunitySource = {
  getOpportunities: async () => [],
};
