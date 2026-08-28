import type express from "express";
import {
  ArbitrageRecoveryOperatorError,
  type ArbitrageRecoveryOperatorService,
} from "../arbitrage-execution/ArbitrageRecoveryOperatorService";

export function registerArbitrageRecoveryRoutes(
  app: express.Express,
  service: Pick<ArbitrageRecoveryOperatorService,
    "readSummary" | "readAnomalies" | "repairLegacyPartialConfirmed" | "backfillSpotAttribution"
    | "sealLegacyUnresolvedExecution">,
) {
  app.get("/api/arbitrage-recovery/summary", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(service.readSummary(userId(request)));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/arbitrage-recovery/anomalies", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(service.readAnomalies(userId(request), request.query));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/arbitrage-recovery/legacy-execution", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.repairLegacyPartialConfirmed(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/arbitrage-recovery/spot-attribution", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.backfillSpotAttribution(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/arbitrage-recovery/seal-legacy-unresolved", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.sealLegacyUnresolvedExecution(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) {
    throw new ArbitrageRecoveryOperatorError("invalid_recovery_request", "用户登录状态无效。");
  }
  return request.user.id;
}

function sendError(response: express.Response, error: unknown) {
  if (error instanceof ArbitrageRecoveryOperatorError) {
    const status = error.category === "recovery_target_not_found" ? 404
      : error.category === "manual_review_required" || error.category === "recovery_conflict" ? 409
        : error.category === "recovery_evidence_unavailable" ? 503
          : 400;
    response.status(status).json({ category: error.category, message: error.message });
    return;
  }
  response.status(502).json({
    category: "arbitrage_recovery_unavailable",
    message: "恢复事实暂不可用；未执行任何交易所 mutation。",
  });
}
