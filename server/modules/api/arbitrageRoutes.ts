import type express from "express";
import {
  ArbitrageRefreshCooldownError,
  type ArbitrageDashboardService,
} from "../arbitrage/ArbitrageDashboardService";
import type { RwaNeutralAutomationService } from "../arbitrage/automation/RwaNeutralAutomationService";
import {
  automationErrorResponse,
  RwaAutomationControlError,
  type RwaAutomationControlService,
} from "../arbitrage/automation/RwaAutomationControlService";

const supportedHorizons = new Set([90, 365]);

export function registerArbitrageRoutes(
  app: express.Express,
  service: ArbitrageDashboardService,
  neutralAutomation?: RwaNeutralAutomationService,
  automationControl?: RwaAutomationControlService,
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

  if (automationControl) registerAutomationControlRoutes(app, automationControl);
}

function registerAutomationControlRoutes(app: express.Express, control: RwaAutomationControlService) {
  const route = (handler: (request: express.Request) => Promise<unknown> | unknown) => async (request: express.Request, response: express.Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await handler(request));
    } catch (error) {
      const result = automationErrorResponse(error);
      response.status(result.statusCode).json(result.body);
    }
  };

  app.get("/api/arbitrage/automation/venues", route((request) => control.listVenues(authenticatedUserId(request))));
  app.get("/api/arbitrage/automation/venues/:venue/credentials", route(async (request) => ({
    credential: (await control.getVenueStatus(authenticatedUserId(request), singleParam(request.params.venue))).credential,
  })));
  app.put("/api/arbitrage/automation/venues/:venue/credentials", route((request) => control.putCredentials(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), request.body)));
  app.delete("/api/arbitrage/automation/venues/:venue/credentials", route((request) => control.deleteCredentials(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), request.body)));
  app.get("/api/arbitrage/automation/venues/:venue/config", route((request) => control.getConfig(authenticatedUserId(request), singleParam(request.params.venue))));
  app.put("/api/arbitrage/automation/venues/:venue/config", route((request) => control.updateConfig(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), request.body)));
  app.post("/api/arbitrage/automation/venues/:venue/kill-switch", route((request) => control.setKillSwitch(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), request.body)));
  app.get("/api/arbitrage/automation/venues/:venue/account", route((request) => control.getPrivateAccount(authenticatedUserId(request), singleParam(request.params.venue))));
  app.get("/api/arbitrage/automation/opportunities", route((request) => control.listOpportunities(authenticatedUserId(request))));
  app.post("/api/arbitrage/automation/preflight", route((request) => control.preflight(authenticatedUserId(request), request.body)));
  app.post("/api/arbitrage/automation/execute", route((request) => control.execute(authenticatedUserId(request), authenticatedSessionDomain(request), request.body)));
  app.get("/api/arbitrage/automation/positions", route((request) => control.getPositions(authenticatedUserId(request))));
  app.post("/api/arbitrage/automation/positions/:positionId/close", route((request) => control.closePosition(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.positionId), request.body)));
  app.post("/api/arbitrage/automation/venues/:venue/close-all", route((request) => control.closeAll(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), request.body)));
  app.get("/api/arbitrage/automation/pnl", route((request) => control.getPnl(authenticatedUserId(request))));
  app.get("/api/arbitrage/automation/audit", route((request) => control.getAudit(authenticatedUserId(request))));
}

function authenticatedUserId(request: express.Request) {
  if (!request.user?.id) {
    throw new RwaAutomationControlError(401, "authentication_required", "用户未登录或登录已失效。");
  }
  return request.user.id;
}

function authenticatedSessionDomain(request: express.Request) {
  if (!request.userSessionDomain) {
    throw new RwaAutomationControlError(401, "authentication_required", "用户登录会话已失效。");
  }
  return request.userSessionDomain;
}

function singleParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] ?? "" : value;
}
