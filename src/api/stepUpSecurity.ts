import type {
  StepUpEnrollment,
  StepUpFactor,
  StepUpIntent,
  StepUpRecoveryCodes,
  StepUpSecurityClient,
  StepUpStatus,
} from "../features/arbitrageAutomation/model/stepUpTypes";
import { HttpRequestError, requestJson } from "./httpClient";

const apiBase = "/api/auth/security/step-up";

export class StepUpSecurityContractError extends Error {
  constructor(
    readonly status: number,
    readonly category: string | null,
    message: string,
    readonly retryAfterSeconds: number | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "StepUpSecurityContractError";
  }
}

export function createStepUpSecurityClient(): StepUpSecurityClient {
  return {
    status: async (signal) => mapStatus(await stepUpRequest<unknown>(
      `${apiBase}/status`,
      "二次验证状态加载失败。",
      { signal },
    )),
    beginEnrollment: async (body) => mapEnrollment(await stepUpRequest<unknown>(
      `${apiBase}/enrollment/begin`,
      "二次验证设置无法开始。",
      { method: "POST", body },
    )),
    confirmEnrollment: async (body) => mapRecoveryCodes(await stepUpRequest<unknown>(
      `${apiBase}/enrollment/confirm`,
      "动态验证码确认失败。",
      { method: "POST", body },
    )),
    authorize: async (body) => mapAuthorization(await stepUpRequest<unknown>(
      `${apiBase}/authorize`,
      "敏感操作身份验证失败。",
      { method: "POST", body },
    )),
    regenerateRecoveryCodes: async (body) => mapRecoveryCodes(await stepUpRequest<unknown>(
      `${apiBase}/recovery-codes/regenerate`,
      "恢复码重新生成失败。",
      { method: "POST", body },
    )),
    disable: async (body) => mapOk(await stepUpRequest<unknown>(
      `${apiBase}/disable`,
      "二次验证停用失败。",
      { method: "POST", body },
    )),
  };
}

export const stepUpSecurityClient = createStepUpSecurityClient();

export async function canonicalRequestDigest(value: unknown) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(digest));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON only accepts finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON does not accept this value.");
}

export async function createStepUpIntent(input: Omit<StepUpIntent, "requestDigest"> & {
  requestBody: unknown;
}): Promise<StepUpIntent> {
  const { requestBody, ...intent } = input;
  return {
    ...intent,
    requestDigest: await canonicalRequestDigest(requestBody),
  };
}

export function presentStepUpError(error: unknown) {
  if (!(error instanceof StepUpSecurityContractError)) {
    return error instanceof Error ? error.message : "二次身份验证服务暂不可用。";
  }
  const messages: Record<string, string> = {
    current_password_invalid: "当前密码或二次验证信息无效。",
    step_up_not_enrolled: "请先设置身份验证器，再执行该敏感操作。",
    step_up_required: "该操作需要新的二次身份验证。",
    step_up_invalid: "验证码或恢复码无效，请核对后重试。",
    step_up_expired: "本次设置或授权已过期，请重新开始。",
    step_up_replayed: "该验证码或授权已使用，请等待新的验证码。",
    step_up_scope_mismatch: "操作内容已变化，请关闭后重新确认。",
    step_up_rate_limited: error.retryAfterSeconds
      ? `尝试过于频繁，请在 ${error.retryAfterSeconds} 秒后重试。`
      : "尝试过于频繁，请稍后重试。",
    step_up_recovery_required: "此操作需要当前动态验证码或一个未使用的恢复码。",
    step_up_key_unavailable: "二次验证密钥服务暂不可用，请勿继续敏感操作。",
  };
  const message = error.category?.startsWith("step_up_storage_")
    ? "二次验证安全存储暂不可用，请勿继续敏感操作。"
    : (error.category && messages[error.category]) || error.message;
  return error.requestId ? `${message} 请求标识：${error.requestId}` : message;
}

export function isStepUpAuthFailure(error: unknown) {
  return error instanceof StepUpSecurityContractError && (error.status === 401 || error.status === 403);
}

