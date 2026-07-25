import { createHash, createHmac } from "node:crypto";
import {
  RWA_PERP_SYMBOL,
  RWA_SPOT_SYMBOL,
  RWA_STRATEGY_ID,
  type RwaBybitCredentials,
  type RwaBybitPermissions,
  type RwaBybitTradingClient,
  type RwaInstrumentSpec,
  type RwaProviderOrder,
  type RwaProviderOrderRequest,
  type RwaProviderPreflightSnapshot,
  type RwaStrategyPnlSnapshot,
  type RwaStrategyActivityContinuity,
} from "./RwaNeutralExecutionTypes";
import { scanBybitPositionAttribution } from "./RwaProviderActivityScanner";
import {
  buildPositionAttributionSnapshot,
  rejectNonAtomicAttribution,
} from "./RwaProviderActivityContinuity";

const bybitMainnetBaseUrl = "https://api.bybit.com";
const receiveWindow = "5000";

export class RwaBybitMainnetClient implements RwaBybitTradingClient {
  constructor(
    private readonly credentials: RwaBybitCredentials,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async validateAccess() {
    const result = record(await this.privateRequest("GET", "/v5/user/query-api"));
    const permissionsRoot = record(result.permissions);
    const contract = stringArray(permissionsRoot.ContractTrade);
    const spot = stringArray(permissionsRoot.Spot);
    const wallet = stringArray(permissionsRoot.Wallet);
    const ips = Array.isArray(result.ips)
      ? stringArray(result.ips)
      : String(result.ips ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const uid = String(result.userID ?? result.userId ?? result.uid ?? "").trim();
    const parentUid = String(result.parentUid ?? "").trim();
    if (!uid || !parentUid) {
      throw new RwaBybitProviderError("provider_permission_error", "Bybit 未返回可核对的专用子账户身份。");
    }
    const accountFingerprint = createHash("sha256")
      .update(`bybit:${parentUid}:${uid}`)
      .digest("hex")
      .slice(0, 16);
    const permissions: RwaBybitPermissions = {
      read: true,
      spotTrade: Number(result.readOnly) === 0 && spot.includes("SpotTrade"),
      contractTrade: Number(result.readOnly) === 0 && contract.includes("Order") && contract.includes("Position"),
      withdraw: wallet.some((permission) => /withdraw/i.test(permission)),
      uta: Number(result.uta) === 1,
      ipRestricted: ips.length > 0 && !ips.includes("*"),
      ownerSubaccount: Number(result.isMaster) === 0 && Number(result.parentUid) > 0,
    };
    return {
      permissions,
      accountMode: permissions.uta ? "uta" as const : "classic" as const,
      accountId: `bybit:${accountFingerprint}`,
      accountFingerprint,
    };
  }

  async readPreflightSnapshot(): Promise<RwaProviderPreflightSnapshot> {
    const [
      access,
      wallet,
      spotFee,
      perpFee,
      spotInstrument,
      perpInstrument,
      spotTicker,
      perpTicker,
      positions,
      spotOrders,
      perpetualOrders,
    ] = await Promise.all([
      this.validateAccess(),
      this.privateRequest("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED", coin: "USDT,XAUT" }),
      this.privateRequest("GET", "/v5/account/fee-rate", { category: "spot", symbol: RWA_SPOT_SYMBOL }),
      this.privateRequest("GET", "/v5/account/fee-rate", { category: "linear", symbol: RWA_PERP_SYMBOL }),
      this.publicRequest("/v5/market/instruments-info", { category: "spot", symbol: RWA_SPOT_SYMBOL }),
      this.publicRequest("/v5/market/instruments-info", { category: "linear", symbol: RWA_PERP_SYMBOL }),
      this.publicRequest("/v5/market/tickers", { category: "spot", symbol: RWA_SPOT_SYMBOL }),
      this.publicRequest("/v5/market/tickers", { category: "linear", symbol: RWA_PERP_SYMBOL }),
      this.privateRequest("GET", "/v5/position/list", { category: "linear", symbol: RWA_PERP_SYMBOL }),
      this.privateRequest("GET", "/v5/order/realtime", { category: "spot", symbol: RWA_SPOT_SYMBOL, openOnly: "0" }),
      this.privateRequest("GET", "/v5/order/realtime", { category: "linear", symbol: RWA_PERP_SYMBOL, openOnly: "0" }),
    ]);
    const spotInstrumentRow = firstListItem(spotInstrument);
    const perpInstrumentRow = firstListItem(perpInstrument);
    const spotTickerRow = firstListItem(spotTicker);
    const perpTickerRow = firstListItem(perpTicker);
    const walletAccount = firstListItem(wallet);
    const coins = list(walletAccount.coin).map(record);
    const usdt = coins.find((coin) => coin.coin === "USDT");
    const xaut = coins.find((coin) => coin.coin === "XAUT");
    const spotTotalXaut = xaut ? snapshotNonNegativeNumber(xaut.walletBalance, "现货余额") : 0;
    const spotLockedXaut = xaut ? snapshotNonNegativeNumber(xaut.locked, "现货锁定数量") : 0;
    if (spotLockedXaut > spotTotalXaut + 1e-12) {
      throw new RwaBybitProviderError("provider_snapshot_invalid", "Bybit XAUT 锁定数量超过总余额。");
    }
    const spotAvailableXaut = Math.max(0, spotTotalXaut - spotLockedXaut);
    const positionRow = list(record(positions).list).map(record).find((item) => item.symbol === RWA_PERP_SYMBOL);
    const positionSize = positionRow
      ? snapshotNonNegativeNumber(positionRow.size, "永续仓位数量")
      : 0;
    const position = positionSize > 0 ? positionRow : undefined;
    const positionSideValue = String(positionRow?.side ?? "");
    const perpetualPositionSide = positionSize <= 1e-12
      ? "flat" as const
      : positionSideValue === "Sell"
        ? "short" as const
        : positionSideValue === "Buy"
          ? "long" as const
          : (() => { throw new RwaBybitProviderError("provider_snapshot_invalid", "Bybit XAUT 永续方向无效。"); })();
    const mark = positiveNumber(perpTickerRow.markPrice);
    const liquidationPrice = positiveNumberOrNull(position?.liqPrice);
    const liquidationDistancePercent = liquidationPrice && mark
      ? Math.abs(mark - liquidationPrice) / mark * 100
      : null;
    return {
      accountId: access.accountId,
      accountFingerprint: access.accountFingerprint,
      fetchedAt: this.now(),
      accountMode: access.accountMode,
      permissions: access.permissions,
      availableUsdt: positiveNumber(usdt?.availableToWithdraw) || positiveNumber(walletAccount.totalAvailableBalance),
      existingSpotQuantityXaut: spotTotalXaut,
      spotAvailableQuantityXaut: spotAvailableXaut,
      spotLockedQuantityXaut: spotLockedXaut,
      existingPerpetualQuantityXaut: positionSize,
      perpetualPositionSide,
      openSpotOrderCount: list(record(spotOrders).list).length,
      openPerpetualOrderCount: list(record(perpetualOrders).list).length,
      spot: {
        ...spotSpec(spotInstrumentRow),
        bid: positiveNumber(spotTickerRow.bid1Price),
        ask: positiveNumber(spotTickerRow.ask1Price),
      },
      perpetual: {
        ...perpetualSpec(perpInstrumentRow),
        bid: positiveNumber(perpTickerRow.bid1Price),
        ask: positiveNumber(perpTickerRow.ask1Price),
        mark,
        fundingRate: number(perpTickerRow.fundingRate),
        fundingIntervalHours: Math.max(1, number(perpInstrumentRow.fundingInterval) / 60 || 4),
        liquidationDistancePercent,
      },
      fees: {
        spotTakerBps: number(firstListItem(spotFee).takerFeeRate) * 10_000,
        perpetualTakerBps: number(firstListItem(perpFee).takerFeeRate) * 10_000,
      },
    };
  }

  async setPerpetualLeverage(leverage: 1) {
    try {
      await this.privateRequest("POST", "/v5/position/set-leverage", {
        category: "linear",
        symbol: RWA_PERP_SYMBOL,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      });
    } catch (error) {
      if (!(error instanceof RwaBybitProviderError && error.providerCode === 110043)) throw error;
    }
  }

  async placeOrder(request: RwaProviderOrderRequest) {
    assertWhitelistedOrder(request);
    const result = record(await this.privateRequest("POST", "/v5/order/create", {
      category: request.category,
      symbol: request.symbol,
      side: request.side,
      orderType: "Limit",
      qty: decimal(request.quantityXaut),
      price: decimal(request.limitPrice),
      timeInForce: "IOC",
      reduceOnly: request.category === "linear" ? request.reduceOnly : undefined,
      orderLinkId: request.orderLinkId,
    }, 2_000));
    const orderId = String(result.orderId ?? "");
    if (!orderId) throw new RwaBybitProviderError("provider_rejected", "Bybit 未返回订单标识。");
    return { orderId, orderLinkId: String(result.orderLinkId ?? request.orderLinkId) };
  }

  async awaitOrder(category: "spot" | "linear", orderId: string, deadlineAt: number): Promise<RwaProviderOrder> {
    while (this.now() < deadlineAt) {
      const order = await this.readOrder(category, orderId);
      if (order && ["Filled", "Cancelled", "Rejected"].includes(order.status)) return order;
      await delay(Math.min(250, Math.max(1, deadlineAt - this.now())));
    }
    const finalOrder = await this.readOrder(category, orderId);
    if (finalOrder) return finalOrder;
    throw new RwaBybitProviderError("provider_timeout", "订单权威状态确认超时。");
  }

  async cancelOrder(category: "spot" | "linear", orderId: string) {
    await this.privateRequest("POST", "/v5/order/cancel", { category, symbol: RWA_SPOT_SYMBOL, orderId }, 2_000);
  }

  async cancelStrategyOrders(orderLinkPrefix: string) {
    for (const category of ["spot", "linear"] as const) {
      const result = await this.privateRequest("GET", "/v5/order/realtime", { category, symbol: RWA_SPOT_SYMBOL, openOnly: "0" });
      for (const item of list(record(result).list).map(record)) {
        if (!String(item.orderLinkId ?? "").startsWith(orderLinkPrefix)) continue;
        const orderId = String(item.orderId ?? "");
        if (orderId) await this.cancelOrder(category, orderId);
      }
    }
  }

  async readPositionAttribution(input: {
    strategyOrderPrefix: string;
    strategyOrderPrefixes: string[];
    since: number;
    continuity: RwaStrategyActivityContinuity;
  }) {
    const checkedThrough = this.now();
    try {
      const api = record(await this.privateRequest("GET", "/v5/user/query-api"));
      if (Number(api.uta) !== 1 || Number(api.isMaster) !== 0 || Number(api.parentUid) <= 0) {
        return buildPositionAttributionSnapshot({
          since: input.since,
          checkedThrough,
          sources: [],
        });
      }
    } catch {
      return buildPositionAttributionSnapshot({
        since: input.since,
        checkedThrough,
        sources: [],
      });
    }
    const scanned = await scanBybitPositionAttribution(
      (path, params) => this.privateRequest("GET", path, params),
      { ...input, checkedThrough },
    );
    return rejectNonAtomicAttribution(scanned);
  }

  async readStrategyPnl(orderLinkPrefix: string | null, since: number | null): Promise<RwaStrategyPnlSnapshot> {
    const startTime = since ?? this.now() - 7 * 24 * 60 * 60 * 1000;
    const [access, spotExecutions, perpExecutions, spotTicker, perpTicker, openSpot, openPerp, transactions] = await Promise.all([
      this.validateAccess(),
      this.privateRequest("GET", "/v5/execution/list", { category: "spot", symbol: RWA_SPOT_SYMBOL, startTime: String(startTime), limit: "100" }),
      this.privateRequest("GET", "/v5/execution/list", { category: "linear", symbol: RWA_PERP_SYMBOL, startTime: String(startTime), limit: "100" }),
      this.publicRequest("/v5/market/tickers", { category: "spot", symbol: RWA_SPOT_SYMBOL }),
      this.publicRequest("/v5/market/tickers", { category: "linear", symbol: RWA_PERP_SYMBOL }),
      this.privateRequest("GET", "/v5/order/realtime", { category: "spot", symbol: RWA_SPOT_SYMBOL, openOnly: "0" }),
      this.privateRequest("GET", "/v5/order/realtime", { category: "linear", symbol: RWA_PERP_SYMBOL, openOnly: "0" }),
      this.privateRequest("GET", "/v5/account/transaction-log", { accountType: "UNIFIED", category: "linear", currency: "USDT", startTime: String(startTime), limit: "50" }),
    ]);
    const filter = (item: Record<string, unknown>) => !orderLinkPrefix || String(item.orderLinkId ?? "").startsWith(orderLinkPrefix);
    const spotFills = list(record(spotExecutions).list).map(record).filter(filter);
    const perpFills = list(record(perpExecutions).list).map(record).filter(filter);
    const spotLedger = calculateLegLedger(spotFills, "Buy", "Sell");
    const perpLedger = calculateLegLedger(perpFills, "Sell", "Buy");
    const spotMark = positiveNumber(firstListItem(spotTicker).lastPrice);
    const perpMark = positiveNumber(firstListItem(perpTicker).markPrice);
    const spotUnrealized = spotLedger.quantity * (spotMark - spotLedger.averageEntryPrice);
    const perpUnrealized = perpLedger.quantity * (perpLedger.averageEntryPrice - perpMark);
    const allFills = [...spotFills, ...perpFills];
    const feesUsd = allFills.reduce((sum, fill) => sum + Math.abs(number(fill.execFee)), 0);
    const fundingPnlUsd = list(record(transactions).list).map(record)
      .filter((item) => item.symbol === RWA_PERP_SYMBOL && /funding|settlement/i.test(String(item.type ?? "")))
      .reduce((sum, item) => sum + number(item.cashFlow ?? item.change), 0);
    const openOrders = [...list(record(openSpot).list), ...list(record(openPerp).list)]
      .map(record)
      .filter(filter)
      .filter((item) => ["New", "PartiallyFilled"].includes(String(item.orderStatus ?? "")))
      .map(toOrder);
    const spotNotional = spotLedger.quantity * spotMark;
    const perpNotional = perpLedger.quantity * perpMark;
    const realizedPnlUsd = spotLedger.realizedPnl + perpLedger.realizedPnl;
    const unrealizedPnlUsd = spotUnrealized + perpUnrealized;
    return {
      accountId: access.accountId,
      accountFingerprint: access.accountFingerprint,
      strategyId: RWA_STRATEGY_ID,
      capturedAt: this.now(),
      legs: {
        spot: {
          kind: "spot_long",
          quantityXaut: spotLedger.quantity,
          averageEntryPrice: nullablePositive(spotLedger.averageEntryPrice),
          markPrice: nullablePositive(spotMark),
          notionalUsd: spotNotional,
          realizedPnlUsd: spotLedger.realizedPnl,
          unrealizedPnlUsd: spotUnrealized,
        },
        perpetual: {
          kind: "perpetual_short",
          quantityXaut: perpLedger.quantity,
          averageEntryPrice: nullablePositive(perpLedger.averageEntryPrice),
          markPrice: nullablePositive(perpMark),
          notionalUsd: perpNotional,
          realizedPnlUsd: perpLedger.realizedPnl,
          unrealizedPnlUsd: perpUnrealized,
        },
      },
      netDeltaXaut: spotLedger.quantity - perpLedger.quantity,
      netDeltaUsd: spotNotional - perpNotional,
      entryBasisBps: basisBps(spotLedger.averageEntryPrice, perpLedger.averageEntryPrice),
      currentBasisBps: basisBps(spotMark, perpMark),
      realizedPnlUsd,
      unrealizedPnlUsd,
      fundingPnlUsd,
      feesUsd,
      slippageUsd: 0,
      netPnlUsd: realizedPnlUsd + unrealizedPnlUsd + fundingPnlUsd - feesUsd,
      openOrders,
    };
  }

  private async readOrder(category: "spot" | "linear", orderId: string) {
    for (const endpoint of ["/v5/order/realtime", "/v5/order/history"] as const) {
      const result = await this.privateRequest("GET", endpoint, { category, symbol: RWA_SPOT_SYMBOL, orderId, limit: "1" }, 2_000);
      const item = firstListItemOrNull(result);
      if (item) return toOrder(item);
    }
    return null;
  }

  private async publicRequest(path: string, query: Record<string, string>) {
    const url = new URL(path, bybitMainnetBaseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return this.parseResponse(await this.fetchFn(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    }));
  }

  private async privateRequest(method: "GET" | "POST", path: string, input: Record<string, unknown> = {}, timeoutMs = 5_000) {
    const timestamp = String(this.now());
    const url = new URL(path, bybitMainnetBaseUrl);
    const body = method === "POST" ? JSON.stringify(definedEntries(input)) : "";
    if (method === "GET") {
      for (const [key, value] of Object.entries(definedEntries(input))) url.searchParams.set(key, String(value));
    }
    const payload = method === "GET" ? url.searchParams.toString() : body;
    const signature = createHmac("sha256", this.credentials.apiSecret)
      .update(`${timestamp}${this.credentials.apiKey}${receiveWindow}${payload}`)
      .digest("hex");
    const response = await this.fetchFn(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": this.credentials.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": receiveWindow,
        "X-BAPI-SIGN": signature,
      },
      body: method === "POST" ? body : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.parseResponse(response);
  }

  private async parseResponse(response: Response) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RwaBybitProviderError("provider_invalid_response", "Bybit 返回了无法解析的响应。");
    }
    const root = record(payload);
    const code = Number(root.retCode ?? -1);
    if (!response.ok || code !== 0) {
      const category = response.status === 429 || code === 10006
        ? "provider_rate_limited"
        : code === 33004 ? "provider_credential_expired"
          : [10003, 10007].includes(code) ? "provider_credential_revoked"
            : [10004, 10005].includes(code) ? "provider_permission_error" : "provider_rejected";
      throw new RwaBybitProviderError(category, `Bybit 请求失败（code=${Number.isFinite(code) ? code : "unknown"}）。`, code);
    }
    return root.result;
  }
}

