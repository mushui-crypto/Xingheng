import { tracedProviderFetch, tracedProviderJson } from "../cex/ProviderRequestTrace";
import { createHash, createHmac } from "node:crypto";
import type {
  BybitAccountAccess,
  BybitAccountIdentity,
  BybitCancelOrderRequest,
  BybitCredentials,
  BybitGetOrderRequest,
  BybitOrderIdentity,
  BybitPermissions,
  BybitPlaceOrderRequest,
  BybitPlaceOrderResult,
  BybitProviderOrder,
} from "./BybitTypes";

const BYBIT_API_BASE_URL = "https://api.bybit.com";
const RECV_WINDOW = "5000";

export type BybitReconcileSubstage =
  | "ORDER_REALTIME"
  | "ORDER_HISTORY"
  | "EXECUTION_LIST"
  | "EXECUTION_EVIDENCE_COMPARE";

export class BybitProviderError extends Error {
  constructor(
    readonly category: string,
    message: string,
    readonly providerCode?: number,
    readonly reconcileSubstage?: BybitReconcileSubstage,
  ) {
    super(message);
  }
}

export type BybitClientOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}>;

export type BybitHistoricalOrderEvidence = Readonly<{
  exactOrderEvidence: "ABSENT" | "PRESENT";
  activeOrderCount: number;
  checkedAt: number;
}>;

