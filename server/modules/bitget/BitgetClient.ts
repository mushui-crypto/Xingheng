import { createHash, createHmac } from "node:crypto";
import type {
  BitgetCancelOrderRequest,
  BitgetCredentials,
  BitgetGetOrderRequest,
  BitgetOrderIdentity,
  BitgetPlaceOrderRequest,
  BitgetPlaceOrderResult,
  BitgetProviderOrder,
} from "./BitgetTypes";

const BITGET_API_BASE_URL = "https://api.bitget.com";

export class BitgetProviderError extends Error {
  constructor(readonly category: string, message: string, readonly providerCode: string | null = null) { super(message); }
}

export type BitgetClientOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}>;

export class BitgetClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly credentialProvider: () => BitgetCredentials, options: BitgetClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? BITGET_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async getAccountIdentity() {
    const payload = await this.signedRequest("GET", "/api/v3/account/info", {});
    const data = record(payload.data, "Bitget account information");
    const uid = identifier(data.userId, "Bitget account userId");
    const uidHash = createHash("sha256").update(`bitget:${uid}`).digest("hex");
    const accountFingerprint = uidHash.slice(0, 16);
    return Object.freeze({ accountId: `bitget:${accountFingerprint}`, accountFingerprint, uidHash });
  }

  async getSpotAvailableBalance(assetInput: string) {
    return (await this.getSpotBalance(assetInput)).availableQuantity;
  }

  async getSpotBalance(assetInput: string) {
    const asset = assetSymbol(assetInput);
    const payload = await this.signedRequest("GET", "/api/v3/account/assets", {});
    const data = record(payload.data, "Bitget account assets");
    if (!Array.isArray(data.assets)) {
      throw new BitgetProviderError("provider_response_invalid", "Bitget account asset list is invalid.");
    }
    const matching = data.assets.map((item) => record(item, "Bitget account asset"))
      .filter((item) => optionalString(item.coin)?.toUpperCase() === asset);
    if (matching.length > 1) {
      throw new BitgetProviderError("provider_response_invalid", "Bitget account asset is not unique.");
    }
    if (matching.length === 0) return Object.freeze({ totalQuantity: "0", availableQuantity: "0" });
    const availableQuantity = decimal(matching[0]!.available, "Bitget available balance");
    const lockedQuantity = decimal(matching[0]!.locked ?? "0", "Bitget locked balance");
    return Object.freeze({
      totalQuantity: addDecimals(availableQuantity, lockedQuantity),
      availableQuantity,
    });
  }

  async assertOneWayMode() {
    const payload = await this.signedRequest("GET", "/api/v3/account/settings", {});
    const settings = record(payload.data, "Bitget account settings");
    if (requiredString(settings.holdMode, "Bitget holdMode").toLowerCase() !== "one_way_mode") {
      throw new BitgetProviderError("position_mode_unsupported", "Bitget execution requires one-way position mode.");
    }
  }

  async readPositionMode(): Promise<"ONE_WAY" | "HEDGE"> {
    const payload = await this.signedRequest("GET", "/api/v3/account/settings", {});
    const settings = record(payload.data, "Bitget account settings");
    const mode = requiredString(settings.holdMode, "Bitget holdMode").toLowerCase();
    if (mode === "one_way_mode") return "ONE_WAY";
    if (mode === "hedge_mode") return "HEDGE";
    throw new BitgetProviderError("position_mode_unsupported", "Bitget position mode is unsupported.");
  }

  async placeOrder(input: BitgetPlaceOrderRequest): Promise<BitgetPlaceOrderResult> {
    const request = placeRequest(input);
    const payload = await this.signedRequest("POST", "/api/v3/trade/place-order", request);
    const data = record(payload.data, "Bitget place order result");
    const identity = Object.freeze({
      category: request.category,
      symbol: request.symbol,
      orderId: identifier(data.orderId, "Bitget orderId"),
      clientOid: clientOid(data.clientOid, "Bitget response clientOid"),
    });
    assertLookupIdentity(identity, request);
    return identity;
  }

  async getOrder(input: BitgetGetOrderRequest): Promise<BitgetProviderOrder> {
    const request = getOrderRequest(input);
    const payload = await this.signedRequest("GET", "/api/v3/trade/order-info", {
      category: request.category,
      symbol: request.symbol,
      ...(request.orderId === undefined ? {} : { orderId: request.orderId }),
      clientOid: request.clientOid,
    });
    const rows = Array.isArray(payload.data) ? payload.data : [payload.data];
    const matching = rows.map((item) => record(item, "Bitget order"))
      .filter((row) => row.symbol === request.symbol && row.clientOid === request.clientOid
        && (request.orderId === undefined || String(row.orderId) === request.orderId));
    if (matching.length !== 1) {
      throw new BitgetProviderError("provider_response_invalid", "Bitget order response does not uniquely match the execution order.");
    }
    return providerOrder(matching[0]!, request.category);
  }

  async cancelOrder(input: BitgetCancelOrderRequest): Promise<BitgetOrderIdentity> {
    const request = getOrderRequest(input);
    const payload = await this.signedRequest("POST", "/api/v3/trade/cancel-order", {
      category: request.category,
      symbol: request.symbol,
      ...(request.orderId === undefined ? {} : { orderId: request.orderId }),
      clientOid: request.clientOid,
    });
    const data = record(payload.data, "Bitget cancel order result");
    const identity = Object.freeze({
      category: request.category,
      symbol: request.symbol,
      orderId: identifier(data.orderId, "Bitget orderId"),
      clientOid: clientOid(data.clientOid, "Bitget response clientOid"),
    });
    assertLookupIdentity(identity, request);
    return identity;
  }

  private async signedRequest(method: "GET" | "POST", path: string, values: Record<string, unknown>) {
    const credential = credentials(this.credentialProvider());
    const timestamp = String(this.timestamp());
    const url = new URL(path, this.baseUrl);
    let body = "";
    if (method === "GET") {
      url.search = new URLSearchParams(Object.entries(values)
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, String(value)])).toString();
    } else {
      body = JSON.stringify(values);
    }
    const requestTarget = `${url.pathname}${url.search}`;
    const signature = createHmac("sha256", credential.apiSecret)
      .update(`${timestamp}${method}${requestTarget}${body}`).digest("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          "ACCESS-KEY": credential.apiKey,
          "ACCESS-SIGN": signature,
          "ACCESS-TIMESTAMP": timestamp,
          "ACCESS-PASSPHRASE": credential.passphrase,
          "Content-Type": "application/json",
          locale: "en-US",
        },
        ...(method === "POST" ? { body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BitgetProviderError("provider_transport_error", "Bitget request failed.");
    }
    let payload: unknown;
    try { payload = await response.json(); } catch {
      throw new BitgetProviderError("provider_response_invalid", "Bitget response is not valid JSON.");
    }
    const root = record(payload, "Bitget response");
    if (!response.ok || root.code !== "00000") {
      const providerCode = optionalString(root.code);
      const category = bitgetAuthenticationCode(providerCode) ? "credential_validation_failed" : "provider_rejected";
      throw new BitgetProviderError(category, safeBitgetProviderMessage(category, providerCode), providerCode);
    }
    return root;
  }

  private timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Bitget client clock is invalid.");
    return value;
  }
}

