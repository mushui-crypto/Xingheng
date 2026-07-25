import type express from "express";
import {
  RwaAutomationControlError,
  type RwaAutomationControlService,
} from "../arbitrage/automation/RwaAutomationControlService";
import { RwaAutomationGovernanceError } from "../arbitrage/automation/RwaAutomationGovernance";
import { RwaAccountAssetAuthorizationError } from "../arbitrage/automation/RwaAccountAssetAuthorization";
import {
  StepUpSecurityError,
  type FactorInput,
  type StepUpSecurityService,
} from "./StepUpSecurityService";
import { StepUpSecurityStoreError } from "./StepUpSecurityStore";

export function registerStepUpSecurityRoutes(
  app: express.Express,
  security: StepUpSecurityService,
  automation: RwaAutomationControlService,
) {
  const route = (handler: (request: express.Request) => Promise<unknown>) => async (request: express.Request, response: express.Response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await handler(request));
    } catch (error) {
      if (error instanceof StepUpSecurityError) {
        if (error.retryAfterSeconds) response.setHeader("Retry-After", String(error.retryAfterSeconds));
        response.status(error.statusCode).json({ category: error.category, message: error.message });
        return;
      }
      if (error instanceof StepUpSecurityStoreError) {
        response.status(503).json({ category: error.category, message: error.message });
        return;
      }
      if (error instanceof RwaAutomationControlError) {
        response.status(error.statusCode).json({ category: error.category, message: error.message });
        return;
      }
      if (error instanceof RwaAccountAssetAuthorizationError) {
        response.status(error.statusCode).json({ category: error.category, message: error.message });
        return;
      }
      if (error instanceof RwaAutomationGovernanceError) {
        if (error.retryAfterSeconds !== undefined) response.setHeader("Retry-After", String(error.retryAfterSeconds));
        response.status(error.statusCode).json({ category: error.category, message: error.message });
        return;
      }
      response.status(500).json({ category: "step_up_internal_error", message: "二次身份验证服务暂不可用。" });
    }
  };

  app.get("/api/auth/security/step-up/status", route((request) =>
    security.status(userId(request))));

  app.post("/api/auth/security/step-up/enrollment/begin", route((request) => {
    const body = strictRecord(request.body, ["currentPassword", "currentFactor"]);
    return security.beginEnrollment(userId(request), sessionDomain(request), {
      currentPassword: text(body.currentPassword, "currentPassword", 128),
      currentFactor: body.currentFactor === undefined ? undefined : factor(body.currentFactor),
    });
  }));

  app.post("/api/auth/security/step-up/enrollment/confirm", route((request) => {
    const body = strictRecord(request.body, ["enrollmentId", "code"]);
    return security.confirmEnrollment(userId(request), sessionDomain(request), {
      enrollmentId: text(body.enrollmentId, "enrollmentId", 100),
      code: text(body.code, "code", 20),
    });
  }));

  app.post("/api/auth/security/step-up/authorize", route(async (request) => {
    const body = strictRecord(request.body, ["code", "intent"]);
    const intent = await automation.resolveStepUpIntent(
      userId(request),
      body.intent,
      sourceIp(request),
      sessionDomain(request),
    );
    return security.authorize(
      userId(request),
      sessionDomain(request),
      text(body.code, "code", 20),
      intent,
    );
  }));

  app.post("/api/auth/security/step-up/recovery-codes/regenerate", route((request) => {
    const body = strictRecord(request.body, ["currentPassword", "factor"]);
    return security.regenerateRecoveryCodes(userId(request), sessionDomain(request), {
      currentPassword: text(body.currentPassword, "currentPassword", 128),
      factor: factor(body.factor),
    });
  }));

  app.post("/api/auth/security/step-up/disable", route((request) => {
    const body = strictRecord(request.body, ["currentPassword", "factor"]);
    return security.disable(userId(request), sessionDomain(request), {
      currentPassword: text(body.currentPassword, "currentPassword", 128),
      factor: factor(body.factor),
    });
  }));
}

function userId(request: express.Request) {
  if (!request.user?.id) throw new StepUpSecurityError(401, "authentication_required", "用户未登录或登录已失效。");
  return request.user.id;
}

function sessionDomain(request: express.Request) {
  if (!request.userSessionDomain) throw new StepUpSecurityError(401, "authentication_required", "用户登录会话已失效。");
  return request.userSessionDomain;
}

function sourceIp(request: express.Request) {
  return request.ip || request.socket?.remoteAddress || "unknown";
}

function factor(value: unknown): FactorInput {
  const body = strictRecord(value, ["method", "code"]);
  const method = body.method;
  if (method !== "totp" && method !== "recovery_code") throw invalid("method 格式无效。");
  return { method, code: text(body.code, "code", 64) };
}

function strictRecord(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("请求格式无效。");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw invalid("请求包含不支持的字段。");
  return body;
}

function text(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw invalid(`${field} 格式无效。`);
  return value.trim();
}

function invalid(message: string) {
  return new StepUpSecurityError(400, "step_up_invalid", message);
}