export class BybitClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentialProvider: () => BybitCredentials,
    options: BybitClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? BYBIT_API_BASE_URL;
    this.fetchImpl = tracedProviderFetch("bybit", options.fetchImpl ?? fetch);
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async getAccountIdentity(): Promise<BybitAccountIdentity> {
    const payload = await this.signedRequest("GET", "/v5/user/query-api", {});
    const result = record(payload.result, "Bybit API key information");
    return accountIdentity(requiredIdentifier(result.userID, "Bybit userID"));
  }

  async validateAccess(): Promise<BybitAccountAccess> {
    const [apiKeyPayload, accountPayload] = await Promise.all([
      this.signedRequest("GET", "/v5/user/query-api", {}),
      this.signedRequest("GET", "/v5/account/info", {}),
    ]);
    const apiKey = record(apiKeyPayload.result, "Bybit API key information");
    const account = record(accountPayload.result, "Bybit account information");
    const identity = accountIdentity(requiredIdentifier(apiKey.userID, "Bybit userID"));
    const unifiedMarginStatus = integer(account.unifiedMarginStatus, "Bybit unifiedMarginStatus");
    const marginMode = requiredString(account.marginMode, "Bybit marginMode");
    const permissions = bybitPermissions(apiKey, unifiedMarginStatus, marginMode);
    return Object.freeze({ ...identity, permissions, unifiedMarginStatus, marginMode });
  }

  async getLinearPositionIdx(symbolInput: string) {
    const symbol = providerSymbol(symbolInput);
    const payload = await this.signedRequest("GET", "/v5/position/list", { category: "linear", symbol });
    const result = record(payload.result, "Bybit position result");
    const rows = array(result.list, "Bybit positions")
      .map((item) => record(item, "Bybit position"))
      .filter((item) => item.symbol === symbol);
    if (!rows.length) throw new BybitProviderError("provider_response_invalid", "Bybit position mode response is empty.");
    const indexes = new Set(rows.map((row) => positionIdx(row.positionIdx)));
    if (indexes.size !== 1 || !indexes.has(0)) {
      throw new BybitProviderError("position_mode_unsupported", "Bybit Linear execution requires positionIdx=0.");
    }
    return 0 as const;
  }

  async readLinearPositionMode(symbolInput: string): Promise<"ONE_WAY" | "HEDGE"> {
    const symbol = providerSymbol(symbolInput);
    const payload = await this.signedRequest("GET", "/v5/position/list", { category: "linear", symbol });
    const result = record(payload.result, "Bybit position result");
    const rows = array(result.list, "Bybit positions").map((item) => record(item, "Bybit position"))
      .filter((item) => item.symbol === symbol);
    if (!rows.length) throw new BybitProviderError("provider_response_invalid", "Bybit position mode response is empty.");
    const indexes = new Set(rows.map((row) => positionIdx(row.positionIdx)));
    if (indexes.has(0) && indexes.size > 1) throw new BybitProviderError("provider_response_invalid", "Bybit position mode is ambiguous.");
    if (indexes.has(0)) return "ONE_WAY";
    if ([...indexes].every((index) => index === 1 || index === 2)) return "HEDGE";
    throw new BybitProviderError("position_mode_unsupported", "Bybit position mode is unsupported.");
  }

  async placeOrder(requestInput: BybitPlaceOrderRequest): Promise<BybitPlaceOrderResult> {
    const request = placeRequest(requestInput);
    const payload = await this.signedRequest("POST", "/v5/order/create", {
      category: request.category,
      symbol: request.symbol,
      side: request.side,
      orderType: request.orderType,
      qty: request.qty,
      orderLinkId: request.orderLinkId,
      ...(request.price === undefined ? {} : { price: request.price }),
      ...(request.reduceOnly === undefined ? {} : { reduceOnly: request.reduceOnly }),
      ...(request.positionIdx === undefined ? {} : { positionIdx: request.positionIdx }),
      ...(request.marketUnit === undefined ? {} : { marketUnit: request.marketUnit }),
    });
    const result = record(payload.result, "Bybit order create result");
    return Object.freeze({
      category: request.category,
      symbol: request.symbol,
      orderId: requiredIdentifier(result.orderId, "Bybit orderId"),
      orderLinkId: exactOrderLinkId(result.orderLinkId, "Bybit orderLinkId"),
    });
  }

  async getOrder(requestInput: BybitGetOrderRequest): Promise<BybitProviderOrder> {
    const request = getOrderRequest(requestInput);
    const query = {
      category: request.category,
      symbol: request.symbol,
      ...(request.orderId === undefined ? {} : { orderId: request.orderId }),
      orderLinkId: request.orderLinkId,
    };
    let substage: BybitReconcileSubstage = "ORDER_REALTIME";
    let rows = await this.orderRows("/v5/order/realtime", query, substage);
    if (!rows.length) {
      substage = "ORDER_HISTORY";
      rows = await this.orderRows("/v5/order/history", query, substage);
    }
    const matching = rows.filter((row) => orderMatches(row, request));
    if (matching.length !== 1) {
      throw new BybitProviderError(
        "provider_response_invalid",
        "Bybit order response does not uniquely match the execution order.",
        undefined,
        substage,
      );
    }
    const row = matching[0]!;
    const identity = orderIdentity(row, request.category);
    const executions = await this.executionEvidence(identity);
    return providerOrder(row, identity, executions);
  }

  async cancelOrder(requestInput: BybitCancelOrderRequest): Promise<BybitOrderIdentity> {
    const request = getOrderRequest(requestInput);
    const payload = await this.signedRequest("POST", "/v5/order/cancel", {
      category: request.category,
      symbol: request.symbol,
      ...(request.orderId === undefined ? {} : { orderId: request.orderId }),
      orderLinkId: request.orderLinkId,
    });
    const result = record(payload.result, "Bybit order cancel result");
    const identity = Object.freeze({
      category: request.category,
      symbol: request.symbol,
      orderId: requiredIdentifier(result.orderId, "Bybit orderId"),
      orderLinkId: exactOrderLinkId(result.orderLinkId, "Bybit orderLinkId"),
    });
    assertLookupIdentity(identity, request);
    return identity;
  }

  async getSpotAvailableBalance(assetInput: string) {
    return (await this.getSpotBalance(assetInput)).availableQuantity;
  }

  async getSpotBalance(assetInput: string) {
    const coin = asset(assetInput);
    const payload = await this.signedRequest("GET", "/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin,
    });
    const result = record(payload.result, "Bybit wallet balance result");
    const accounts = array(result.list, "Bybit wallet balance list").map((item) => record(item, "Bybit wallet balance"));
    if (accounts.length !== 1) throw new BybitProviderError("provider_response_invalid", "Bybit wallet balance account is ambiguous.");
    const coins = array(accounts[0]!.coin, "Bybit wallet coins").map((item) => record(item, "Bybit wallet coin"));
    const matching = coins.filter((item) => item.coin === coin);
    if (matching.length !== 1) throw new BybitProviderError("provider_response_invalid", "Bybit wallet coin balance is unavailable.");
    const wallet = unsignedDecimal(requiredString(matching[0]!.walletBalance, "Bybit walletBalance"), "Bybit walletBalance");
    const locked = unsignedDecimal(optionalString(matching[0]!.locked) ?? "0", "Bybit locked balance");
    if (compareDecimal(wallet, locked) < 0) throw new BybitProviderError("provider_response_invalid", "Bybit locked balance exceeds wallet balance.");
    return Object.freeze({ totalQuantity: formatDecimal(wallet), availableQuantity: subtractDecimal(wallet, locked) });
  }

  async readHistoricalOrderEvidence(input: Readonly<{
    category: "spot" | "linear";
    symbol: string;
    orderLinkId: string;
    startedAt: number;
  }>): Promise<BybitHistoricalOrderEvidence> {
    const category = input.category;
    const symbol = providerSymbol(input.symbol);
    const orderLinkId = exactOrderLinkId(input.orderLinkId, "Bybit orderLinkId");
    const startedAt = timestamp(input.startedAt, "Bybit historical execution start");
    const endTime = this.timestamp();
    const startTime = Math.max(0, Math.min(startedAt - 60_000, endTime));
    const exactQuery = {
      category, symbol, orderLinkId,
      startTime: String(startTime),
      endTime: String(endTime),
    };
    const [realtime, history, executions, active] = await Promise.all([
      this.orderRows("/v5/order/realtime", { category, symbol, orderLinkId }),
      this.orderRows("/v5/order/history", exactQuery),
      this.executionRows(exactQuery),
      this.orderRows("/v5/order/realtime", { category, symbol }),
    ]);
    const exactOrderEvidence = [...realtime, ...history, ...executions].some((row) => (
      row.orderLinkId === orderLinkId && row.symbol === symbol
    )) ? "PRESENT" as const : "ABSENT" as const;
    const activeOrderCount = active.filter((row) => row.symbol === symbol).length;
    return Object.freeze({ exactOrderEvidence, activeOrderCount, checkedAt: endTime });
  }

  async readActiveOrderCount(category: "spot" | "linear", symbolInput: string) {
    const symbol = providerSymbol(symbolInput);
    const rows = await this.orderRows("/v5/order/realtime", { category, symbol });
    return rows.filter((row) => row.symbol === symbol).length;
  }

  private async orderRows(
    path: string,
    query: Record<string, string>,
    reconcileSubstage?: BybitReconcileSubstage,
  ) {
    try {
      const payload = await this.signedRequest("GET", path, query);
      const result = record(payload.result, "Bybit order result");
      return array(result.list, "Bybit order list").map((item) => record(item, "Bybit order"));
    } catch (error) {
      throw withReconcileSubstage(error, reconcileSubstage);
    }
  }

  private async executionEvidence(identity: BybitOrderIdentity) {
    try {
      const payload = await this.signedRequest("GET", "/v5/execution/list", {
        category: identity.category,
        symbol: identity.symbol,
        orderId: identity.orderId,
      });
      const result = record(payload.result, "Bybit execution result");
      const rows = array(result.list, "Bybit execution list")
        .map((item) => record(item, "Bybit execution"))
        .filter((item) => item.orderId === identity.orderId
          && item.orderLinkId === identity.orderLinkId
          && item.symbol === identity.symbol);
      let fee = "0";
      let filled = "0";
      let feeCurrency: string | null = null;
      for (const row of rows) {
        fee = addDecimal(fee, unsignedDecimal(requiredString(row.execFee, "Bybit execFee"), "Bybit execFee"));
        filled = addDecimal(filled, unsignedDecimal(requiredString(row.execQty, "Bybit execQty"), "Bybit execQty"));
        const currency = optionalString(row.feeCurrency);
        if (currency !== null) {
          const normalized = asset(currency);
          if (feeCurrency !== null && feeCurrency !== normalized) {
            throw new BybitProviderError("provider_response_invalid", "Bybit execution fee currencies are inconsistent.");
          }
          feeCurrency = normalized;
        }
      }
      return Object.freeze({ fee, filled, feeCurrency });
    } catch (error) {
      throw withReconcileSubstage(error, "EXECUTION_LIST");
    }
  }

  private async executionRows(query: Record<string, unknown>) {
    const payload = await this.signedRequest("GET", "/v5/execution/list", query);
    const result = record(payload.result, "Bybit execution result");
    return array(result.list, "Bybit execution list").map((item) => record(item, "Bybit execution"));
  }

  private async signedRequest(method: "GET" | "POST", path: string, values: Record<string, unknown>) {
    const credential = normalizeCredentials(this.credentialProvider());
    const timestamp = String(this.timestamp());
    const url = new URL(path, this.baseUrl);
    let body: string | undefined;
    let signaturePayload: string;
    if (method === "GET") {
      const entries = Object.entries(values)
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
      const query = new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString();
      url.search = query;
      signaturePayload = query;
    } else {
      body = JSON.stringify(values);
      signaturePayload = body;
    }
    const signature = createHmac("sha256", credential.apiSecret)
      .update(`${timestamp}${credential.apiKey}${RECV_WINDOW}${signaturePayload}`)
      .digest("hex");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
          "X-BAPI-API-KEY": credential.apiKey,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": RECV_WINDOW,
          "X-BAPI-SIGN": signature,
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BybitProviderError("provider_transport_error", "Bybit request failed.");
    }
    if (!response.ok) throw new BybitProviderError("provider_transport_error", `Bybit request failed with HTTP ${response.status}.`);
    let payload: unknown;
    try {
      payload = await tracedProviderJson(response);
    } catch {
      throw new BybitProviderError("provider_response_invalid", "Bybit response is not valid JSON.");
    }
    const root = record(payload, "Bybit response");
    const code = integer(root.retCode, "Bybit retCode");
    if (code !== 0) {
      const category = authenticationCode(code) ? "credential_validation_failed" : "provider_rejected";
      throw new BybitProviderError(category, safeBybitProviderMessage(category), code);
    }
    return root;
  }

  private timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Bybit client clock is invalid.");
    return value;
  }
}