export class RwaBybitProviderError extends Error {
  constructor(readonly category: string, message: string, readonly providerCode: number | null = null) {
    super(message);
  }
}

function assertWhitelistedOrder(request: RwaProviderOrderRequest) {
  if (request.symbol !== RWA_SPOT_SYMBOL || !["spot", "linear"].includes(request.category)) {
    throw new Error("真实执行只允许 Bybit XAUTUSDT 白名单现货与永续对冲组合。");
  }
  if (!(request.quantityXaut > 0 && request.quantityXaut <= 0.1) || !(request.limitPrice > 0)) {
    throw new Error("真实执行订单参数超出白名单。");
  }
  if (request.category === "spot" && request.reduceOnly) throw new Error("现货订单不允许 reduceOnly。");
}

function spotSpec(row: Record<string, unknown>): RwaInstrumentSpec {
  const lot = record(row.lotSizeFilter);
  const price = record(row.priceFilter);
  return {
    status: normalizeStatus(row.status),
    minOrderQty: positiveNumber(lot.basePrecision),
    qtyStep: positiveNumber(lot.basePrecision),
    minNotionalUsd: positiveNumber(lot.minOrderAmt),
    priceTick: positiveNumber(price.tickSize),
  };
}

function perpetualSpec(row: Record<string, unknown>): RwaInstrumentSpec {
  const lot = record(row.lotSizeFilter);
  const price = record(row.priceFilter);
  return {
    status: normalizeStatus(row.status),
    minOrderQty: positiveNumber(lot.minOrderQty),
    qtyStep: positiveNumber(lot.qtyStep),
    minNotionalUsd: positiveNumber(lot.minNotionalValue),
    priceTick: positiveNumber(price.tickSize),
  };
}

