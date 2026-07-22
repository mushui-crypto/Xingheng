import type express from "express";
import type { IctStrategyRuntime } from "../strategy/runtime/IctStrategyRuntime";
import { readForwardReport } from "../strategy/runtime/ForwardReportService";
import type { ForwardPaperWorker } from "../strategy/runtime/ForwardPaperWorker";
import { readHistoryReport } from "../strategy/runtime/HistoryReportService";
import { readStrategyCandles } from "../strategy/runtime/StrategyCandlesService";
import type { MartingaleGridPaperWorker } from "../strategy/runtime/MartingaleGridPaperWorker";
import { readMartingaleGridReport } from "../strategy/runtime/MartingaleGridReportService";
import type { FixedGridPaperWorker } from "../strategy/runtime/FixedGridPaperWorker";
import { readFixedGridReport } from "../strategy/runtime/FixedGridReportService";

export function registerStrategyRoutes(
  app: express.Express,
  runtime: IctStrategyRuntime,
  options: {
    forwardPaperWorker?: ForwardPaperWorker;
    martingaleGridPaperWorker?: MartingaleGridPaperWorker;
    fixedGridPaperWorker?: FixedGridPaperWorker;
  } = {},
) {
  app.get("/api/strategy/ict/status", (_request, response) => {
    response.json(runtime.getStatus());
  });

  app.get("/api/strategy/ict/forward", async (_request, response) => {
    const result = await readForwardReport();
    response.status(result.ok ? 200 : result.statusCode).json({
      ...result.report,
      worker: options.forwardPaperWorker?.getStatus(),
    });
  });

  app.get("/api/strategy/ict/history", async (request, response) => {
    const result = await readHistoryReport(request.query);
    response.status(result.ok ? 200 : result.statusCode).json(result.report);
  });

  app.get("/api/strategy/ict/candles", async (request, response) => {
    const result = await readStrategyCandles({ ...request.query, symbol: "BTCUSDT" });
    response.status(result.statusCode).json(result.report);
  });

  app.get("/api/strategy/martingale/candles", async (request, response) => {
    const result = await readStrategyCandles(request.query);
    response.status(result.statusCode).json(result.report);
  });

  app.get("/api/strategy/martingale/forward", async (_request, response) => {
    const result = await readMartingaleGridReport();
    response.status(result.ok ? 200 : result.statusCode).json({
      ...result.report,
      worker: options.martingaleGridPaperWorker?.getStatus(),
    });
  });

  app.get("/api/strategy/martingale/fixed-grid/forward", async (_request, response) => {
    const result = await readFixedGridReport();
    response.status(result.ok ? 200 : result.statusCode).json({
      ...result.report,
      worker: options.fixedGridPaperWorker?.getStatus(),
    });
  });

  app.get("/api/admin/strategy/health", async (_request, response) => {
    const forward = await readForwardReport();
    const worker = await options.forwardPaperWorker?.getHealth(forward.ok);
    const martingaleGrid = await options.martingaleGridPaperWorker?.getHealth();
    const fixedGrid = await options.fixedGridPaperWorker?.getHealth();
    response.json({
      forwardReport: {
        readable: forward.ok,
        status: forward.report.status,
        through: forward.report.through,
        warnings: forward.report.warnings,
      },
      worker,
      martingaleGrid,
      fixedGrid,
    });
  });
}
