import type express from "express";
import {
  HistoricalUnknownRecoveryError,
  type HistoricalUnknownNotDispatchedRecoveryService,
} from "../arbitrage-execution/HistoricalUnknownNotDispatchedRecoveryService";

export function registerHistoricalUnknownRecoveryRoutes(
  app: express.Express,
  service: Pick<HistoricalUnknownNotDispatchedRecoveryService, "recover">,
) {
  app.post("/api/arbitrage-execution/legs/recover-not-dispatched", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.recover(userId(request), request.body));
    } catch (error) {
      if (error instanceof HistoricalUnknownRecoveryError) {
        const status = error.category === "historical_recovery_instance_not_found"
          ? 404
          : error.category === "invalid_historical_recovery" ? 400 : 409;
        response.status(status).json({
          category: error.category,
          message: error.message,
        });
        return;
      }
      response.status(502).json({
        category: "historical_recovery_unavailable",
        message: "历史执行恢复暂不可用；未修改执行状态。",
      });
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) {
    throw new HistoricalUnknownRecoveryError("invalid_historical_recovery", "用户登录状态无效。");
  }
  return request.user.id;
}