function normalizeStatus(value: unknown): RwaInstrumentSpec["status"] {
  return value === "Trading" ? "Trading" : value === "Paused" ? "Paused" : "Unknown";
}

function snapshotNonNegativeNumber(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new RwaBybitProviderError("provider_snapshot_invalid", `Bybit ${label}无效。`);
  }
  return parsed;
}

function calculateLegLedger(fills: Record<string, unknown>[], openSide: "Buy" | "Sell", closeSide: "Buy" | "Sell") {
  let quantity = 0;
  let averageEntryPrice = 0;
  let realizedPnl = 0;
  for (const fill of [...fills].sort((left, right) => number(left.execTime) - number(right.execTime))) {
    const side = String(fill.side ?? "");
    const fillQuantity = positiveNumber(fill.execQty);
    const price = positiveNumber(fill.execPrice);
    if (!fillQuantity || !price) continue;
    if (side === openSide) {
      averageEntryPrice = quantity + fillQuantity > 0
        ? (averageEntryPrice * quantity + price * fillQuantity) / (quantity + fillQuantity)
        : 0;
      quantity += fillQuantity;
    } else if (side === closeSide && quantity > 0) {
      const closed = Math.min(quantity, fillQuantity);
      realizedPnl += openSide === "Buy"
        ? (price - averageEntryPrice) * closed
        : (averageEntryPrice - price) * closed;
      quantity -= closed;
      if (quantity <= 1e-12) {
        quantity = 0;
        averageEntryPrice = 0;
      }
    }
  }
  return { quantity, averageEntryPrice, realizedPnl };
}

