import type express from "express";
import type { ArbitrageExecutionCommandService } from "../arbitrage-execution/ArbitrageExecutionCommandService";
import type { ArbitrageHedgeWorkflowService } from "../arbitrage-execution/ArbitrageHedgeWorkflowService";

export function registerArbitrageHedgeWorkflowRoutes(
  app: express.Express,
  workflow: Pick<ArbitrageHedgeWorkflowService, "read">,
  commands: Pick<ArbitrageExecutionCommandService, "continuePartialHedge">,
) {
  app.get("/api/arbitrage-instances/:arbitrageId/workflow", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const result = workflow.read(userId(request), pathValue(request.params.arbitrageId));
      if (!result) {
        response.status(404).json({ category: "arbitrage_instance_not_found", message: "套利实例不存在。" });
        return;
      }
      response.json(result);
    } catch {
      response.status(400).json({ category: "invalid_workflow_request", message: "对冲流程状态请求无效。" });
    }
  });

  app.post("/api/arbitrage-instances/:arbitrageId/continue-hedge", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await commands.continuePartialHedge(
        userId(request),
        pathValue(request.params.arbitrageId),
        request.body,
      ));
    } catch (error) {
      const value = error as { category?: string; message?: string };
      const status = value.category === "arbitrage_instance_not_found" ? 404
        : value.category === "idempotency_conflict" || value.category === "execution_state_unknown" ? 409 : 400;
      response.status(status).json({
        category: value.category ?? "partial_hedge_continuation_unavailable",
        message: value.message ?? "继续对冲已成交部分暂不可用。",
      });
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) throw new Error("authentication required");
  return request.user.id;
}

function pathValue(value: string | string[] | undefined) {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized !== "string" || !normalized.trim() || normalized.length > 240) throw new Error("invalid id");
  return normalized.trim();
}
