import type express from "express";
import {
  type FundingOpportunityQuery,
  type FundingOpportunityQueryService,
  type FundingOpportunitySort,
} from "../cex/funding-arbitrage/FundingOpportunityQueryService";
import type { FundingSpreadConfidence } from "../cex/funding-arbitrage/FundingSpreadPlan";

const supportedSorts = new Set<FundingOpportunitySort>(["estimatedNetYield", "confidence", "expiresAt"]);
const supportedConfidence = new Set<FundingSpreadConfidence | "all">(["all", "high", "medium", "low"]);

export function registerFundingArbitrageRoutes(
  app: express.Express,
  service: FundingOpportunityQueryService,
) {
  app.get("/api/funding-arbitrage/opportunities", async (request, response) => {
    try {
      response.json(await service.list(parseOpportunityQuery(request.query)));
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "资金费率套利机会加载失败。",
      });
    }
  });
}

function parseOpportunityQuery(query: express.Request["query"]): FundingOpportunityQuery {
  const parsed: {
    sort?: FundingOpportunitySort;
    confidence?: FundingSpreadConfidence | "all";
    symbol?: string;
  } = {};
  const sort = typeof query.sort === "string" && supportedSorts.has(query.sort as FundingOpportunitySort)
    ? query.sort as FundingOpportunitySort
    : undefined;
  const confidence = typeof query.confidence === "string" && supportedConfidence.has(query.confidence as FundingSpreadConfidence | "all")
    ? query.confidence as FundingSpreadConfidence | "all"
    : undefined;
  const symbol = typeof query.symbol === "string" && query.symbol.trim() ? query.symbol : undefined;
  if (sort) parsed.sort = sort;
  if (confidence) parsed.confidence = confidence;
  if (symbol) parsed.symbol = symbol;
  return parsed;
}
