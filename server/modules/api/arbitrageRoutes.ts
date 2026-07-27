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
      if (result.retryAfterSeconds !== undefined) {
        response.setHeader("Retry-After", String(result.retryAfterSeconds));
      }
      response.status(result.statusCode).json(result.body);
    }
  };

  app.get("/api/arbitrage/automation/venues", route((request) => control.listVenues(authenticatedUserId(request), sourceIp(request))));
  app.get("/api/arbitrage/automation/venues/:venue/credentials", route(async (request) => ({
    credential: (await control.getVenueStatus(authenticatedUserId(request), singleParam(request.params.venue), sourceIp(request))).credential,
  })));
  app.put("/api/arbitrage/automation/venues/:venue/credentials", route((request) => control.putCredentials(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), request.body, sourceIp(request))));
  app.delete("/api/arbitrage/automation/venues/:venue/credentials", route((request) => control.deleteCredentials(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), request.body, sourceIp(request))));
  app.get("/api/arbitrage/automation/venues/:venue/assets/:assetId/authorization", route((request) => control.getAccountAssetAuthorization(authenticatedUserId(request), singleParam(request.params.venue), singleParam(request.params.assetId), sourceIp(request))));
  app.post("/api/arbitrage/automation/venues/:venue/assets/:assetId/authorization/preview", route((request) => control.previewAccountAssetAuthorization(authenticatedUserId(request), singleParam(request.params.venue), singleParam(request.params.assetId), request.body, sourceIp(request), authenticatedSessionDomain(request))));
  app.put("/api/arbitrage/automation/venues/:venue/assets/:assetId/authorization", route((request) => control.createAccountAssetAuthorization(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), singleParam(request.params.assetId), request.body, sourceIp(request))));
  app.delete("/api/arbitrage/automation/venues/:venue/assets/:assetId/authorization", route((request) => control.revokeAccountAssetAuthorization(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), singleParam(request.params.assetId), request.body, sourceIp(request))));
  app.post("/api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/preview", route((request) => control.previewAssetTakeover(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), singleParam(request.params.assetId), request.body, sourceIp(request))));
  app.post("/api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/start", route((request) => control.startAssetTakeover(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), singleParam(request.params.assetId), request.body, sourceIp(request))));
  app.get("/api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/current", route((request) => control.getCurrentAssetTakeover(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), singleParam(request.params.assetId), sourceIp(request))));
  app.post("/api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/reconfirm", route((request) => control.reconfirmAssetTakeover(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), singleParam(request.params.assetId), singleParam(request.params.takeoverId), request.body, sourceIp(request))));
  app.post("/api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/abort", route((request) => control.abortAssetTakeover(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), singleParam(request.params.assetId), singleParam(request.params.takeoverId), request.body, sourceIp(request))));
  app.get("/api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/status", route((request) => control.getAssetTakeoverStatus(authenticatedUserId(request), singleParam(request.params.venue), singleParam(request.params.assetId), singleParam(request.params.takeoverId), sourceIp(request))));
  app.post("/api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/exit/preview", route((request) => control.previewAssetTakeoverExit(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), singleParam(request.params.assetId), singleParam(request.params.takeoverId), request.body, sourceIp(request))));
  app.post("/api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/exit/confirm", route((request) => control.confirmAssetTakeoverExit(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), singleParam(request.params.assetId), singleParam(request.params.takeoverId), request.body, sourceIp(request))));
  app.get("/api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/exit/status", route((request) => control.getAssetTakeoverExitStatus(authenticatedUserId(request), singleParam(request.params.venue), singleParam(request.params.assetId), singleParam(request.params.takeoverId), sourceIp(request))));
  app.get("/api/arbitrage/automation/venues/:venue/config", route((request) => control.getConfig(authenticatedUserId(request), singleParam(request.params.venue), sourceIp(request))));
  app.put("/api/arbitrage/automation/venues/:venue/config", route((request) => control.updateConfig(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), request.body, sourceIp(request))));
  app.post("/api/arbitrage/automation/venues/:venue/kill-switch", route((request) => control.setKillSwitch(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), request.body, sourceIp(request))));
  app.get("/api/arbitrage/automation/venues/:venue/account", route((request) => control.getPrivateAccount(authenticatedUserId(request), singleParam(request.params.venue), sourceIp(request))));
  app.get("/api/arbitrage/automation/opportunities", route((request) => control.listOpportunities(authenticatedUserId(request), sourceIp(request))));
  app.post("/api/arbitrage/automation/preflight", route((request) => control.preflight(authenticatedUserId(request), request.body, sourceIp(request))));
  app.post("/api/arbitrage/automation/execute", route((request) => control.execute(authenticatedUserId(request), authenticatedSessionDomain(request), request.body, sourceIp(request))));
  app.get("/api/arbitrage/automation/connectivity-smoke/policy", route((request) => control.getConnectivitySmokePolicy(authenticatedUserId(request), request.query, sourceIp(request))));
  app.post("/api/arbitrage/automation/connectivity-smoke/preflight", route((request) => control.preflightConnectivitySmoke(authenticatedUserId(request), request.body, sourceIp(request))));
  app.post("/api/arbitrage/automation/connectivity-smoke/execute", route((request) => control.executeConnectivitySmoke(authenticatedUserId(request), authenticatedSessionDomain(request), request.body, sourceIp(request))));
  app.get("/api/arbitrage/automation/connectivity-smoke/status", route((request) => control.getConnectivitySmokeStatus(authenticatedUserId(request), request.query, sourceIp(request))));
  app.get("/api/arbitrage/automation/connectivity-smoke/:smokeId/receipt", route((request) => control.getConnectivitySmokeReceipt(authenticatedUserId(request), singleParam(request.params.smokeId), request.query, sourceIp(request))));
  app.get("/api/arbitrage/automation/positions", route((request) => control.getPositions(authenticatedUserId(request), sourceIp(request))));
  app.post("/api/arbitrage/automation/positions/:positionId/close", route((request) => control.closePosition(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.positionId), request.body, sourceIp(request))));
  app.post("/api/arbitrage/automation/venues/:venue/close-all", route((request) => control.closeAll(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), request.body, sourceIp(request))));
  app.get("/api/arbitrage/automation/venues/:venue/reconciliation", route((request) => control.getReconciliation(authenticatedUserId(request), singleParam(request.params.venue), request.query, sourceIp(request))));
  app.post("/api/arbitrage/automation/venues/:venue/reconciliation/finalize", route((request) => control.finalizeReconciliation(authenticatedUserId(request), authenticatedSessionDomain(request), singleParam(request.params.venue), request.body, sourceIp(request))));
  app.get("/api/arbitrage/automation/pnl", route((request) => control.getPnl(authenticatedUserId(request), sourceIp(request))));
  app.get("/api/arbitrage/automation/audit", route((request) => control.getAudit(authenticatedUserId(request), sourceIp(request))));
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

function sourceIp(request: express.Request) {
  return request.ip || request.socket?.remoteAddress || "unknown";
}
