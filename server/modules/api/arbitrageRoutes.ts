import type express from "express";
import {
  ArbitrageRefreshCooldownError,
  type ArbitrageDashboardService,
} from "../arbitrage/ArbitrageDashboardService";
import type { RwaNeutralAutomationService } from "../arbitrage/automation/RwaNeutralAutomationService";

const supportedHorizons = new Set([90, 365]);

export function registerArbitrageRoutes(
  app: express.Express,
  service: ArbitrageDashboardService,
  neutralAutomation?: RwaNeutralAutomationService,
) {
  app.get("/api/arbitrage/dashboard", async (request, response) => {
    try {
      const requested = Number(request.query.horizonDays ?? 90);
      const horizonDays = supportedHorizons.has(requested) ? requested as 90 | 365 : 90;
      const forceRefresh = request.query.refresh === "1";
      response.json(await service.getSnapshot(horizonDays, forceRefresh));
    } catch (error) {
      if (error instanceof ArbitrageRefreshCooldownError) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
        response.status(429).json({ message: `刷新过于频繁，请在 ${error.retryAfterSeconds} 秒后重试。` });
        return;
      }
      response.status(502).json({ message: error instanceof Error ? error.message : "套利公开行情加载失败。" });
    }
  });

  if (neutralAutomation) {
    app.get("/api/admin/arbitrage/neutral-automation", async (_request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        response.json(await neutralAutomation.getStatus());
      } catch {
        response.status(503).json({ message: "RWA 自动套利 Shadow 状态暂不可用。" });
      }
    });
  }
}