function placeRequest(input: BitgetPlaceOrderRequest): BitgetPlaceOrderRequest {
  const category = input.category === "SPOT" || input.category === "USDT-FUTURES" ? input.category : invalid("Bitget category is invalid.");
  const symbol = providerSymbol(input.symbol);
  const side = input.side === "buy" || input.side === "sell" ? input.side : invalid("Bitget side is invalid.");
  const orderType = input.orderType === "market" || input.orderType === "limit" ? input.orderType : invalid("Bitget orderType is invalid.");
  const qty = positiveDecimal(input.qty, "Bitget order qty");
  const id = clientOid(input.clientOid, "Bitget clientOid");
  const price = input.price === undefined ? undefined : positiveDecimal(input.price, "Bitget order price");
  if (orderType === "limit" && (price === undefined || (input.force !== "gtc" && input.force !== "ioc"))) {
    throw new Error("Bitget limit order requires price and force.");
  }
  if (orderType === "market" && (price !== undefined || input.force !== undefined)) {
    throw new Error("Bitget market order must not include price or force.");
  }
  if (category === "SPOT" && input.reduceOnly !== undefined) throw new Error("Bitget Spot order must not include reduceOnly.");
  if (category === "SPOT" && input.posSide !== undefined) throw new Error("Bitget Spot order must not include posSide.");
  if (category === "SPOT" && orderType === "market" && side === "buy") {
    throw new Error("Bitget Spot market BUY uses quote quantity and is unavailable for canonical base execution.");
  }
  if (category === "USDT-FUTURES" && input.posSide === undefined && input.reduceOnly !== "yes" && input.reduceOnly !== "no") {
    throw new Error("Bitget USDT-FUTURES order requires explicit reduceOnly.");
  }
  if (category === "USDT-FUTURES" && input.posSide !== undefined && input.reduceOnly !== undefined) {
    throw new Error("Bitget HEDGE order must express close semantics with side and posSide, not reduceOnly.");
  }
  if (category === "USDT-FUTURES" && input.posSide !== undefined && input.posSide !== "long" && input.posSide !== "short") {
    throw new Error("Bitget posSide is invalid.");
  }
  return Object.freeze({ category, symbol, side, orderType, qty, clientOid: id,
    ...(price === undefined ? {} : { price }),
    ...(input.force === undefined ? {} : { force: input.force }),
    ...(input.reduceOnly === undefined ? {} : { reduceOnly: input.reduceOnly }),
    ...(input.posSide === undefined ? {} : { posSide: input.posSide }),
  });
}

