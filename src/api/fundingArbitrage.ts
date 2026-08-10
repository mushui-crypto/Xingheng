import { requestJson } from "./httpClient";
import type {
  FundingOpportunityConfidence,
  FundingOpportunitySnapshot,
  FundingOpportunitySort,
} from "../features/fundingArbitrage/model/types";

export type FundingOpportunityQuery = {
  sort?: FundingOpportunitySort;
  confidence?: FundingOpportunityConfidence | "all";
  symbol?: string;
};

export function fetchFundingArbitrageOpportunities(query: FundingOpportunityQuery = {}) {
  const params = new URLSearchParams();
  if (query.sort) params.set("sort", query.sort);
  if (query.confidence && query.confidence !== "all") params.set("confidence", query.confidence);
  if (query.symbol?.trim()) params.set("symbol", query.symbol.trim());
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson<FundingOpportunitySnapshot>(
    `/api/funding-arbitrage/opportunities${suffix}`,
    "资金费率套利机会加载失败。",
    { networkErrorMessage: "无法连接资金费率套利机会服务。" },
  );
}
