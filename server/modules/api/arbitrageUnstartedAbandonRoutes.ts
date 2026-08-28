import type express from "express";
import {
  ArbitrageUnstartedAbandonError,
  type ArbitrageUnstartedAbandonService,
} from "../arbitrage-execution/ArbitrageUnstartedAbandonService";

export function registerArbitrageUnstartedAbandonRoutes(
  app: express.Express,
  service: Pick<ArbitrageUnstartedAbandonService, "abandon">,
) {
  app.post("/api/arbitrage-execution/abandon-unstarted", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(service.abandon(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) {
    throw new ArbitrageUnstartedAbandonError("authentication_required", "用户登录状态无效。");
  }
  return request.user.id;
}

function sendError(response: express.Response, error: unknown) {
  if (error instanceof ArbitrageUnstartedAbandonError) {
    const status = error.category === "authentication_required"
      ? 401
      : error.category === "arbitrage_instance_not_found"
        ? 404
        : error.category === "abandon_unavailable" || error.category === "idempotency_conflict"
          ? 409
          : 400;
    response.status(status).json({ category: error.category, message: error.message });
    return;
  }
  response.status(502).json({
    category: "abandon_unstarted_arbitrage_unavailable",
    message: "未开始套利暂无法终止，请稍后重试。",
  });
}