function providerOrder(
  row: Record<string, unknown>,
  identity: BybitOrderIdentity,
  executions: Readonly<{ fee: string; filled: string; feeCurrency: string | null }>,
): BybitProviderOrder {
  const requestedQuantity = decimalString(row.qty, "Bybit order qty");
  const orderFilled = decimalString(row.cumExecQty, "Bybit cumulative executed quantity");
  const rawStatus = requiredString(row.orderStatus, "Bybit orderStatus");
  const fillComparison = compareDecimal(
    unsignedDecimal(orderFilled, "Bybit cumulative executed quantity"),
    unsignedDecimal(executions.filled, "Bybit execution evidence quantity"),
  );
  if (fillComparison > 0 && executionEvidenceMayStillConverge(rawStatus)) {
    throw new BybitProviderError(
      "execution_evidence_pending",
      "Bybit execution evidence has not reached the authoritative order cumulative fill.",
      undefined,
      "EXECUTION_EVIDENCE_COMPARE",
    );
  }
  if (fillComparison !== 0) {
    throw new BybitProviderError(
      "provider_response_invalid",
      "Bybit order and execution cumulative fills conflict.",
      undefined,
      "EXECUTION_EVIDENCE_COMPARE",
    );
  }
  return Object.freeze({
    ...identity,
    side: orderSide(row.side),
    status: executionStatus(rawStatus),
    statusReason: optionalString(row.rejectReason) ?? optionalString(row.cancelType),
    rawStatus,
    requestedQuantity,
    filledQuantity: orderFilled,
    averagePrice: positiveOptionalDecimal(row.avgPrice, "Bybit average price"),
    fee: executions.fee,
    feeCurrency: executions.feeCurrency,
    ...(row.positionIdx === undefined || row.positionIdx === "" ? {} : { positionIdx: positionIdx(row.positionIdx) }),
    ...(row.reduceOnly === undefined || row.reduceOnly === "" ? {} : { reduceOnly: providerBoolean(row.reduceOnly) }),
    ...(row.marketUnit === undefined || row.marketUnit === "" ? {} : { marketUnit: marketUnit(row.marketUnit) }),
    updatedAt: optionalTimestamp(row.updatedTime),
  });
}

