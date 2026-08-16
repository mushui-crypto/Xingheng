import { createHash, createHmac } from "node:crypto";
import type {
  OkxAccountIdentity,
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxCredentialProvider,
  OkxCredentials,
  OkxExecutionStatus,
  OkxGetOrderRequest,
  OkxPerpetualPosition,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "./OkxTypes";

const OKX_API_BASE_URL = "https://www.okx.com";

type OkxClientOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}>;

type OkxRestResponse = Readonly<{
  code?: string;
  msg?: string;
  data?: unknown[];
}>;

export class OkxProviderError extends Error {
  constructor(
    readonly category:
      | "credential_validation_failed"
      | "provider_request_rejected"
      | "provider_response_invalid"
      | "provider_timeout"
      | "provider_transport_error",
    message: string,
    readonly providerCode: string | null = null,
  ) {
    super(message);
  }
}

export class OkxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentialProvider: OkxCredentialProvider,
    options: OkxClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? OKX_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    const normalized = normalizePlaceOrderRequest(request);
    const row = await this.signedRequest("POST", "/api/v5/trade/order", {}, {
      instId: normalized.instId,
      tdMode: normalized.tdMode,
      side: normalized.side,
      ordType: normalized.ordType,
      sz: normalized.quantity,
      clOrdId: normalized.clOrdId,
      ...(normalized.price === undefined ? {} : { px: normalized.price }),
      ...(normalized.reduceOnly === undefined ? {} : { reduceOnly: String(normalized.reduceOnly) }),
    }).then((payload) => firstRow(payload.data, "OKX place order response"));
    assertItemAccepted(row, "OKX place order");
    return Object.freeze({
      instId: exactString(row.instId, "OKX place order instId"),
      ordId: exactProviderId(row.ordId, "OKX place order ordId"),
      clOrdId: exactString(row.clOrdId, "OKX place order clOrdId"),
    });
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    const normalized = normalizeOrderLookup(request);
    const row = await this.signedRequest("GET", "/api/v5/trade/order", normalized)
      .then((payload) => firstRow(payload.data, "OKX get order response"));
    return parseOrder(row, normalized);
  }

  async getOpenOrders(instId: string): Promise<readonly OkxProviderOrder[]> {
    const normalizedInstId = exactInstrumentId(instId);
    const payload = await this.signedRequest("GET", "/api/v5/trade/orders-pending", { instId: normalizedInstId });
    return Object.freeze((payload.data ?? []).map((value) => parseOrder(
      record(value, "OKX open order"),
      { instId: normalizedInstId },
    )));
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    const normalized = normalizeOrderLookup(request);
    const row = await this.signedRequest("POST", "/api/v5/trade/cancel-order", {}, normalized)
      .then((payload) => firstRow(payload.data, "OKX cancel order response"));
    assertItemAccepted(row, "OKX cancel order");
    return Object.freeze({
      instId: exactString(row.instId, "OKX cancel order instId"),
      ordId: exactProviderId(row.ordId, "OKX cancel order ordId"),
      clOrdId: exactString(row.clOrdId, "OKX cancel order clOrdId"),
    });
  }

  async getPosition(instId: string): Promise<readonly OkxPerpetualPosition[]> {
    const normalizedInstId = exactInstrumentId(instId);
    const payload = await this.signedRequest("GET", "/api/v5/account/positions", { instId: normalizedInstId });
    return Object.freeze((payload.data ?? []).map((value) => parsePosition(record(value, "OKX position"), normalizedInstId)));
  }

  async getAccountIdentity(): Promise<OkxAccountIdentity> {
    const row = await this.signedRequest("GET", "/api/v5/account/config")
      .then((payload) => firstRow(payload.data, "OKX account config response"));
    const uid = exactString(row.uid, "OKX uid");
    const uidHash = createHash("sha256").update(`okx:${uid}`).digest("hex");
    return Object.freeze({
      accountId: `okx:${uidHash.slice(0, 16)}`,
      accountFingerprint: uidHash.slice(0, 16),
      uidHash,
      accountLevel: exactString(row.acctLv, "OKX acctLv"),
    });
  }

  private async signedRequest(
    method: "GET" | "POST",
    path: string,
    query: Readonly<Record<string, string>> = {},
    body: Readonly<Record<string, string>> | null = null,
  ): Promise<OkxRestResponse> {
    const credentials = normalizeCredentials(this.credentialProvider());
    const queryString = new URLSearchParams(
      Object.entries(query).sort(([left], [right]) => left.localeCompare(right)),
    ).toString();
    const requestPath = queryString ? `${path}?${queryString}` : path;
    const rawBody = body ? JSON.stringify(body) : "";
    const timestamp = new Date(this.now()).toISOString();
    const signature = createOkxSignature(credentials.apiSecret, timestamp, method, requestPath, rawBody);
    const url = new URL(requestPath, this.baseUrl);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "OK-ACCESS-KEY": credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": credentials.passphrase,
        },
        ...(rawBody ? { body: rawBody } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new OkxProviderError("provider_timeout", "OKX private REST request timed out.");
      }
      throw new OkxProviderError("provider_transport_error", "OKX private REST request failed before response.");
    }

    return this.parseResponse(response);
  }

  private async parseResponse(response: Response): Promise<OkxRestResponse> {
    let payload: OkxRestResponse;
    try {
      payload = await response.json() as OkxRestResponse;
    } catch {
      throw new OkxProviderError("provider_response_invalid", "OKX response is not valid JSON.", null);
    }
    const code = typeof payload.code === "string" ? payload.code : String(response.status);
    if (response.ok && code === "0") {
      if (!Array.isArray(payload.data)) {
        throw new OkxProviderError("provider_response_invalid", "OKX response data is invalid.", code);
      }
      return payload;
    }
    throw new OkxProviderError(
      isAuthenticationCode(code) ? "credential_validation_failed" : "provider_request_rejected",
      `OKX request rejected: ${code}.`,
      code,
    );
  }
}

