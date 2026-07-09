import type express from "express";
import type { UserService } from "../../auth/UserService";
import { createSessionToken, hashSessionToken, secureTextEqual } from "../../auth/security";
import type { RuntimeConfig } from "../../config/runtimeConfig";
import type { TradingStore } from "../../storage/TradingStore";
import type { User } from "../../types";
import type { WalletService } from "../../wallet/WalletService";
import { sendBadRequest } from "../api/httpResponses";
import { createRateLimiter } from "../security/httpSecurity";
import {
  adminCookieName,
  clearSessionCookie,
  getAdminBearerToken,
  getAdminSessionTtlMs,
  getUserBearerToken,
  getUserSessionTtlMs,
  setSessionCookie,
  userCookieName,
} from "./session";

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

type AuthRouteDependencies = {
  app: express.Express;
  users: UserService;
  wallet: WalletService;
  tradingStore: TradingStore;
  config: RuntimeConfig;
};

export function registerAuthRoutes({ app, users, wallet, tradingStore, config }: AuthRouteDependencies) {
  const authRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
  });

  app.use("/api/auth", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api/admin", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  app.post("/api/auth/register", authRateLimit, (request, response) => {
    try {
      response.status(201).json(users.register(request.body ?? {}, (user) => wallet.ensureDepositAddressForRegisteredUser(user.id)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/auth/login", authRateLimit, (request, response) => {
    try {
      const result = users.login(request.body?.email, request.body?.password);
      setSessionCookie(response, userCookieName, result.token, getUserSessionTtlMs(), config.isProduction);
      response.setHeader("Cache-Control", "no-store");
      response.json({ user: result.user });
    } catch (error) {
      response.status(401).json({ message: error instanceof Error ? error.message : "登录失败。" });
    }
  });

  app.post("/api/auth/logout", (request, response) => {
    users.logout(getUserBearerToken(request));
    clearSessionCookie(response, userCookieName, config.isProduction);
    response.json({ ok: true });
  });

  app.get("/api/auth/me", (request, response) => {
    const user = users.getCurrentUser(getUserBearerToken(request));
    if (!user) {
      response.status(401).json({ message: "用户未登录或登录已失效。" });
      return;
    }
    response.json(user);
  });

  app.post("/api/admin/login", authRateLimit, (request, response) => {
    if (!config.adminAuthConfigured) {
      response.status(503).json({ message: "管理员登录尚未配置，请设置至少 12 位的 ADMIN_PASSWORD。" });
      return;
    }
    const email = String(request.body?.email ?? "").trim().toLowerCase();
    const password = String(request.body?.password ?? "");
    if (!secureTextEqual(email, config.adminEmail) || !secureTextEqual(password, config.adminPassword)) {
      response.status(401).json({ message: "管理员账号或密码不正确。" });
      return;
    }

    const token = createSessionToken();
    const now = Date.now();
    const ttlMs = getAdminSessionTtlMs();
    tradingStore.createAuthSession({
      tokenHash: hashSessionToken(token),
      subjectId: config.adminEmail,
      role: "admin",
      expiresAt: now + ttlMs,
      createdAt: now,
    });
    setSessionCookie(response, adminCookieName, token, ttlMs, config.isProduction);
    response.setHeader("Cache-Control", "no-store");
    response.json({ ok: true });
  });

  app.post("/api/admin/logout", (request, response) => {
    const token = getAdminBearerToken(request);
    if (token) {
      tradingStore.deleteAuthSession(hashSessionToken(token), "admin");
    }
    clearSessionCookie(response, adminCookieName, config.isProduction);
    response.json({ ok: true });
  });

  app.use("/api/admin", (request, response, next) => {
    if (request.path === "/login") {
      next();
      return;
    }
    const token = getAdminBearerToken(request);
    const session = token ? tradingStore.findAuthSession(hashSessionToken(token), "admin") : null;
    if (!config.adminAuthConfigured || !session || session.subjectId !== config.adminEmail) {
      response.status(401).json({ message: "管理员未登录或登录已失效。" });
      return;
    }
    next();
  });

  app.get("/api/admin/me", (_request, response) => {
    response.json({ email: config.adminEmail, role: "admin" });
  });
}

export function registerUserAuthMiddleware(app: express.Express, users: UserService) {
  app.use(["/api/trading", "/api/wallet"], (request, response, next) => {
    const user = users.authenticate(getUserBearerToken(request));
    if (!user) {
      response.status(401).json({ message: "用户未登录或登录已失效。" });
      return;
    }
    if (user.status === "disabled") {
      response.status(403).json({ message: "账号已禁用，请联系管理员。" });
      return;
    }
    request.user = user;
    next();
  });
}