function executionEvidenceMayStillConverge(rawStatus: string) {
  return rawStatus === "Filled"
    || rawStatus === "New"
    || rawStatus === "Created"
    || rawStatus === "PartiallyFilled"
    || rawStatus === "Untriggered"
    || rawStatus === "Triggered";
}

function withReconcileSubstage(error: unknown, substage?: BybitReconcileSubstage): unknown {
  if (!(error instanceof BybitProviderError) || substage === undefined || error.reconcileSubstage !== undefined) {
    return error;
  }
  return new BybitProviderError(error.category, error.message, error.providerCode, substage);
}

function providerBoolean(value: unknown) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("Bybit reduceOnly is invalid.");
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function placeRequest(input: BybitPlaceOrderRequest): BybitPlaceOrderRequest {
  const category = bybitCategory(input.category);
  const symbol = providerSymbol(input.symbol);
  const side = orderSide(input.side);
  const orderType = input.orderType === "Market" || input.orderType === "Limit" ? input.orderType : invalid("Bybit orderType is invalid.");
  const qty = positiveDecimalString(input.qty, "Bybit order qty");
  const orderLinkId = exactOrderLinkId(input.orderLinkId, "Bybit orderLinkId");
  const price = input.price === undefined ? undefined : positiveDecimalString(input.price, "Bybit order price");
  if (orderType === "Limit" && price === undefined) throw new Error("Bybit limit order price is required.");
  if (orderType === "Market" && price !== undefined) throw new Error("Bybit market order must not include price.");
  if (category === "spot") {
    if (input.reduceOnly !== undefined || input.positionIdx !== undefined) throw new Error("Bybit Spot order contains Linear-only fields.");
    if (orderType === "Market" && input.marketUnit !== "baseCoin") throw new Error("Bybit Spot market quantity must use marketUnit=baseCoin.");
  } else {
    if (input.positionIdx !== 0 && input.positionIdx !== 1 && input.positionIdx !== 2) throw new Error("Bybit Linear positionIdx is invalid.");
    if (input.marketUnit !== undefined) throw new Error("Bybit Linear order must not include marketUnit.");
  }
  return Object.freeze({
    category, symbol, side, orderType, qty, orderLinkId,
    ...(price === undefined ? {} : { price }),
    ...(input.reduceOnly === undefined ? {} : { reduceOnly: Boolean(input.reduceOnly) }),
    ...(input.positionIdx === undefined ? {} : { positionIdx: input.positionIdx }),
    ...(input.marketUnit === undefined ? {} : { marketUnit: "baseCoin" as const }),
  });
}