export function createOkxSignature(
  apiSecret: string,
  timestamp: string,
  method: "GET" | "POST",
  requestPath: string,
  body = "",
) {
  return createHmac("sha256", apiSecret)
    .update(`${timestamp}${method}${requestPath}${body}`)
    .digest("base64");
}

export function mapOkxOrderStatus(rawState: string): Readonly<{
  status: OkxExecutionStatus;
  reason: string | null;
}> {
  if (rawState === "filled") return { status: "CONFIRMED", reason: null };
  if (rawState === "live") return { status: "SUBMITTED", reason: null };
  if (rawState === "partially_filled") return { status: "PENDING_CONFIRMATION", reason: null };
  if (rawState === "canceled" || rawState === "cancelled" || rawState === "rejected") return { status: "FAILED", reason: null };
  return { status: "UNKNOWN", reason: rawState ? `unmapped OKX order state: ${rawState}` : "missing OKX order state" };
}

function parseOrder(row: Record<string, unknown>, expected: Readonly<{ instId: string; ordId?: string; clOrdId?: string }>): OkxProviderOrder {
  const instId = exactString(row.instId, "OKX order instId");
  const ordId = exactProviderId(row.ordId, "OKX order ordId");
  const clOrdId = exactString(row.clOrdId, "OKX order clOrdId");
  if (instId !== expected.instId) throw invalid("OKX order instId does not match request.");
  if (expected.ordId && ordId !== expected.ordId) throw invalid("OKX order ordId does not match request.");
  if (expected.clOrdId && clOrdId !== expected.clOrdId) throw invalid("OKX order clOrdId does not match request.");
  const rawState = optionalString(row.state);
  const mapped = mapOkxOrderStatus(rawState);
  return Object.freeze({
    instId,
    ordId,
    clOrdId,
    status: mapped.status,
    statusReason: mapped.reason,
    rawState,
    requestedQuantity: decimal(row.sz, "OKX order quantity"),
    filledQuantity: decimal(row.accFillSz, "OKX order filled quantity"),
    averagePrice: nullableDecimal(row.avgPx, "OKX order average price"),
    fee: signedDecimal(row.fee ?? "0", "OKX order fee"),
    updatedAt: nullableTimestamp(row.uTime),
  });
}

function parsePosition(row: Record<string, unknown>, expectedInstId: string): OkxPerpetualPosition {
  const instId = exactString(row.instId, "OKX position instId");
  if (instId !== expectedInstId) throw invalid("OKX position instId does not match request.");
  const signedQuantity = signedDecimal(row.pos, "OKX position quantity");
  const rawSide = optionalString(row.posSide);
  return Object.freeze({
    instId,
    side: positionSide(signedQuantity, rawSide),
    quantity: magnitudeDecimal(signedQuantity),
    averagePrice: nullableDecimal(row.avgPx, "OKX position average price"),
    markPrice: nullableDecimal(row.markPx, "OKX position mark price"),
    liquidationPrice: nullableDecimal(row.liqPx, "OKX position liquidation price"),
    updatedAt: nullableTimestamp(row.uTime),
  });
}

