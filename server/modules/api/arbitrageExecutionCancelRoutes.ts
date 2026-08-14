import type express from "express";
import {
  ArbitrageExecutionCancelError,
  type ArbitrageExecutionCancelService,
} from "../arbitrage-execution/ArbitrageExecutionCancelService";

export function registerArbitrageExecutionCancelRoutes(
  app: express.Express,
  service: Pick<ArbitrageExecutionCancelService, "cancelKnownOrder">,
) {
  app.post("/api/arbitrage-execution/orders/cancel", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.cancelKnownOrder(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) {
    throw new ArbitrageExecutionCancelError("invalid_cancel_confirmation", "用户登录状态无效。");
  }
  return request.user.id;
}

function sendError(response: express.Response, error: unknown) {
  if (error instanceof ArbitrageExecutionCancelError) {
    const status = error.category === "arbitrage_instance_not_found"
      || error.category === "arbitrage_execution_reference_not_found" ? 404
      : error.category === "execution_state_unknown" || error.category === "cancel_state_unavailable" ? 409
        : 400;
    response.status(status).json({ category: error.category, message: error.message });
    return;
  }
  response.status(502).json({
    category: "arbitrage_execution_cancel_unavailable",
    message: "订单撤销暂不可用，请稍后重试。",
  });
}
