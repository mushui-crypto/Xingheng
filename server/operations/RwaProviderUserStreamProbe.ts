import { createHmac, randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { RwaBinanceCredentials } from "../modules/arbitrage/automation/RwaBinanceAutomationTypes";

const defaultTimeoutMs = 10_000;
const defaultObservationMs = 1_000;
const spotEvents = new Set([
  "executionReport", "outboundAccountPosition", "balanceUpdate", "externalLockUpdate",
]);
const futuresEvents = new Set([
  "ORDER_TRADE_UPDATE", "ACCOUNT_UPDATE", "ACCOUNT_CONFIG_UPDATE", "MARGIN_CALL",
]);

export type ProviderUserStreamProbeFailureStage =
  | "connectivity_failed"
  | "auth_handshake_failed"
  | "subscription_failed"
  | "no_stream_data"
  | "heartbeat_timeout";

export type ProviderUserStreamConnectivityFailureDetail =
  | "dns_resolution_failed"
  | "tcp_connection_failed"
  | "tls_handshake_failed"
  | "endpoint_configuration_missing";

export type ProviderUserStreamLifecycleDiagnostic = Readonly<{
  error: Readonly<{ name: string; code: string | null }> | null;
  close: Readonly<{ code: number | null }> | null;
}>;

const dnsFailureCodes = new Set(["EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "ENODATA", "ENOTFOUND"]);
const tcpFailureCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT",
]);
const endpointFailureCodes = new Set(["ERR_INVALID_URL", "ERR_MISSING_ARGS"]);

export async function runRwaProviderUserStreamProbe(
  credentials: RwaBinanceCredentials,
  fetchFn: typeof fetch = fetch,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  now: () => number = Date.now,
  bounds: { timeoutMs?: number; observationMs?: number } = {},
) {
  const timeoutMs = positiveDuration(bounds.timeoutMs, defaultTimeoutMs);
  const observationMs = positiveDuration(bounds.observationMs, defaultObservationMs);
  let spot: WebSocket | null = null;
  let futures: WebSocket | null = null;
  let listenKey = "";
  let sessionClosed = false;
  try {
    const id = randomUUID();
    const timestamp = now();
    const signature = createHmac("sha256", credentials.apiSecret)
      .update(`apiKey=${credentials.apiKey}&timestamp=${timestamp}`)
      .digest("hex");
    spot = createSocket("wss://ws-api.binance.com:443/ws-api/v3");
    const spotObservation = observeSpot(spot, id, observationMs, () => spot!.send(JSON.stringify({
      id,
      method: "userDataStream.subscribe.signature",
      params: { apiKey: credentials.apiKey, timestamp, signature },
    })));

    const created = await boundedFetch(
      fetchFn,
      "https://fapi.binance.com/fapi/v1/listenKey",
      { method: "POST", headers: { "X-MBX-APIKEY": credentials.apiKey } },
      timeoutMs,
      "futures_listen_key_create_failed",
    );
    listenKey = String((await created.json() as any)?.listenKey ?? "");
    if (!listenKey) throw failure("futures_listen_key_missing");
    futures = createSocket(`wss://fstream.binance.com/ws/${encodeURIComponent(listenKey)}`);
    const futuresObservation = observeFutures(futures, observationMs);
    await bounded(Promise.all([spotObservation, futuresObservation]), timeoutMs);

    await boundedFetch(
      fetchFn,
      "https://fapi.binance.com/fapi/v1/listenKey",
      { method: "PUT", headers: { "X-MBX-APIKEY": credentials.apiKey } },
      timeoutMs,
      "futures_listen_key_keepalive_failed",
    );
    await boundedFetch(
      fetchFn,
      "https://fapi.binance.com/fapi/v1/listenKey",
      { method: "DELETE", headers: { "X-MBX-APIKEY": credentials.apiKey } },
      timeoutMs,
      "futures_listen_key_close_failed",
    );
    sessionClosed = true;
    return {
      spotSignedSubscribe: true as const,
      futuresListenKeyCreate: true as const,
      futuresListenKeyKeepalive: true as const,
      futuresListenKeyClose: true as const,
    };
  } finally {
    closeSocket(spot);
    closeSocket(futures);
    if (listenKey && !sessionClosed) {
      await boundedFetch(
        fetchFn,
        "https://fapi.binance.com/fapi/v1/listenKey",
        { method: "DELETE", headers: { "X-MBX-APIKEY": credentials.apiKey } },
        timeoutMs,
        "futures_listen_key_cleanup_failed",
      ).catch(() => undefined);
    }
  }
}

export function providerUserStreamProbeErrorCategory(error: unknown) {
  return error instanceof RwaProviderUserStreamProbeError
    ? error.category
    : "provider_stream_probe_failed";
}

export function providerUserStreamProbeFailureStage(
  error: unknown,
): ProviderUserStreamProbeFailureStage {
  const category = providerUserStreamProbeErrorCategory(error);
  if ([
    "spot_stream_error", "spot_stream_closed", "futures_stream_error", "futures_stream_closed",
  ].includes(category)) return "connectivity_failed";
  if ([
    "spot_subscribe_ack_invalid", "futures_listen_key_create_failed", "futures_listen_key_missing",
  ].includes(category)) return "auth_handshake_failed";
  if ([
    "spot_stream_unknown_payload", "futures_listen_key_expired", "futures_stream_unknown_payload",
    "futures_listen_key_close_failed", "futures_listen_key_cleanup_failed",
  ].includes(category)) return "subscription_failed";
  if (category === "provider_stream_probe_timeout") return "no_stream_data";
  if (category === "futures_listen_key_keepalive_failed") return "heartbeat_timeout";
  return "connectivity_failed";
}

export function providerUserStreamProbeConnectivityFailureDetail(
  error: unknown,
): ProviderUserStreamConnectivityFailureDetail | null {
  if (error instanceof RwaProviderUserStreamProbeError) {
    return error.connectivityFailedDetail;
  }
  return connectivityFailureDetail(error);
}

export function providerUserStreamProbeLifecycleDiagnostic(
  error: unknown,
): ProviderUserStreamLifecycleDiagnostic | null {
  return error instanceof RwaProviderUserStreamProbeError
    ? error.lifecycleDiagnostic
    : null;
}

function observeSpot(socket: WebSocket, id: string, observationMs: number, subscribe: () => void) {
  return new Promise<void>((resolve, reject) => {
    let acknowledged = false;
    let timer: NodeJS.Timeout | null = null;
    const fail = (
      category: string,
      connectivityFailedDetail: ProviderUserStreamConnectivityFailureDetail | null = null,
    ) => {
      if (timer) clearTimeout(timer);
      reject(failure(category, connectivityFailedDetail));
    };
    socket.once("open", subscribe);
    socket.once("error", (error) => fail("spot_stream_error", connectivityFailureDetail(error)));
    socket.once("close", () => fail("spot_stream_closed", "tcp_connection_failed"));
    socket.on("message", (data) => {
      try {
        const value = record(JSON.parse(String(data)));
        if (!acknowledged) {
          if (value.id !== id || value.status !== 200) return fail("spot_subscribe_ack_invalid");
          acknowledged = true;
          timer = setTimeout(resolve, observationMs);
          timer.unref();
          return;
        }
        const event = record(value.event);
        if (!spotEvents.has(String(event.e ?? ""))) fail("spot_stream_unknown_payload");
      } catch { fail("spot_stream_unknown_payload"); }
    });
  });
}

function observeFutures(socket: WebSocket, observationMs: number) {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const fail = (
      category: string,
      connectivityFailedDetail: ProviderUserStreamConnectivityFailureDetail | null = null,
      lifecycleDiagnostic: ProviderUserStreamLifecycleDiagnostic | null = null,
    ) => {
      if (timer) clearTimeout(timer);
      reject(failure(category, connectivityFailedDetail, lifecycleDiagnostic));
    };
    socket.once("open", () => {
      timer = setTimeout(resolve, observationMs);
      timer.unref();
    });
    socket.once("error", (error) => fail(
      "futures_stream_error",
      connectivityFailureDetail(error),
      errorLifecycleDiagnostic(error),
    ));
    socket.once("close", (code) => fail(
      "futures_stream_closed",
      "tcp_connection_failed",
      closeLifecycleDiagnostic(code),
    ));
    socket.on("message", (data) => {
      try {
        const value = record(JSON.parse(String(data)));
        const type = String(value.e ?? "");
        if (type === "listenKeyExpired") return fail("futures_listen_key_expired");
        if (!futuresEvents.has(type)) fail("futures_stream_unknown_payload");
      } catch { fail("futures_stream_unknown_payload"); }
    });
  });
}