function getOrderRequest(input: BybitGetOrderRequest): BybitGetOrderRequest {
  return Object.freeze({
    category: bybitCategory(input.category),
    symbol: providerSymbol(input.symbol),
    ...(input.orderId === undefined ? {} : { orderId: requiredIdentifier(input.orderId, "Bybit orderId") }),
    orderLinkId: exactOrderLinkId(input.orderLinkId, "Bybit orderLinkId"),
  });
}

function orderIdentity(row: Record<string, unknown>, category: BybitOrderIdentity["category"]): BybitOrderIdentity {
  return Object.freeze({
    category,
    symbol: providerSymbol(row.symbol),
    orderId: requiredIdentifier(row.orderId, "Bybit orderId"),
    orderLinkId: exactOrderLinkId(row.orderLinkId, "Bybit orderLinkId"),
  });
}

function orderMatches(row: Record<string, unknown>, request: BybitGetOrderRequest) {
  return row.symbol === request.symbol
    && row.orderLinkId === request.orderLinkId
    && (request.orderId === undefined || String(row.orderId) === request.orderId);
}

function assertLookupIdentity(identity: BybitOrderIdentity, request: BybitGetOrderRequest) {
  if (identity.category !== request.category || identity.symbol !== request.symbol
    || identity.orderLinkId !== request.orderLinkId
    || (request.orderId !== undefined && identity.orderId !== request.orderId)) {
    throw new BybitProviderError("provider_response_invalid", "Bybit response identity does not match the execution order.");
  }
}

