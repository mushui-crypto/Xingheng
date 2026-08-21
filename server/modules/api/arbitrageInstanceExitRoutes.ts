import type express from "express";
import {
  ArbitrageInstanceExitError,
  type ArbitrageInstanceExitService,
} from "../arbitrage-execution/ArbitrageInstanceExitService";

export function registerArbitrageInstanceExitRoutes(
  app: express.Express,
  service: Pick<ArbitrageInstanceExitService, "exit" | "reconcile">,
) {
  app.post("/api/arbitrage-execution/exit", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.exit(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });
  app.post("/api/arbitrage-execution/reconcile", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.reconcile(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) throw new ArbitrageInstanceExitError("invalid_exit_confirmation", "用户登录状态无效。");
  return request.user.id;
}

function sendError(response: express.Response, error: unknown) {
  if (error instanceof ArbitrageInstanceExitError) {
    response.status(error.category === "arbitrage_instance_not_found" ? 404 : 400)
      .json({ category: error.category, message: error.message });
    return;
  }
  response.status(502).json({ category: "arbitrage_instance_exit_unavailable", message: "对冲退出暂不可用，请稍后重试。" });
}
