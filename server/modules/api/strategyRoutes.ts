import type express from "express";
import type { IctStrategyRuntime } from "../strategy/runtime/IctStrategyRuntime";
import { readForwardReport } from "../strategy/runtime/ForwardReportService";
import type { ForwardPaperWorker } from "../strategy/runtime/ForwardPaperWorker";
import { readHistoryReport } from "../strategy/runtime/HistoryReportService";

export function registerStrategyRoutes(
  app: express.Express,
  runtime: IctStrategyRuntime,
  options: { forwardPaperWorker?: ForwardPaperWorker } = {},
) {
  app.get("/api/strategy/ict/status", (_request, response) => {
    response.json(runtime.getStatus());
  });

  app.get("/api/strategy/ict/forward", async (request, response) => {
    if (!request.user) {
      response.status(401).json({ message: "用户未登录或登录已失效。" });
      return;
    }
    const result = await readForwardReport();
    response.status(result.ok ? 200 : result.statusCode).json({
      ...result.report,
      worker: options.forwardPaperWorker?.getStatus(),
    });
  });

  app.get("/api/strategy/ict/history", async (request, response) => {
    if (!request.user) {
      response.status(401).json({ message: "用户未登录或登录已失效。" });
      return;
    }
    const result = await readHistoryReport(request.query);
    response.status(result.ok ? 200 : result.statusCode).json(result.report);
  });

  app.get("/api/admin/strategy/health", async (_request, response) => {
    const forward = await readForwardReport();
    const worker = await options.forwardPaperWorker?.getHealth(forward.ok);
    response.json({
      forwardReport: {
        readable: forward.ok,
        status: forward.report.status,
        through: forward.report.through,
        warnings: forward.report.warnings,
      },
      worker,
    });
  });
}