function accountIdentity(uid: string): BybitAccountIdentity {
  const uidHash = createHash("sha256").update(`bybit:${uid}`).digest("hex");
  return Object.freeze({
    accountId: `bybit:${uidHash.slice(0, 16)}`,
    accountFingerprint: uidHash.slice(0, 16),
    uidHash,
  });
}

function bybitPermissions(apiKey: Record<string, unknown>, unifiedMarginStatus: number, marginMode: string): BybitPermissions {
  const groups = permissions(apiKey.permissions);
  const ips = stringArray(apiKey.ips);
  const readOnly = optionalInteger(apiKey.readOnly);
  const read = readOnly === 0 || readOnly === 1;
  const spotTrade = permission(groups, ["Spot"], ["SpotTrade"]);
  const contractTrade = permission(groups, ["ContractTrade", "Derivatives"], ["Order", "DerivativesTrade"]);
  const withdraw = permission(groups, ["Wallet"], ["Withdraw"]);
  const accountLevelSupported = (unifiedMarginStatus === 5 || unifiedMarginStatus === 6) && marginMode === "REGULAR_MARGIN";
  return Object.freeze({
    read,
    spotTrade,
    contractTrade,
    withdraw,
    ipRestricted: ips !== null && ips.length > 0,
    accountLevelSupported,
    providerVerified: true,
    executionEnabled: read && spotTrade && contractTrade && !withdraw && ips !== null && ips.length > 0 && accountLevelSupported,
  });
}

function permissions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, string[] | null> = {};
  for (const [key, group] of Object.entries(value as Record<string, unknown>)) {
    result[key] = group === null ? null : Array.isArray(group) ? group.filter((item): item is string => typeof item === "string") : null;
  }
  return result;
}

