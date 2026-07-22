import { handleUserAuthFailure } from "./session";

type JsonRequestOptions = {
  acceptErrorResponse?: boolean;
  init?: RequestInit;
  userAuthFailure?: boolean;
  networkErrorMessage?: string;
};

export class HttpRequestError extends Error {
  status: number;
  retryAfter: string | null;

  constructor(message: string, response: Response) {
    super(message);
    this.name = "HttpRequestError";
    this.status = response.status;
    this.retryAfter = response.headers.get("Retry-After");
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

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (options.userAuthFailure && (response.status === 401 || response.status === 403)) {
      handleUserAuthFailure(payload?.message ?? "账号已禁用或登录已失效，请重新登录。");
    }
    if (options.acceptErrorResponse) return payload as T;
    throw new HttpRequestError(payload?.message ?? fallbackMessage, response);
  }

  return payload as T;
}
