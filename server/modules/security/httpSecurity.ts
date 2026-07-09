import cors from "cors";
import type express from "express";

export function createCorsMiddleware(allowedOrigins: Set<string>) {
  return cors({
    credentials: true,
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
  });
}

export function createRejectCrossOriginMutation(allowedOrigins: Set<string>) {
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      next();
      return;
    }
    const origin = request.headers.origin;
    if (!origin) {
      next();
      return;
    }
    const forwardedProtocol = request.headers["x-forwarded-proto"];
    const protocol = typeof forwardedProtocol === "string" ? forwardedProtocol.split(",")[0].trim() : request.protocol;
    const sameOrigin = `${protocol}://${request.get("host")}`;
    if (origin !== sameOrigin && !allowedOrigins.has(origin)) {
      response.status(403).json({ message: "请求来源不受信任。" });
      return;
    }
    next();
  };
}

export function createSecurityHeaders(isProduction: boolean) {
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (isProduction) {
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' wss:",
      );
      if (request.secure || request.headers["x-forwarded-proto"] === "https") {
        response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      }
    }
    next();
  };
}

export function isLocalDevelopmentRequest(request: express.Request) {
  const candidates = [
    request.ip,
    request.socket.remoteAddress,
    typeof request.headers["x-forwarded-for"] === "string" ? request.headers["x-forwarded-for"].split(",")[0]?.trim() : "",
  ];
  return candidates.some((value) => isLocalAddress(value));
}

export function createRateLimiter(options: { windowMs: number; max: number; skip?: (request: express.Request) => boolean }) {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const limit = Number.isFinite(options.max) ? Math.max(1, Math.floor(options.max)) : 10;
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (options.skip?.(request)) {
      next();
      return;
    }
    const now = Date.now();
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const current = attempts.get(key);
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + options.windowMs } : current;
    entry.count += 1;
    attempts.set(key, entry);
    if (attempts.size > 10_000) {
      for (const [storedKey, value] of attempts) {
        if (value.resetAt <= now) {
          attempts.delete(storedKey);
        }
      }
    }
    if (entry.count > limit) {
      response.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      response.status(429).json({ message: "尝试次数过多，请稍后再试。" });
      return;
    }
    next();
  };
}

function isLocalAddress(value: string | undefined) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1" || normalized === "localhost";
}