function getOrderRequest(input: BitgetGetOrderRequest): BitgetGetOrderRequest {
  return Object.freeze({
    category: input.category === "SPOT" || input.category === "USDT-FUTURES" ? input.category : invalid("Bitget category is invalid."),
    symbol: providerSymbol(input.symbol),
    ...(input.orderId === undefined ? {} : { orderId: identifier(input.orderId, "Bitget orderId") }),
    clientOid: clientOid(input.clientOid, "Bitget clientOid"),
  });
}

function providerOrder(row: Record<string, unknown>, category: BitgetProviderOrder["category"]): BitgetProviderOrder {
  const rawStatus = orderStatus(row);
  const fee = feeDetail(row.feeDetail);
  const posSide = providerEnum(row.posSide, ["long", "short"], "Bitget order posSide");
  const tradeSide = providerEnum(row.tradeSide, ["open", "close"], "Bitget order tradeSide");
  const holdMode = providerEnum(row.holdMode, ["one_way_mode", "hedge_mode"], "Bitget order holdMode");
  const reduceOnly = providerEnum(typeof row.reduceOnly === "string" ? row.reduceOnly.toLowerCase() : row.reduceOnly, ["yes", "no"], "Bitget order reduceOnly");
  return Object.freeze({
    category,
    symbol: providerSymbol(row.symbol),
    orderId: identifier(row.orderId, "Bitget orderId"),
    clientOid: clientOid(row.clientOid, "Bitget clientOid"),
    side: row.side === "buy" || row.side === "sell" ? row.side : invalid("Bitget order side is invalid."),
    ...(posSide === undefined ? {} : { posSide }),
    ...(tradeSide === undefined ? {} : { tradeSide }),
    ...(holdMode === undefined ? {} : { holdMode }),
    ...(reduceOnly === undefined ? {} : { reduceOnly }),
    status: status(rawStatus), rawStatus,
    requestedQuantity: decimal(row.qty, "Bitget order qty"),
    filledQuantity: decimal(row.cumExecQty, "Bitget cumulative executed quantity"),
    averagePrice: optionalPositiveDecimal(row.avgPrice, "Bitget average price"),
    fee: fee.amount,
    feeCurrency: fee.currency,
    updatedAt: optionalTimestamp(row.updatedTime),
  });
}
function orderStatus(row: Record<string, unknown>) {
  const official = optionalString(row.orderStatus);
  const legacy = optionalString(row.status);
  if (official && legacy && official !== legacy) {
    throw new BitgetProviderError("provider_response_invalid", "Bitget order status fields conflict.");
  }
  return requiredString(official ?? legacy, "Bitget order status");
}
function feeDetail(value: unknown) {
  if (value === undefined || value === null) return { amount: "0", currency: null } as const;
  if (!Array.isArray(value)) throw new BitgetProviderError("provider_response_invalid", "Bitget feeDetail is invalid.");
  const entries = value.map((item) => record(item, "Bitget fee detail")).flatMap((item) => {
    if ((item.fee === null || item.fee === "") && (item.feeCoin === null || item.feeCoin === "")) return [];
    const currency = optionalString(item.feeCoin)?.toUpperCase();
    if (!currency || !/^[A-Z0-9]{2,12}$/u.test(currency)) {
      throw new BitgetProviderError("provider_response_invalid", "Bitget fee currency is invalid.");
    }
    return [{ amount: decimal(item.fee, "Bitget order fee"), currency }];
  });
  if (entries.length === 0) return { amount: "0", currency: null } as const;
  const currency = entries[0]!.currency;
  if (entries.some((entry) => entry.currency !== currency)) {
    throw new BitgetProviderError("provider_response_invalid", "Bitget multi-asset fee cannot be represented losslessly.");
  }
  return { amount: entries.reduce((sum, entry) => addDecimals(sum, entry.amount), "0"), currency } as const;
}
function status(value: string): BitgetProviderOrder["status"] {
  if (value === "filled") return "CONFIRMED";
  if (value === "live" || value === "new" || value === "partially_filled") return "PENDING_CONFIRMATION";
  if (value === "cancelled" || value === "rejected") return "FAILED";
  return "UNKNOWN";
}
function assertLookupIdentity(identity: BitgetOrderIdentity, lookup: { category: string; symbol: string; orderId?: string; clientOid: string }) {
  if (identity.category !== lookup.category || identity.symbol !== lookup.symbol || identity.clientOid !== lookup.clientOid
    || (lookup.orderId !== undefined && identity.orderId !== lookup.orderId)) {
    throw new BitgetProviderError("provider_response_invalid", "Bitget response identity does not match the execution order.");
  }
}
function credentials(value: BitgetCredentials) { return Object.freeze({
  apiKey: requiredString(value.apiKey, "Bitget apiKey"), apiSecret: requiredString(value.apiSecret, "Bitget apiSecret"),
  passphrase: requiredString(value.passphrase, "Bitget passphrase"),
}); }
function providerSymbol(value: unknown) { const text = requiredString(value, "Bitget symbol").toUpperCase(); if (!/^[A-Z0-9]{4,24}$/u.test(text)) throw new Error("Bitget symbol is invalid."); return text; }
function assetSymbol(value: unknown) { const text = requiredString(value, "Bitget asset").toUpperCase(); if (!/^[A-Z0-9]{2,12}$/u.test(text)) throw new Error("Bitget asset is invalid."); return text; }
function clientOid(value: unknown, label: string) { const text = requiredString(value, label); if (!/^[A-Za-z0-9_-]{1,32}$/u.test(text)) throw new Error(`${label} is invalid.`); return text; }
function identifier(value: unknown, label: string) { const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : requiredString(value, label); if (!/^[A-Za-z0-9_-]{1,64}$/u.test(text)) throw new Error(`${label} is invalid.`); return text; }
function requiredString(value: unknown, label: string) { const text = typeof value === "string" ? value.trim() : ""; if (!text || text.length > 512) throw new BitgetProviderError("provider_response_invalid", `${label} is invalid.`); return text; }
function optionalString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function bitgetAuthenticationCode(code: string | null) {
  return code === "40001" || code === "40002" || code === "40003" || code === "40004"
    || code === "40005" || code === "40006" || code === "40008" || code === "40009"
    || code === "40011" || code === "40012" || code === "40036" || code === "40037";
}
export function safeBitgetProviderMessage(category: string, providerCode: string | null) {
  if (category === "credential_validation_failed") return "Bitget credential validation failed.";
  if (category === "provider_transport_error" || category === "provider_unavailable") {
    return "Bitget provider is currently unavailable.";
  }
  if (category === "provider_response_invalid") return "Bitget returned an invalid response.";
  if (category === "position_mode_unsupported") return "Bitget position mode is unsupported.";
  if (providerCode === "25204") return "Bitget order lookup did not find the requested order.";
  return "Bitget request was rejected.";
}
function providerEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T | undefined {
  const text = optionalString(value)?.toLowerCase();
  if (text === undefined || text === null) return undefined;
  if ((allowed as readonly string[]).includes(text)) return text as T;
  throw new BitgetProviderError("provider_response_invalid", `${label} is invalid.`);
}
function decimal(value: unknown, label: string) { const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : ""; if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) throw new BitgetProviderError("provider_response_invalid", `${label} is invalid.`); return normalizeDecimal(text); }
function positiveDecimal(value: unknown, label: string) { const result = decimal(value, label); if (result === "0") throw new Error(`${label} must be positive.`); return result; }
function optionalPositiveDecimal(value: unknown, label: string) { return value === undefined || value === null || value === "" ? null : positiveDecimal(value, label); }
function optionalTimestamp(value: unknown) { const numeric = typeof value === "string" && value.trim() ? Number(value) : value; return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null; }
function normalizeDecimal(value: string) { const [integer, fraction = ""] = value.split("."); const normalized = fraction.replace(/0+$/u, ""); return normalized ? `${integer}.${normalized}` : integer!; }
function addDecimals(left: string, right: string) { const [li, lf = ""] = left.split("."); const [ri, rf = ""] = right.split("."); const scale = Math.max(lf.length, rf.length); const sum = BigInt(`${li}${lf.padEnd(scale, "0")}`) + BigInt(`${ri}${rf.padEnd(scale, "0")}`); const digits = sum.toString().padStart(scale + 1, "0"); return normalizeDecimal(scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`); }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new BitgetProviderError("provider_response_invalid", `${label} is invalid.`); return value as Record<string, unknown>; }
function invalid(message: string): never { throw new Error(message); }
