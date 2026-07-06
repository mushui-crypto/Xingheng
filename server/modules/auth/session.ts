import type express from "express";

export const userCookieName = "xh_user_session";
export const adminCookieName = "xh_admin_session";

export function getUserBearerToken(request: express.Request) {
  return getRequestToken(request, userCookieName);
}

export function getAdminBearerToken(request: express.Request) {
  return getRequestToken(request, adminCookieName);
}

export function setSessionCookie(
  response: express.Response,
  name: string,
  token: string,
  ttlMs: number,
  isProduction: boolean,
) {
  response.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}${isProduction ? "; Secure" : ""}`,
  );
}

export function clearSessionCookie(response: express.Response, name: string, isProduction: boolean) {
  response.setHeader(
    "Set-Cookie",
    `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isProduction ? "; Secure" : ""}`,
  );
}

export function getUserSessionTtlMs() {
  return boundedHours(process.env.USER_SESSION_TTL_HOURS, 24, 24 * 30) * 60 * 60 * 1000;
}

export function getAdminSessionTtlMs() {
  return boundedHours(process.env.ADMIN_SESSION_TTL_HOURS, 8, 24) * 60 * 60 * 1000;
}

function getRequestToken(request: express.Request, cookieName: string) {
  const authorization = request.headers.authorization;
  if (authorization) {
    const [scheme, token] = authorization.split(" ");
    if (scheme === "Bearer" && token) {
      return token;
    }
  }
  return parseCookies(request.headers.cookie)[cookieName] ?? null;
}

function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function boundedHours(raw: string | undefined, fallback: number, maximum: number) {
  const value = Number(raw ?? fallback);
  return Math.max(1, Math.min(maximum, Number.isFinite(value) ? value : fallback));
}