export function isStepUpUnavailable(error: unknown) {
  return Boolean(
    error instanceof StepUpSecurityContractError
    && (error.category === "step_up_key_unavailable" || error.category?.startsWith("step_up_storage_")),
  );
}

async function stepUpRequest<T>(
  path: string,
  fallback: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
) {
  const requestId = crypto.randomUUID();
  try {
    return await requestJson<T>(path, fallback, {
      clientRequestId: requestId,
      userAuthFailure: ({ status, category }) => (
        status === 401
        || (status === 403 && !category?.startsWith("step_up_"))
      ),
      init: {
        method: options.method ?? "GET",
        signal: options.signal,
        headers: {
          "X-Client-Request-Id": requestId,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      },
    });
  } catch (error) {
    if (error instanceof HttpRequestError) {
      const category = error.category
        ?? `http_${error.status}_${error.responseFormat === "json" ? "uncategorized" : "non_json"}`;
      throw new StepUpSecurityContractError(
        error.status,
        category,
        safeStepUpMessage(category, error.message),
        retrySeconds(error.retryAfter),
        error.requestId ?? requestId,
      );
    }
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new StepUpSecurityContractError(
      0,
      aborted ? "request_aborted" : "network_request_failed",
      aborted ? "二次身份验证请求已中止。" : "二次身份验证服务暂时无法连接。",
      null,
      requestId,
    );
  }
}

function safeStepUpMessage(category: string | null, message: string) {
  if (
    category === "authentication_required"
    || category === "current_password_invalid"
    || category?.startsWith("step_up_")
  ) return message;
  return "二次身份验证请求失败。";
}

function retrySeconds(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function mapStatus(value: unknown): StepUpStatus {
  const body = responseRecord(value);
  if (
    typeof body.enrolled !== "boolean"
    || typeof body.pendingEnrollment !== "boolean"
    || (body.method !== null && body.method !== "totp")
    || !isNonNegativeInteger(body.recoveryCodesRemaining)
    || (body.enabledAt !== null && !isPositiveNumber(body.enabledAt))
  ) throw invalidResponse();
  return {
    enrolled: body.enrolled,
    pendingEnrollment: body.pendingEnrollment,
    method: body.method,
    recoveryCodesRemaining: body.recoveryCodesRemaining,
    enabledAt: body.enabledAt,
  };
}

function mapEnrollment(value: unknown): StepUpEnrollment {
  const body = responseRecord(value);
  if (
    !isText(body.enrollmentId, 100)
    || !isText(body.otpauthUri, 2_000)
    || !body.otpauthUri.startsWith("otpauth://")
    || !isPositiveNumber(body.expiresAt)
  ) throw invalidResponse();
  return {
    enrollmentId: body.enrollmentId,
    otpauthUri: body.otpauthUri,
    expiresAt: body.expiresAt,
  };
}

function mapRecoveryCodes(value: unknown): StepUpRecoveryCodes {
  const body = responseRecord(value);
  if (
    body.ok !== true
    || !Array.isArray(body.recoveryCodes)
    || body.recoveryCodes.length !== 8
    || !body.recoveryCodes.every((code) => isText(code, 100))
  ) throw invalidResponse();
  return { ok: true, recoveryCodes: [...body.recoveryCodes] };
}

function mapAuthorization(value: unknown) {
  const body = responseRecord(value);
  if (!isText(body.authorizationToken, 200) || !isPositiveNumber(body.expiresAt)) {
    throw invalidResponse();
  }
  return {
    authorizationToken: body.authorizationToken,
    expiresAt: body.expiresAt,
  };
}

function mapOk(value: unknown): { ok: true } {
  if (responseRecord(value).ok !== true) throw invalidResponse();
  return { ok: true };
}

function responseRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

function invalidResponse() {
  return new StepUpSecurityContractError(
    503,
    "step_up_invalid_response",
    "二次身份验证服务返回了无法识别的响应。",
  );
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isStepUpFactor(value: StepUpFactor): value is StepUpFactor {
  return (value.method === "totp" || value.method === "recovery_code") && Boolean(value.code.trim());
}
