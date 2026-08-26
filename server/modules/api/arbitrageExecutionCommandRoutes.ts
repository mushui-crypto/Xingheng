import type express from "express";
import {
  ArbitrageExecutionCommandError,
  type ArbitrageExecutionCommandService,
} from "../arbitrage-execution/ArbitrageExecutionCommandService";

export function registerArbitrageExecutionCommandRoutes(
  app: express.Express,
  service: Pick<ArbitrageExecutionCommandService, "confirm" | "executeLeg" | "reconcileLeg">,
) {
  app.post("/api/arbitrage-execution/confirm", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.confirm(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/arbitrage-execution/legs/confirm", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.executeLeg(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/arbitrage-execution/legs/reconcile", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.reconcileLeg(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });
}
function userId(request: express.Request) {
  if (!request.user?.id) {
    throw new ArbitrageExecutionCommandError("invalid_execution_confirmation", "用户登录状态无效。");
  }
  return request.user.id;
}

function sendError(response: express.Response, error: unknown) {
  if (error instanceof ArbitrageExecutionCommandError) {
    const status = error.category === "arbitrage_instance_not_found"
      || error.category === "arbitrage_execution_reference_not_found" ? 404
      : error.category === "execution_state_unknown"
        || error.category === "manual_reconciliation_required"
        || error.category === "idempotency_conflict" ? 409
        : 400;
    response.status(status).json({
      category: error.category,
      message: error.message,
      ...(error.manualReconciliation ?? {}),
    });
    return;
  }
  response.status(502).json({
    category: "arbitrage_execution_confirmation_unavailable",
    message: "套利执行确认暂不可用，请稍后重试。",
  });
}
