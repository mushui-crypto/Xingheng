import { handleUserAuthFailure } from "./session";

type JsonRequestOptions = {
  acceptErrorResponse?: boolean;
  clientRequestId?: string;
  mapErrorDetails?: (payload: unknown) => unknown;
  init?: RequestInit;
  userAuthFailure?: boolean | ((error: {
    status: number;
    category: string | null;
  }) => boolean);
  networkErrorMessage?: string;
};

export class HttpRequestError extends Error {
  status: number;
  retryAfter: string | null;
  category: string | null;
  details: unknown;
  requestId: string | null;
  responseFormat: "json" | "non_json";

  constructor(
    message: string,
    response: Response,
    category: string | null = null,
    details: unknown = null,
    requestId: string | null = null,
    responseFormat: "json" | "non_json" = "json",
  ) {
    super(message);
    this.name = "HttpRequestError";
    this.status = response.status;
    this.retryAfter = response.headers.get("Retry-After");
    this.category = category;
    this.details = details;
    this.requestId = requestId;
    this.responseFormat = responseFormat;
  }
}

export function userHeaders(_userId?: string | null): Record<string, string> {
  return {};
}

export function adminHeaders(): Record<string, string> {
  return {};
}

export async function requestJson<T>(input: RequestInfo | URL, fallbackMessage: string, options: JsonRequestOptions = {}) {
  let response: Response;

  try {
    response = await fetch(input, { credentials: "include", ...options.init });
  } catch (error) {
    if (options.networkErrorMessage) {
      throw new Error(options.networkErrorMessage);
    }
    throw error;
  }

  let responseFormat: "json" | "non_json" = "json";
  const payload = await response.json().catch(() => {
    responseFormat = "non_json";
    return null;
  });
  if (!response.ok) {
    const category = typeof payload?.category === "string" ? payload.category : null;
    const shouldHandleAuthFailure = typeof options.userAuthFailure === "function"
      ? options.userAuthFailure({ status: response.status, category })
      : Boolean(options.userAuthFailure && (response.status === 401 || response.status === 403));
    if (shouldHandleAuthFailure) {
      handleUserAuthFailure(payload?.message ?? "账号已禁用或登录已失效，请重新登录。");
    }
    if (options.acceptErrorResponse) return payload as T;
    throw new HttpRequestError(
      payload?.message ?? fallbackMessage,
      response,
      category,
      options.mapErrorDetails?.(payload) ?? null,
      response.headers.get("x-request-id")
        ?? response.headers.get("x-correlation-id")
        ?? options.clientRequestId
        ?? null,
      responseFormat,
    );
  }

  return payload as T;
}
