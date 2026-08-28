import type express from "express";
import {
  ArbitrageUnstartedResumeError,
  type ArbitrageUnstartedResumeService,
} from "../arbitrage-execution/ArbitrageUnstartedResumeService";

export function registerArbitrageUnstartedResumeRoutes(
  app: express.Express,
  service: Pick<ArbitrageUnstartedResumeService, "load">,
) {
  app.get("/api/arbitrage-instances/:arbitrageId/resume-opening", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      if (!request.user?.id) {
        response.status(401).json({ category: "authentication_required", message: "请先登录。" });
        return;
      }
      response.json(await service.load(request.user.id, request.params.arbitrageId));
    } catch (error) {
      if (error instanceof ArbitrageUnstartedResumeError) {
        response.status(error.category === "arbitrage_instance_not_found" ? 404 : 409).json({
          category: error.category,
          message: error.message,
        });
        return;
      }
      response.status(502).json({
        category: "arbitrage_resume_unavailable",
        message: "当前实例设置暂时无法恢复，请稍后重试。",
      });
    }
  });
}
