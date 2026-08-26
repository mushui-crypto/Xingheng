import type express from "express";
import {
  ArbitrageHedgeStartError,
  type ArbitrageHedgeStartService,
} from "../arbitrage-execution/ArbitrageHedgeStartService";
import { ArbitrageExecutionCommandError } from "../arbitrage-execution/ArbitrageExecutionCommandService";

export function registerArbitrageHedgeStartRoutes(
  app: express.Express,
  service: Pick<ArbitrageHedgeStartService, "start">,
) {
  app.post("/api/arbitrage-instances/:arbitrageId/start-hedge", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.start(
        userId(request),
        pathValue(request.params.arbitrageId, "arbitrageId"),
        request.body,
      ));
    } catch (error) {
      sendError(response, error);
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) {
    throw new ArbitrageHedgeStartError("invalid_start_confirmation", "用户登录状态无效。");
  }
  return request.user.id;
}

function pathValue(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw new ArbitrageHedgeStartError("invalid_start_confirmation", `${name} 无效。`);
  }
  return value.trim();
}

function sendError(response: express.Response, error: unknown) {
  if (error instanceof ArbitrageHedgeStartError) {
    response.status(error.category === "arbitrage_instance_not_found" ? 404
      : error.category === "idempotency_conflict" ? 409 : 400)
      .json({ category: error.category, message: error.message });
    return;
  }
  if (error instanceof ArbitrageExecutionCommandError) {
    const status = error.category === "arbitrage_instance_not_found"
      || error.category === "arbitrage_execution_reference_not_found" ? 404
      : error.category === "execution_state_unknown"
        || error.category === "manual_reconciliation_required"
        || error.category === "idempotency_conflict" ? 409 : 400;
    response.status(status).json({ category: error.category, message: error.message });
    return;
  }
  response.status(502).json({
    category: "arbitrage_hedge_start_unavailable",
    message: "一键开始对冲暂不可用，请稍后重试。",
  });
}
