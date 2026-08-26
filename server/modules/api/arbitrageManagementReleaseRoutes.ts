import type express from "express";
import {
  ArbitrageManagementReleaseError,
  type ArbitrageManagementReleaseService,
} from "../arbitrage-execution/ArbitrageManagementReleaseService";

export function registerArbitrageManagementReleaseRoutes(
  app: express.Express,
  service: Pick<ArbitrageManagementReleaseService, "release" | "evaluateEligibility">,
) {
  app.get("/api/arbitrage-instances/:arbitrageId/legs/:legId/close-safety", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.evaluateEligibility(
        readUserId(request),
        pathValue(request.params.arbitrageId, "arbitrageId"),
        pathValue(request.params.legId, "legId"),
      ));
    } catch (error) {
      sendReadError(response, error);
    }
  });

  app.post("/api/arbitrage-execution/legs/release-management", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.release(userId(request), request.body));
    } catch (error) {
      sendError(response, error);
    }
  });
}

function userId(request: express.Request) {
  if (!request.user?.id) {
    throw new ArbitrageManagementReleaseError("invalid_management_release", "用户登录状态无效。");
  }
  return request.user.id;
}

function readUserId(request: express.Request) {
  if (!request.user?.id) {
    throw new ArbitrageManagementReleaseError("authentication_required", "用户登录状态无效。");
  }
  return request.user.id;
}

function pathValue(value: string | string[] | undefined, name: string) {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized !== "string" || !normalized.trim() || normalized.length > 240) {
    throw new ArbitrageManagementReleaseError("invalid_management_release", `${name} 无效。`);
  }
  return normalized.trim();
}

function sendReadError(response: express.Response, error: unknown) {
  if (error instanceof ArbitrageManagementReleaseError) {
    sendError(response, error);
    return;
  }
  response.status(503).json({
    category: "arbitrage_close_safety_unavailable",
    message: "当前退出安全状态暂不可用，请稍后重试。",
  });
}

function sendError(response: express.Response, error: unknown) {
  if (error instanceof ArbitrageManagementReleaseError) {
    const status = error.category === "authentication_required"
      ? 401
      : error.category === "arbitrage_instance_not_found" || error.category === "arbitrage_leg_not_found"
      ? 404
      : error.category === "execution_state_unknown" || error.category === "position_verification_unavailable"
        || error.category === "idempotency_conflict"
        ? 409
        : 400;
    response.status(status).json({ category: error.category, message: error.message });
    return;
  }
  response.status(502).json({
    category: "management_release_unavailable",
    message: "管理责任释放暂不可用，请稍后重试。",
  });
}
