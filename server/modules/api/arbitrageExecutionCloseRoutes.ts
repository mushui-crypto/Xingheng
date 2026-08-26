import type express from "express";
import {
  ArbitrageExecutionCloseError,
  type ArbitrageExecutionCloseService,
} from "../arbitrage-execution/ArbitrageExecutionCloseService";

export function registerArbitrageExecutionCloseRoutes(
  app: express.Express,
  service: Pick<ArbitrageExecutionCloseService, "closeLeg">,
) {
  app.post("/api/arbitrage-execution/legs/close", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.closeLeg(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) {
    throw new ArbitrageExecutionCloseError("invalid_close_confirmation", "用户登录状态无效。");
  }
  return request.user.id;
}

function sendError(response: express.Response, error: unknown) {
  if (error instanceof ArbitrageExecutionCloseError) {
    const status = error.category === "arbitrage_instance_not_found" ? 404
      : error.category === "execution_state_unknown" || error.category === "idempotency_conflict" ? 409
        : 400;
    response.status(status).json({ category: error.category, message: error.message });
    return;
  }
  response.status(502).json({
    category: "arbitrage_execution_close_unavailable",
    message: "套利腿退出暂不可用，请稍后重试。",
  });
}
