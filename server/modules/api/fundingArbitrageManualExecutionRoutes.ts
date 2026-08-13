import type express from "express";
import {
  FundingArbitrageManualExecutionError,
  type FundingArbitrageManualExecutionService,
} from "./FundingArbitrageManualExecutionService";
import { BinanceProviderError } from "../binance/BinanceClient";
import { BinanceRiskError } from "../binance/BinanceRiskGuard";
import { CredentialKeyProviderError } from "../credentials/CredentialKeyProvider";
import { UserExchangeCredentialStoreError } from "../credentials/UserExchangeCredentialStore";

export function registerFundingArbitrageManualExecutionRoutes(
  app: express.Express,
  service: FundingArbitrageManualExecutionService,
) {
  app.post("/api/funding-arbitrage/executions/manual", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.execute(userId(request), request.body));
    } catch (error) {
      const result = errorResponse(error);
      response.status(result.status).json({ category: result.category, message: result.message });
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) {
    throw new FundingArbitrageManualExecutionError("authentication_required", "User authentication is required.");
  }
  return request.user.id;
}

function errorResponse(error: unknown) {
  if (error instanceof FundingArbitrageManualExecutionError) {
    const status = error.category === "authentication_required" ? 401
      : error.category === "funding_intent_not_found"
        || error.category === "funding_leg_not_found"
        || error.category === "arbitrage_instance_not_found" ? 404
      : error.category === "unsupported_execution_venue"
        || error.category === "arbitrage_instance_mismatch" ? 409
      : 400;
    return { status, category: error.category, message: error.message };
  }
  if (error instanceof BinanceRiskError) return { status: 409, category: error.category, message: error.message };
  if (error instanceof BinanceProviderError) return { status: 502, category: error.category, message: error.message };
  if (error instanceof CredentialKeyProviderError) return { status: 503, category: error.category, message: error.message };
  if (error instanceof UserExchangeCredentialStoreError) {
    const status = error.category === "credential_not_configured" ? 409 : 503;
    return { status, category: error.category, message: error.message };
  }
  return {
    status: 400,
    category: "manual_execution_error",
    message: error instanceof Error ? error.message : "Manual execution request failed.",
  };
}