async function boundedFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  category: string,
) {
  const controller = new AbortController();
  try {
    const response = await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(failure(category));
      }, timeoutMs);
      timer.unref();
      fetchFn(url, { ...init, signal: controller.signal }).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
    if (!response.ok) throw failure(category);
    return response;
  } catch (error) {
    if (error instanceof RwaProviderUserStreamProbeError) throw error;
    throw failure(category);
  } finally { controller.abort(); }
}

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(failure("provider_stream_probe_timeout")), timeoutMs);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function closeSocket(socket: WebSocket | null) {
  socket?.close();
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveDuration(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function connectivityFailureDetail(
  error: unknown,
): ProviderUserStreamConnectivityFailureDetail | null {
  let code: unknown = null;
  try {
    code = error !== null && typeof error === "object"
      ? Reflect.get(error, "code")
      : null;
  } catch {
    return null;
  }
  if (typeof code !== "string") return null;
  if (dnsFailureCodes.has(code)) return "dns_resolution_failed";
  if (tcpFailureCodes.has(code)) return "tcp_connection_failed";
  if (endpointFailureCodes.has(code)) return "endpoint_configuration_missing";
  if (
    code.startsWith("ERR_TLS_")
    || code.startsWith("ERR_SSL_")
    || code.startsWith("CERT_")
    || code.startsWith("UNABLE_TO_")
    || ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(code)
  ) return "tls_handshake_failed";
  return null;
}

function failure(
  category: string,
  connectivityFailedDetail: ProviderUserStreamConnectivityFailureDetail | null = null,
  lifecycleDiagnostic: ProviderUserStreamLifecycleDiagnostic | null = null,
) {
  return new RwaProviderUserStreamProbeError(
    category,
    connectivityFailedDetail,
    lifecycleDiagnostic,
  );
}

function errorLifecycleDiagnostic(error: unknown): ProviderUserStreamLifecycleDiagnostic {
  let name: unknown = null;
  let code: unknown = null;
  try {
    if (error !== null && typeof error === "object") {
      name = Reflect.get(error, "name");
      code = Reflect.get(error, "code");
    }
  } catch {
    name = null;
    code = null;
  }
  return Object.freeze({
    error: Object.freeze({
      name: safeErrorName(name),
      code: safeErrorCode(code),
    }),
    close: null,
  });
}

function closeLifecycleDiagnostic(code: unknown): ProviderUserStreamLifecycleDiagnostic {
  return Object.freeze({
    error: null,
    close: Object.freeze({
      code: Number.isInteger(code) && Number(code) >= 0 && Number(code) <= 65_535
        ? Number(code)
        : null,
    }),
  });
}

function safeErrorName(value: unknown) {
  return typeof value === "string" && [
    "AggregateError", "Error", "EvalError", "RangeError", "ReferenceError",
    "SyntaxError", "TypeError", "URIError",
  ].includes(value) ? value : "Error";
}

function safeErrorCode(value: unknown) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)
    ? value
    : null;
}

class RwaProviderUserStreamProbeError extends Error {
  constructor(
    readonly category: string,
    readonly connectivityFailedDetail: ProviderUserStreamConnectivityFailureDetail | null = null,
    readonly lifecycleDiagnostic: ProviderUserStreamLifecycleDiagnostic | null = null,
  ) { super(category); }
}