function permission(groups: Record<string, string[] | null> | null, names: string[], values: string[]) {
  if (!groups) return false;
  return names.some((name) => groups[name]?.some((value) => values.includes(value)) === true);
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

function executionStatus(status: string): BybitProviderOrder["status"] {
  if (status === "Filled") return "CONFIRMED";
  if (status === "New" || status === "Created" || status === "PartiallyFilled" || status === "Untriggered" || status === "Triggered") {
    return "PENDING_CONFIRMATION";
  }
  if (status === "Cancelled" || status === "Rejected" || status === "Deactivated" || status === "PartiallyFilledCanceled") {
    return "FAILED";
  }
  return "UNKNOWN";
}

function bybitCategory(value: unknown) {
  if (value !== "spot" && value !== "linear") throw new Error("Bybit category is invalid.");
  return value;
}

function providerSymbol(value: unknown) {
  const symbol = requiredString(value, "Bybit symbol").toUpperCase();
  if (!/^[A-Z0-9]{4,24}$/u.test(symbol)) throw new Error("Bybit symbol is invalid.");
  return symbol;
}

function exactOrderLinkId(value: unknown, label: string) {
  const id = requiredString(value, label);
  if (!/^[A-Za-z0-9_-]{1,36}$/u.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

function orderSide(value: unknown): "Buy" | "Sell" {
  if (value !== "Buy" && value !== "Sell") throw new Error("Bybit order side is invalid.");
  return value;
}

function positionIdx(value: unknown): 0 | 1 | 2 {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  if (numeric !== 0 && numeric !== 1 && numeric !== 2) throw new Error("Bybit positionIdx is invalid.");
  return numeric;
}

function marketUnit(value: unknown): "baseCoin" {
  if (value !== "baseCoin") throw new Error("Bybit marketUnit is invalid.");
  return value;
}

function normalizeCredentials(value: BybitCredentials) {
  return Object.freeze({
    apiKey: requiredString(value.apiKey, "Bybit apiKey"),
    apiSecret: requiredString(value.apiSecret, "Bybit apiSecret"),
  });
}

function authenticationCode(code: number) {
  return code === 10002 || code === 10003 || code === 10004 || code === 10005 || code === 33004;
}

export function safeBybitProviderMessage(category: string) {
  if (category === "credential_validation_failed") return "Bybit credential validation failed.";
  if (category === "provider_transport_error" || category === "provider_unavailable") {
    return "Bybit provider is currently unavailable.";
  }
  if (category === "provider_response_invalid") return "Bybit returned an invalid response.";
  if (category === "position_mode_unsupported") return "Bybit position mode is unsupported.";
  return "Bybit request was rejected.";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BybitProviderError("provider_response_invalid", `${label} is invalid.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new BybitProviderError("provider_response_invalid", `${label} is invalid.`);
  return value;
}

function requiredString(value: unknown, label: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 512) throw new BybitProviderError("provider_response_invalid", `${label} is invalid.`);
  return text;
}

function requiredIdentifier(value: unknown, label: string) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return requiredString(value, label);
}

function integer(value: unknown, label: string) {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric)) throw new BybitProviderError("provider_response_invalid", `${label} is invalid.`);
  return numeric;
}

function optionalInteger(value: unknown) {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) ? numeric : null;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalTimestamp(value: unknown) {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function decimalString(value: unknown, label: string) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) throw new BybitProviderError("provider_response_invalid", `${label} is invalid.`);
  return normalizeDecimal(text);
}

function positiveDecimalString(value: unknown, label: string) {
  const normalized = decimalString(value, label);
  if (normalized === "0") throw new Error(`${label} must be positive.`);
  return normalized;
}

function positiveOptionalDecimal(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  return positiveDecimalString(value, label);
}

function asset(value: unknown) {
  const text = requiredString(value, "Bybit asset").toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/u.test(text)) throw new Error("Bybit asset is invalid.");
  return text;
}

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

function unsignedDecimal(value: string, label: string): Decimal {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw new BybitProviderError("provider_response_invalid", `${label} is invalid.`);
  const [integer, fraction = ""] = value.split(".");
  return normalizeParsed({ coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length });
}

function addDecimal(left: string, right: Decimal) {
  const first = unsignedDecimal(left, "Bybit decimal");
  const scale = Math.max(first.scale, right.scale);
  return formatDecimal({
    coefficient: first.coefficient * 10n ** BigInt(scale - first.scale) + right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  });
}

function compareDecimal(left: Decimal, right: Decimal) {
  const scale = Math.max(left.scale, right.scale);
  const first = left.coefficient * 10n ** BigInt(scale - left.scale);
  const second = right.coefficient * 10n ** BigInt(scale - right.scale);
  return first < second ? -1 : first > second ? 1 : 0;
}

function subtractDecimal(left: Decimal, right: Decimal) {
  const scale = Math.max(left.scale, right.scale);
  return formatDecimal({
    coefficient: left.coefficient * 10n ** BigInt(scale - left.scale) - right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  });
}

function decimalEquals(left: string, right: string) {
  return normalizeDecimal(left) === normalizeDecimal(right);
}

function normalizeDecimal(value: string) {
  return formatDecimal(unsignedDecimal(value, "Bybit decimal"));
}

function normalizeParsed(value: Decimal): Decimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function formatDecimal(value: Decimal) {
  const normalized = normalizeParsed(value);
  if (normalized.scale === 0) return normalized.coefficient.toString();
  const digits = normalized.coefficient.toString().padStart(normalized.scale + 1, "0");
  return `${digits.slice(0, -normalized.scale)}.${digits.slice(-normalized.scale)}`;
}

function invalid(message: string): never {
  throw new Error(message);
}