function normalizePlaceOrderRequest(request: OkxPlaceOrderRequest): OkxPlaceOrderRequest {
  const instId = exactInstrumentId(request.instId);
  if (request.tdMode !== "cross" && request.tdMode !== "isolated") throw invalid("OKX tdMode is invalid.");
  if (request.side !== "buy" && request.side !== "sell") throw invalid("OKX order side is invalid.");
  if (request.ordType !== "market" && request.ordType !== "limit") throw invalid("OKX order type is invalid.");
  if (request.ordType === "limit" && request.price === undefined) throw invalid("OKX limit order requires price.");
  if (request.ordType === "market" && request.price !== undefined) throw invalid("OKX market order must not include price.");
  return Object.freeze({
    instId,
    tdMode: request.tdMode,
    side: request.side,
    ordType: request.ordType,
    quantity: positiveDecimal(request.quantity, "OKX order quantity"),
    clOrdId: exactClientOrderId(request.clOrdId),
    ...(request.price === undefined ? {} : { price: positiveDecimal(request.price, "OKX order price") }),
    ...(request.reduceOnly === undefined ? {} : { reduceOnly: request.reduceOnly === true }),
  });
}

function normalizeOrderLookup(request: OkxGetOrderRequest) {
  const instId = exactInstrumentId(request.instId);
  const ordId = request.ordId === undefined ? undefined : exactProviderId(request.ordId, "OKX ordId");
  const clOrdId = request.clOrdId === undefined ? undefined : exactClientOrderId(request.clOrdId);
  if (!ordId && !clOrdId) throw invalid("OKX order lookup requires ordId or clOrdId.");
  return Object.freeze({
    instId,
    ...(ordId === undefined ? {} : { ordId }),
    ...(clOrdId === undefined ? {} : { clOrdId }),
  });
}

function normalizeCredentials(credentials: OkxCredentials): OkxCredentials {
  return Object.freeze({
    apiKey: secret(credentials.apiKey, "OKX apiKey"),
    apiSecret: secret(credentials.apiSecret, "OKX apiSecret"),
    passphrase: secret(credentials.passphrase, "OKX passphrase"),
  });
}

function assertItemAccepted(row: Record<string, unknown>, label: string) {
  const itemCode = optionalString(row.sCode);
  if (itemCode && itemCode !== "0") {
    throw new OkxProviderError(
      isAuthenticationCode(itemCode) ? "credential_validation_failed" : "provider_request_rejected",
      `${label} rejected: ${itemCode}.`,
      itemCode,
    );
  }
}

function firstRow(value: unknown[] | undefined, label: string) {
  if (!value?.length) throw invalid(`${label} is empty.`);
  return record(value[0], label);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function exactInstrumentId(value: unknown) {
  const result = exactString(value, "OKX instId");
  if (!/^[A-Z0-9]{2,12}-USDT-SWAP$/u.test(result)) throw invalid("OKX instId must be a USDT linear perpetual swap.");
  return result;
}

function exactClientOrderId(value: unknown) {
  const result = exactString(value, "OKX clOrdId");
  if (!/^[A-Za-z0-9]{1,32}$/u.test(result)) throw invalid("OKX clOrdId is invalid.");
  return result;
}

function exactProviderId(value: unknown, label: string) {
  const result = exactString(value, label);
  if (!/^(?:0|[1-9]\d*)$/u.test(result)) throw invalid(`${label} is invalid.`);
  return result;
}

function exactString(value: unknown, label: string) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > 200) throw invalid(`${label} is invalid.`);
  return result;
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function secret(value: unknown, label: string) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > 512) throw invalid(`${label} is invalid.`);
  return result;
}

function positiveDecimal(value: unknown, label: string) {
  const result = decimal(value, label);
  if (result === "0") throw invalid(`${label} must be positive.`);
  return result;
}

function nullableDecimal(value: unknown, label: string) {
  return value === undefined || value === null || value === "" ? null : decimal(value, label);
}

function decimal(value: unknown, label: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw invalid(`${label} is invalid.`);
  }
  return value;
}

function signedDecimal(value: unknown, label: string) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw invalid(`${label} is invalid.`);
  }
  return value;
}

function magnitudeDecimal(value: string) {
  return value.startsWith("-") ? value.slice(1) : value;
}

function nullableTimestamp(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "string" ? value : "";
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) throw invalid("OKX timestamp is invalid.");
  const timestamp = Number(text);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw invalid("OKX timestamp is invalid.");
  return timestamp;
}

function positionSide(quantity: string, rawSide: string): "long" | "short" | "flat" {
  if (/^-?0(?:\.0+)?$/u.test(quantity)) return "flat";
  if (rawSide === "long") return "long";
  if (rawSide === "short") return "short";
  return quantity.startsWith("-") ? "short" : "long";
}

function isAuthenticationCode(code: string) {
  return code === "50101" || code === "50102" || code === "50111"
    || code === "50113" || code === "50114" || code === "50115";
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function invalid(message: string): never {
  throw new OkxProviderError("provider_response_invalid", message, null);
}