function toOrder(value: unknown): RwaProviderOrder {
  const row = record(value);
  const requested = number(row.qty);
  const filled = number(row.cumExecQty ?? row.execQty);
  const status = String(row.orderStatus ?? "Unknown");
  return {
    orderId: String(row.orderId ?? ""),
    orderLinkId: String(row.orderLinkId ?? ""),
    status: (["New", "PartiallyFilled", "Filled", "Cancelled", "Rejected"] as const).find((item) => item === status) ?? "Unknown",
    requestedQuantityXaut: requested,
    filledQuantityXaut: filled,
    averagePrice: positiveNumberOrNull(row.avgPrice ?? row.execPrice),
    feeUsd: Math.abs(number(row.cumExecFee ?? row.execFee)),
    updatedAt: number(row.updatedTime ?? row.execTime),
  };
}

function firstListItem(value: unknown) {
  return firstListItemOrNull(value) ?? {};
}

function firstListItemOrNull(value: unknown) {
  const items = list(record(value).list);
  return items.length ? record(items[0]) : null;
}

function basisBps(spot: number, perp: number) {
  return spot > 0 && perp > 0 ? (perp - spot) / spot * 10_000 : null;
}

function nullablePositive(value: number) {
  return value > 0 ? value : null;
}

function positiveNumber(value: unknown) {
  const parsed = number(value);
  return parsed > 0 ? parsed : 0;
}

function positiveNumberOrNull(value: unknown) {
  const parsed = positiveNumber(value);
  return parsed || null;
}

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimal(value: number) {
  return value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

function definedEntries(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
