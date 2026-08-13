import type express from "express";
import {
  ArbitrageExecutionDraftError,
  type ArbitrageExecutionDraftService,
} from "../arbitrage-execution/ArbitrageExecutionDraftService";

export function registerArbitrageExecutionDraftRoutes(
  app: express.Express,
  service: Pick<ArbitrageExecutionDraftService, "createDraft" | "preview">,
) {
  app.get("/api/arbitrage-execution/draft", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.createDraft(userId(request), {
        opportunityId: request.query.opportunityId,
        horizonDays: numericHorizon(request.query.horizonDays),
      }));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/arbitrage-execution/draft/preview", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.preview(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) throw new ArbitrageExecutionDraftError("invalid_execution_draft_request", "用户登录状态无效。");
  return request.user.id;
}

function numericHorizon(value: unknown) {
  return typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
}

function sendError(response: express.Response, error: unknown) {
  if (error instanceof ArbitrageExecutionDraftError) {
    const status = error.category === "opportunity_not_found" ? 404 : 400;
    response.status(status).json({ category: error.category, message: error.message });
    return;
  }
  response.status(502).json({ category: "execution_draft_unavailable", message: "套利执行草案暂不可用，请稍后重试。" });
}
