import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import {
  BINANCE_PERPETUAL_SYMBOL,
  BINANCE_PRODUCT_CACHE_TTL_MS,
  BINANCE_SPOT_SYMBOL,
  BINANCE_STRATEGY_ID,
  type BinanceAccountIdentity,
  type BinanceClientAdapter,
  type BinanceCredentials,
  type BinanceInstrumentSpec,
  type BinanceOrderRequest,
  type BinancePermissions,
  type BinancePreflightSnapshot,
  type BinanceProductAvailability,
  type BinanceProviderOrder,
  type BinanceStrategyPnlSnapshot,
} from "./BinanceTypes";

const spotBaseUrl = "https://api.binance.com";
const futuresBaseUrl = "https://fapi.binance.com";
const receiveWindow = "5000";
const timeOffsetTtlMs = 30_000;

type ProductCache = {
  availability: BinanceProductAvailability;
  spot: BinanceInstrumentSpec & { quantityPrecision: number };
  perpetual: BinanceInstrumentSpec & { quantityPrecision: number };
};

export class BinanceClient implements BinanceClientAdapter {
  private timeOffset: { value: number; expiresAt: number } | null = null;
  private timeOffsetInFlight: Promise<number> | null = null;
  private productCache: { value: ProductCache; expiresAt: number } | null = null;
  private productInFlight: Promise<ProductCache> | null = null;

  constructor(
    private readonly credentials: BinanceCredentials,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly allowedEgressIps: readonly string[] | null = configuredBinanceEgressIps(),
  ) {}

  async validateAccess() {
    const configuredEgressIps = requireConfiguredEgressIps(this.allowedEgressIps);
    const [restrictionsValue, spotAccountValue, futuresAccountValue, positionModeValue] = await Promise.all([
      this.signedRequest("spot", "/sapi/v1/account/apiRestrictions"),
      this.signedRequest("spot", "/api/v3/account", { omitZeroBalances: "true" }),
      this.signedRequest("futures", "/fapi/v2/account"),
      this.signedRequest("futures", "/fapi/v1/positionSide/dual"),
    ]);
    const restrictions = record(restrictionsValue);
    const ipWhitelistVerificationMode = assertProviderIpWhitelist(restrictions, configuredEgressIps);
    const spotAccount = record(spotAccountValue);
    const futuresAccount = record(futuresAccountValue);
    const positionMode = record(positionModeValue);
    const uid = String(spotAccount.uid ?? "").trim();
    if (!uid) {
      throw new BinanceProviderError("provider_identity_unavailable", "Binance 未返回可核对的账户 UID。");
    }
    const dualSidePosition = boolean(positionMode.dualSidePosition);
    const multiAssetsMargin = boolean(futuresAccount.multiAssetsMargin);
    const accountMode: BinanceAccountIdentity["accountMode"] = multiAssetsMargin
      ? dualSidePosition ? "multi_assets_hedge" : "multi_assets_one_way"
      : dualSidePosition ? "single_asset_hedge" : "single_asset_one_way";
    const permissions: BinancePermissions = {
      read: boolean(restrictions.enableReading),
      spotTrade: boolean(restrictions.enableSpotAndMarginTrading) && boolean(spotAccount.canTrade),
      contractTrade: boolean(restrictions.enableFutures) && boolean(futuresAccount.canTrade),
      withdraw: boolean(restrictions.enableWithdrawals),
      ipRestricted: true,
      spotAccount: true,
      futuresAccount: true,
      positionModeSupported: !dualSidePosition,
    };
    const uidSnapshot = createHash("sha256")
      .update(`binance:${uid}`)
      .digest("hex");
    const accountFingerprint = uidSnapshot.slice(0, 16);
    const accountId = `binance:${accountFingerprint}`;
    return {
      accountId,
      accountFingerprint,
      uidSnapshot,
      accountMode,
      ipWhitelistVerificationMode,
      permissions,
    };
  }

  async readProductAvailability() {
    return (await this.loadProducts()).availability;
  }

  async readPreflightSnapshot(): Promise<BinancePreflightSnapshot> {
    const products = await this.loadProducts();
    if (!products.availability.available) {
      throw new BinanceProviderError("provider_product_unavailable", products.availability.message ?? "Binance XAUT 现货与永续对冲组合不可用。");
    }
    const [
      access,
      spotAccountValue,
      futuresAccountValue,
      positionModeValue,
      spotFeeValue,
      futuresFeeValue,
      positionRiskValue,
      spotOrdersValue,
      futuresOrdersValue,
      spotBookValue,
      futuresBookValue,
      premiumValue,
      fundingInfoValue,
      spotDepthValue,
      futuresDepthValue,
    ] = await Promise.all([
      this.validateAccess(),
      this.signedRequest("spot", "/api/v3/account"),
      this.signedRequest("futures", "/fapi/v2/account"),
      this.signedRequest("futures", "/fapi/v1/positionSide/dual"),
      this.signedRequest("spot", "/sapi/v1/asset/tradeFee", { symbol: BINANCE_SPOT_SYMBOL }),
      this.signedRequest("futures", "/fapi/v1/commissionRate", { symbol: BINANCE_PERPETUAL_SYMBOL }),
      this.signedRequest("futures", "/fapi/v2/positionRisk", { symbol: BINANCE_PERPETUAL_SYMBOL }),
      this.signedRequest("spot", "/api/v3/openOrders", { symbol: BINANCE_SPOT_SYMBOL }),
      this.signedRequest("futures", "/fapi/v1/openOrders", { symbol: BINANCE_PERPETUAL_SYMBOL }),
      this.publicRequest("spot", "/api/v3/ticker/bookTicker", { symbol: BINANCE_SPOT_SYMBOL }),
      this.publicRequest("futures", "/fapi/v1/ticker/bookTicker", { symbol: BINANCE_PERPETUAL_SYMBOL }),
      this.publicRequest("futures", "/fapi/v1/premiumIndex", { symbol: BINANCE_PERPETUAL_SYMBOL }),
      this.publicRequest("futures", "/fapi/v1/fundingInfo"),
      this.publicRequest("spot", "/api/v3/depth", { symbol: BINANCE_SPOT_SYMBOL, limit: "20" }),
      this.publicRequest("futures", "/fapi/v1/depth", { symbol: BINANCE_PERPETUAL_SYMBOL, limit: "20" }),
    ]);
    const spotAccount = record(spotAccountValue);
    const futuresAccount = record(futuresAccountValue);
    const positionMode = record(positionModeValue);
    const spotBook = record(spotBookValue);
    const futuresBook = record(futuresBookValue);
    const premium = record(premiumValue);
    const positionRow = list(positionRiskValue)
      .map(record)
      .find((item) => item.symbol === BINANCE_PERPETUAL_SYMBOL);
    const positionAmount = positionRow
      ? snapshotFiniteNumber(positionRow.positionAmt, "永续仓位数量")
      : 0;
    const leverage = positionRow
      ? snapshotPositiveInteger(positionRow.leverage, "永续杠杆")
      : null;
    const position = Math.abs(positionAmount) > 0 ? positionRow : undefined;
    const spotBalances = list(spotAccount.balances).map(record);
    const usdt = spotBalances.find((item) => item.asset === "USDT");
    const xaut = spotBalances.find((item) => item.asset === "XAUT");
    const spotFreeXaut = xaut ? snapshotNonNegativeNumber(xaut.free, "现货可用数量") : 0;
    const spotLockedXaut = xaut ? snapshotNonNegativeNumber(xaut.locked, "现货锁定数量") : 0;
    const perpetualPositionSide = positionAmount > 0
      ? "long" as const
      : positionAmount < 0
        ? "short" as const
        : "flat" as const;
    const futuresUsdt = list(futuresAccount.assets).map(record).find((item) => item.asset === "USDT");
    const fundingInfo = list(fundingInfoValue).map(record).find((item) => item.symbol === BINANCE_PERPETUAL_SYMBOL);
    const spotBid = positiveNumber(spotBook.bidPrice);
    const spotAsk = positiveNumber(spotBook.askPrice);
    const perpetualBid = positiveNumber(futuresBook.bidPrice);
    const perpetualAsk = positiveNumber(futuresBook.askPrice);
    const mark = positiveNumber(premium.markPrice);
    const liquidationPrice = positiveNumberOrNull(position?.liquidationPrice);
    const liquidationDistancePercent = liquidationPrice && mark
      ? Math.abs(mark - liquidationPrice) / mark * 100
      : null;
    const dualSidePosition = boolean(positionMode.dualSidePosition);
    const multiAssetsMargin = boolean(futuresAccount.multiAssetsMargin);
    const accountMode: BinanceAccountIdentity["accountMode"] = multiAssetsMargin
      ? dualSidePosition ? "multi_assets_hedge" : "multi_assets_one_way"
      : dualSidePosition ? "single_asset_hedge" : "single_asset_one_way";
    return {
      accountId: access.accountId,
      accountFingerprint: access.accountFingerprint,
      uidSnapshot: access.uidSnapshot,
      fetchedAt: this.now(),
      accountMode,
      permissions: { ...access.permissions, positionModeSupported: !dualSidePosition },
      productAvailability: products.availability,
      spotAvailableUsdt: positiveNumber(usdt?.free),
      futuresAvailableUsdt: positiveNumber(futuresUsdt?.availableBalance ?? futuresAccount.availableBalance),
      spotFreeXaut,
      spotLockedXaut,
      availableUsdt: positiveNumber(usdt?.free) + positiveNumber(futuresUsdt?.availableBalance ?? futuresAccount.availableBalance),
      existingSpotQuantityXaut: spotFreeXaut + spotLockedXaut,
      spotAvailableQuantityXaut: spotFreeXaut,
      spotLockedQuantityXaut: spotLockedXaut,
      existingPerpetualQuantityXaut: Math.abs(positionAmount),
      perpetualPositionSide,
      openSpotOrderCount: list(spotOrdersValue).length,
      openPerpetualOrderCount: list(futuresOrdersValue).length,
      spot: {
        ...products.spot,
        bid: spotBid,
        ask: spotAsk,
        depthUsd: depthUsd(spotDepthValue),
      },
      perpetual: {
        ...products.perpetual,
        leverage,
        bid: perpetualBid,
        ask: perpetualAsk,
        depthUsd: depthUsd(futuresDepthValue),
        mark,
        fundingRate: number(premium.lastFundingRate),
        fundingIntervalHours: positiveNumber(fundingInfo?.fundingIntervalHours) || 8,
        nextFundingTime: nullableTimestamp(premium.nextFundingTime),
        liquidationDistancePercent,
      },
      fees: {
        spotTakerBps: number(record(list(spotFeeValue)[0]).takerCommission) * 10_000,
        perpetualTakerBps: number(record(futuresFeeValue).takerCommissionRate) * 10_000,
      },
    };
  }

  async findOrderByClientOrderId(category: "spot" | "linear", orderLinkId: string) {
    const scope = category === "spot" ? "spot" : "futures";
    const path = category === "spot" ? "/api/v3/order" : "/fapi/v1/order";
    const symbol = category === "spot"
      ? BINANCE_SPOT_SYMBOL
      : BINANCE_PERPETUAL_SYMBOL;
    try {
      const found = toOrder(await this.signedRequest(scope, path, {
        symbol,
        origClientOrderId: orderLinkId,
      }), category);
      return this.readOrder(category, found.orderId);
    } catch (error) {
      if (error instanceof BinanceProviderError && error.providerCode === -2013) return null;
      throw error;
    }
  }

  async setPerpetualLeverage(leverage: 1 | 2 | 3) {
    await this.signedRequest(
      "futures",
      "/fapi/v1/leverage",
      { symbol: BINANCE_PERPETUAL_SYMBOL, leverage: String(leverage) },
      true,
      "POST",
    );
  }

  async placeOrder(request: BinanceOrderRequest) {
    return this.submitOrder(request, "IOC");
  }

  async placeTestOrder(request: BinanceOrderRequest) {
    return this.submitOrder(request, "GTC");
  }

  private async submitOrder(request: BinanceOrderRequest, timeInForce: "IOC" | "GTC") {
    assertWhitelistedOrder(request);
    const scope = request.category === "spot" ? "spot" : "futures";
    const path = request.category === "spot" ? "/api/v3/order" : "/fapi/v1/order";
    const result = record(await this.signedRequest(scope, path, {
      symbol: request.symbol,
      side: request.side.toUpperCase(),
      type: "LIMIT",
      timeInForce,
      quantity: decimal(request.quantityXaut),
      price: decimal(request.limitPrice),
      newClientOrderId: request.orderLinkId,
      ...(request.category === "linear" ? { reduceOnly: String(request.reduceOnly) } : {}),
    }, true, "POST"));
    const orderId = String(result.orderId ?? "");
    const orderLinkId = String(result.clientOrderId ?? request.orderLinkId);
    if (!orderId || orderLinkId !== request.orderLinkId) {
      throw new BinanceProviderError("provider_rejected", "Binance 未返回可核对的策略订单标识。");
    }
    return { orderId, orderLinkId };
  }

  async awaitOrder(category: "spot" | "linear", orderId: string, deadlineAt: number): Promise<BinanceProviderOrder> {
    while (this.now() < deadlineAt) {
      const order = await this.readOrder(category, orderId);
      if (["Filled", "Cancelled", "Rejected"].includes(order.status)) return order;
      await delay(Math.min(250, Math.max(1, deadlineAt - this.now())));
    }
    return this.readOrder(category, orderId).catch(() => {
      throw new BinanceProviderError("provider_timeout", "Binance 订单权威状态确认超时。");
    });
  }

  async cancelOrder(category: "spot" | "linear", orderId: string) {
    const symbol = category === "spot"
      ? BINANCE_SPOT_SYMBOL
      : BINANCE_PERPETUAL_SYMBOL;
    await this.signedRequest(
      category === "spot" ? "spot" : "futures",
      category === "spot" ? "/api/v3/order" : "/fapi/v1/order",
      { symbol, orderId },
      true,
      "DELETE",
    );
  }

  async cancelStrategyOrders(orderLinkPrefix: string) {
    for (const order of await this.listAssetOpenOrders()) {
      if (!order.clientOrderId.startsWith(orderLinkPrefix)) continue;
      await this.cancelOrder(order.category, order.orderId);
    }
  }

  async listAssetOpenOrders() {
    const [spot, linear] = await Promise.all([
      this.signedRequest("spot", "/api/v3/openOrders", { symbol: BINANCE_SPOT_SYMBOL }),
      this.signedRequest("futures", "/fapi/v1/openOrders", { symbol: BINANCE_PERPETUAL_SYMBOL }),
    ]);
    return ([
      ...list(spot).map((value) => ({ category: "spot" as const, value: record(value) })),
      ...list(linear).map((value) => ({ category: "linear" as const, value: record(value) })),
    ]).map(({ category, value }) => {
      const symbol = String(value.symbol ?? "");
      const orderId = String(value.orderId ?? "");
      if (
        !orderId
        || symbol !== (category === "spot" ? BINANCE_SPOT_SYMBOL : BINANCE_PERPETUAL_SYMBOL)
      ) {
        throw new BinanceProviderError("provider_snapshot_invalid", "Binance XAUT 活动订单结构无效。");
      }
      return {
        category,
        orderId,
        clientOrderId: String(value.clientOrderId ?? ""),
        symbol,
      };
    });
  }

  async readStrategyPnl(orderLinkPrefix: string | null, since: number | null): Promise<BinanceStrategyPnlSnapshot> {
    const startTime = since ?? this.now() - 7 * 24 * 60 * 60 * 1_000;
    const [
      access,
      spotOrdersValue,
      futuresOrdersValue,
      spotTradesValue,
      futuresTradesValue,
      spotOpenValue,
      futuresOpenValue,
      fundingValue,
      spotBookValue,
      premiumValue,
    ] = await Promise.all([
      this.validateAccess(),
      this.signedRequest("spot", "/api/v3/allOrders", { symbol: BINANCE_SPOT_SYMBOL, startTime: String(startTime), limit: "1000" }),
      this.signedRequest("futures", "/fapi/v1/allOrders", { symbol: BINANCE_PERPETUAL_SYMBOL, startTime: String(startTime), limit: "1000" }),
      this.signedRequest("spot", "/api/v3/myTrades", { symbol: BINANCE_SPOT_SYMBOL, startTime: String(startTime), limit: "1000" }),
      this.signedRequest("futures", "/fapi/v1/userTrades", { symbol: BINANCE_PERPETUAL_SYMBOL, startTime: String(startTime), limit: "1000" }),
      this.signedRequest("spot", "/api/v3/openOrders", { symbol: BINANCE_SPOT_SYMBOL }),
      this.signedRequest("futures", "/fapi/v1/openOrders", { symbol: BINANCE_PERPETUAL_SYMBOL }),
      this.signedRequest("futures", "/fapi/v1/income", { symbol: BINANCE_PERPETUAL_SYMBOL, incomeType: "FUNDING_FEE", startTime: String(startTime), limit: "1000" }),
      this.publicRequest("spot", "/api/v3/ticker/bookTicker", { symbol: BINANCE_SPOT_SYMBOL }),
      this.publicRequest("futures", "/fapi/v1/premiumIndex", { symbol: BINANCE_PERPETUAL_SYMBOL }),
    ]);
    const matches = (order: Record<string, unknown>) => !orderLinkPrefix
      || String(order.clientOrderId ?? "").startsWith(orderLinkPrefix);
    const spotOrders = list(spotOrdersValue).map(record).filter(matches);
    const futuresOrders = list(futuresOrdersValue).map(record).filter(matches);
    const spotOrderIds = new Set(spotOrders.map((order) => String(order.orderId ?? "")));
    const futuresOrderIds = new Set(futuresOrders.map((order) => String(order.orderId ?? "")));
    const spotTrades = list(spotTradesValue).map(record).filter((trade) => spotOrderIds.has(String(trade.orderId ?? "")));
    const futuresTrades = list(futuresTradesValue).map(record).filter((trade) => futuresOrderIds.has(String(trade.orderId ?? "")));
    const spotFills = spotTrades.map((trade) => ({
      side: boolean(trade.isBuyer) ? "Buy" : "Sell",
      quantity: positiveNumber(trade.qty),
      price: positiveNumber(trade.price),
      time: number(trade.time),
    }));
    const futuresFills = futuresTrades.map((trade) => ({
      side: String(trade.side ?? "").toUpperCase() === "SELL" ? "Sell" : "Buy",
      quantity: positiveNumber(trade.qty),
      price: positiveNumber(trade.price),
      time: number(trade.time),
    }));
    const spotLedger = calculateSideLedger(spotFills, "Buy", "Sell");
    const perpetualLedger = calculateSideLedger(futuresFills, "Sell", "Buy");
    const spotMark = positiveNumber(record(spotBookValue).bidPrice);
    const perpetualMark = positiveNumber(record(premiumValue).markPrice);
    const spotUnrealized = spotLedger.quantity * (spotMark - spotLedger.averageEntryPrice);
    const perpetualUnrealized = perpetualLedger.quantity * (perpetualLedger.averageEntryPrice - perpetualMark);
    const feesUsd = spotTrades.reduce((sum, trade) => sum + commissionUsd(trade), 0)
      + futuresTrades.reduce((sum, trade) => sum + Math.abs(number(trade.commission)), 0);
    const fundingPnlUsd = list(fundingValue).map(record)
      .filter((item) => !orderLinkPrefix || futuresOrders.length > 0)
      .reduce((sum, item) => sum + number(item.income), 0);
    const openOrders = [
      ...list(spotOpenValue).map((item) => toOrder(item, "spot")),
      ...list(futuresOpenValue).map((item) => toOrder(item, "linear")),
    ].filter((order) => !orderLinkPrefix || order.orderLinkId.startsWith(orderLinkPrefix));
    const spotNotional = spotLedger.quantity * spotMark;
    const perpetualNotional = perpetualLedger.quantity * perpetualMark;
    const realizedPnlUsd = spotLedger.realizedPnl + perpetualLedger.realizedPnl;
    const unrealizedPnlUsd = spotUnrealized + perpetualUnrealized;
    return {
      accountId: access.accountId,
      accountFingerprint: access.accountFingerprint,
      strategyId: BINANCE_STRATEGY_ID,
      capturedAt: this.now(),
      legs: {
        spot: sideSnapshot("spot_long", spotLedger, spotMark, spotNotional, spotUnrealized),
        perpetual: sideSnapshot("perpetual_short", perpetualLedger, perpetualMark, perpetualNotional, perpetualUnrealized),
      },
      netDeltaXaut: spotLedger.quantity - perpetualLedger.quantity,
      netDeltaUsd: spotNotional - perpetualNotional,
      entryBasisBps: basisBps(spotLedger.averageEntryPrice, perpetualLedger.averageEntryPrice),
      currentBasisBps: basisBps(spotMark, perpetualMark),
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
    const scope = category === "spot" ? "spot" : "futures";
    const path = category === "spot" ? "/api/v3/order" : "/fapi/v1/order";
    const value = await this.signedRequest(scope, path, { symbol: BINANCE_SPOT_SYMBOL, orderId });
    if (category === "linear") return toOrder(value, category);
    const row = record(value);
    const filled = snapshotNonNegativeNumber(row.executedQty, "现货成交数量");
    if (!(filled > 0)) return toOrder(value, category, 0);
    const side = String(row.side ?? "").toUpperCase();
    if (!["BUY", "SELL"].includes(side)) {
      throw new BinanceProviderError("provider_snapshot_invalid", "Binance 现货订单方向无效。");
    }
    const trades = list(await this.signedRequest("spot", "/api/v3/myTrades", {
      symbol: BINANCE_SPOT_SYMBOL,
      orderId,
    })).map(record);
    const baseFee = trades
      .filter((trade) => String(trade.orderId ?? "") === orderId && trade.commissionAsset === "XAUT")
      .reduce((total, trade) => total + snapshotNonNegativeNumber(trade.commission, "现货基础资产手续费"), 0);
    const positionQuantityXaut = side === "BUY"
      ? Math.max(0, filled - baseFee)
      : filled + baseFee;
    return toOrder(value, category, positionQuantityXaut);
  }

  private async loadProducts() {
    const cached = this.productCache;
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (this.productInFlight) return this.productInFlight;
    const request = this.fetchProducts().then((value) => {
      this.productCache = { value, expiresAt: this.now() + BINANCE_PRODUCT_CACHE_TTL_MS };
      return value;
    }).finally(() => {
      if (this.productInFlight === request) this.productInFlight = null;
    });
    this.productInFlight = request;
    return request;
  }

  private async fetchProducts(): Promise<ProductCache> {
    const [spotValue, futuresValue] = await Promise.all([
      this.publicRequest("spot", "/api/v3/exchangeInfo", { symbol: BINANCE_SPOT_SYMBOL }),
      this.publicRequest("futures", "/fapi/v1/exchangeInfo"),
    ]);
    const spotRow = list(record(spotValue).symbols).map(record)
      .find((item) => item.symbol === BINANCE_SPOT_SYMBOL && item.baseAsset === "XAUT" && item.quoteAsset === "USDT");
    const perpetualRow = list(record(futuresValue).symbols).map(record)
      .find((item) => item.symbol === BINANCE_PERPETUAL_SYMBOL && item.baseAsset === "XAUT"
        && item.quoteAsset === "USDT" && item.contractType === "PERPETUAL");
    const status = spotRow && perpetualRow
      ? "available"
      : spotRow ? "perpetual_unavailable" : perpetualRow ? "spot_unavailable" : "both_unavailable";
    const checkedAt = this.now();
    return {
      availability: {
        available: status === "available",
        status,
        spotSymbol: BINANCE_SPOT_SYMBOL,
        perpetualSymbol: BINANCE_PERPETUAL_SYMBOL,
        checkedAt,
        message: status === "available"
          ? null
          : status === "spot_unavailable"
            ? "Binance Mainnet 当前没有可用的 XAUTUSDT 现货产品。"
            : status === "perpetual_unavailable"
              ? "Binance Mainnet 当前没有可用的 XAUTUSDT USD-M 永续产品。"
              : "Binance Mainnet 当前没有可组成 XAUT 同所中性的现货与 USD-M 永续产品。",
      },
      spot: spotRow ? spotSpec(spotRow) : unavailableSpec(),
      perpetual: perpetualRow ? perpetualSpec(perpetualRow) : unavailableSpec(),
    };
  }

  private async signedRequest(
    scope: "spot" | "futures",
    path: string,
    params: Record<string, string> = {},
    allowTimestampRetry = true,
    method: "GET" | "POST" | "DELETE" = "GET",
  ): Promise<unknown> {
    const offset = await this.serverTimeOffset();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params).sort(([left], [right]) => left.localeCompare(right))) query.set(key, value);
    query.set("recvWindow", receiveWindow);
    query.set("timestamp", String(this.now() + offset));
    const signature = createHmac("sha256", this.credentials.apiSecret).update(query.toString()).digest("hex");
    query.set("signature", signature);
    const url = new URL(path, scope === "spot" ? spotBaseUrl : futuresBaseUrl);
    url.search = query.toString();
    try {
      return await this.parseResponse(await this.fetchResponse(url, {
        method,
        headers: { Accept: "application/json", "X-MBX-APIKEY": this.credentials.apiKey },
        signal: AbortSignal.timeout(5_000),
      }));
    } catch (error) {
      if (allowTimestampRetry && error instanceof BinanceProviderError && error.providerCode === -1021) {
        this.timeOffset = null;
        return this.signedRequest(scope, path, params, false, method);
      }
      throw error;
    }
  }

  private async serverTimeOffset() {
    if (this.timeOffset && this.timeOffset.expiresAt > this.now()) return this.timeOffset.value;
    if (!this.timeOffsetInFlight) {
      this.timeOffsetInFlight = (async () => {
        const before = this.now();
        const payload = record(await this.publicRequest("spot", "/api/v3/time"));
        const after = this.now();
        const serverTime = number(payload.serverTime);
        if (!serverTime) throw new BinanceProviderError("provider_time_unavailable", "Binance 未返回有效服务端时间。");
        const value = serverTime - Math.floor((before + after) / 2);
        this.timeOffset = { value, expiresAt: after + timeOffsetTtlMs };
        return value;
      })().finally(() => {
        this.timeOffsetInFlight = null;
      });
    }
    return this.timeOffsetInFlight;
  }

  private async publicRequest(scope: "spot" | "futures", path: string, params: Record<string, string> = {}) {
    const url = new URL(path, scope === "spot" ? spotBaseUrl : futuresBaseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.parseResponse(await this.fetchResponse(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    }));
  }

  private async fetchResponse(url: URL, init: RequestInit) {
    try {
      return await this.fetchFn(url, init);
    } catch (error) {
      if (isAbortError(error)) {
        throw new BinanceProviderError("provider_timeout", "Binance 私有接口响应超时。");
      }
      throw new BinanceProviderError("provider_transport_error", "Binance 私有接口连接失败。");
    }
  }

  private async parseResponse(response: Response) {
    const rawBody = await response.text().catch(() => "");
    let payload: unknown = null;
    try {
      payload = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      throw new BinanceProviderError(categoryFromHttpStatus(response.status, "provider_invalid_response"), httpFailureMessage(response.status), null);
    }
    const root = record(payload);
    const code = Number(root.code ?? response.status);
    if (response.ok && !(Number.isFinite(code) && code < 0)) return payload;
    const category = categoryFromBinanceFailure(response.status, code);
    throw new BinanceProviderError(category, humanMessageForBinanceFailure(category, code), Number.isFinite(code) ? code : null);
  }
}

export class BinanceProviderError extends Error {
  constructor(readonly category: string, message: string, readonly providerCode: number | null = null) {
    super(message);
  }
}

function configuredBinanceEgressIps() {
  const raw = process.env.BINANCE_ALLOWED_EGRESS_IPS?.trim();
  return raw ? raw.split(",").map((value) => value.trim()) : null;
}

function requireConfiguredEgressIps(values: readonly string[] | null) {
  const normalized = normalizeFixedIpv4Set(values);
  if (!normalized) {
    throw new BinanceProviderError(
      "binance_egress_ip_config_missing",
      "服务端未配置有效的 Binance 固定出口 IPv4 白名单。",
    );
  }
  return normalized;
}

function assertProviderIpWhitelist(
  restrictions: Record<string, unknown>,
  configuredEgressIps: ReadonlySet<string>,
): "provider_list_exact" | "provider_restriction_only" {
  if (!boolean(restrictions.ipRestrict)) {
    throw new BinanceProviderError(
      "binance_ip_whitelist_unconfirmed",
      "Binance API Key 未启用固定 IP 白名单，已禁止真实执行。",
    );
  }
  if (!Object.prototype.hasOwnProperty.call(restrictions, "ipList")) {
    return "provider_restriction_only";
  }
  const rawIpList = Array.isArray(restrictions.ipList) ? restrictions.ipList : null;
  const providerIps = normalizeFixedIpv4Set(rawIpList);
  if (!providerIps) {
    throw new BinanceProviderError(
      "binance_ip_whitelist_unconfirmed",
      "Binance 未返回可核对的固定 IP 白名单，已禁止真实执行。",
    );
  }
  if (!sameStringSet(providerIps, configuredEgressIps)) {
    throw new BinanceProviderError(
      "binance_ip_whitelist_mismatch",
      "Binance API Key 的固定 IP 白名单与服务端出口配置不匹配。",
    );
  }
  return "provider_list_exact";
}

function normalizeFixedIpv4Set(values: readonly unknown[] | null) {
  if (!values?.length) return null;
  const normalized = new Set<string>();
  for (const value of values) {
    const ip = typeof value === "string" ? value.trim() : "";
    if (!ip || ip.includes("*") || ip.includes("/") || ip === "0.0.0.0" || isIP(ip) !== 4) return null;
    normalized.add(ip);
  }
  return normalized.size ? normalized : null;
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function assertWhitelistedOrder(request: BinanceOrderRequest) {
  if (request.symbol !== BINANCE_SPOT_SYMBOL || !["spot", "linear"].includes(request.category)) {
    throw new BinanceProviderError("provider_order_rejected", "Binance 真实执行仅允许 XAUTUSDT 现货与 USD-M 永续对冲组合。");
  }
  if (!/^[A-Za-z0-9._:/-]{1,36}$/.test(request.orderLinkId)) {
    throw new BinanceProviderError("provider_order_rejected", "Binance 策略 clientOrderId 格式无效。");
  }
  if (
    !(request.quantityXaut > 0)
    || !(request.limitPrice > 0)
  ) {
    throw new BinanceProviderError("provider_order_rejected", "Binance 策略订单参数超出白名单。");
  }
  if (request.category === "spot" && request.reduceOnly) {
    throw new BinanceProviderError("provider_order_rejected", "Binance 现货侧订单不允许 reduceOnly。");
  }
  if (request.category === "linear") {
    const permitted = (request.side === "Sell" && !request.reduceOnly) || (request.side === "Buy" && request.reduceOnly);
    if (!permitted) throw new BinanceProviderError("provider_order_rejected", "Binance 永续侧订单方向不符合对冲组合白名单。");
  }
}

function toOrder(
  value: unknown,
  category: "spot" | "linear",
  positionQuantityXaut?: number,
): BinanceProviderOrder {
  const row = record(value);
  const requested = number(row.origQty);
  const filled = number(row.executedQty);
  const rawStatus = String(row.status ?? "").toUpperCase();
  const status: BinanceProviderOrder["status"] = rawStatus === "NEW"
    ? "New"
    : rawStatus === "PARTIALLY_FILLED"
      ? "PartiallyFilled"
      : rawStatus === "FILLED"
        ? "Filled"
        : rawStatus === "CANCELED"
          ? "Cancelled"
          : ["EXPIRED", "EXPIRED_IN_MATCH"].includes(rawStatus)
            ? "Expired"
          : rawStatus === "REJECTED" ? "Rejected" : "Unknown";
  return {
    orderId: String(row.orderId ?? ""),
    orderLinkId: String(row.clientOrderId ?? ""),
    status,
    requestedQuantityXaut: requested,
    filledQuantityXaut: filled,
    ...(positionQuantityXaut === undefined ? {} : { positionQuantityXaut }),
    averagePrice: positiveNumberOrNull(row.avgPrice ?? (filled > 0 ? number(row.cummulativeQuoteQty) / filled : 0)),
    feeUsd: category === "linear" ? Math.abs(number(row.commission)) : 0,
    updatedAt: number(row.updateTime ?? row.time ?? Date.now()),
  };
}

function calculateSideLedger(
  fills: Array<{ side: string; quantity: number; price: number; time: number }>,
  openSide: "Buy" | "Sell",
  closeSide: "Buy" | "Sell",
) {
  let quantity = 0;
  let averageEntryPrice = 0;
  let realizedPnl = 0;
  for (const fill of [...fills].sort((left, right) => left.time - right.time)) {
    if (!fill.quantity || !fill.price) continue;
    if (fill.side === openSide) {
      averageEntryPrice = (averageEntryPrice * quantity + fill.price * fill.quantity) / (quantity + fill.quantity);
      quantity += fill.quantity;
    } else if (fill.side === closeSide && quantity > 0) {
      const closed = Math.min(quantity, fill.quantity);
      realizedPnl += openSide === "Buy"
        ? (fill.price - averageEntryPrice) * closed
        : (averageEntryPrice - fill.price) * closed;
      quantity -= closed;
      if (quantity <= 1e-12) {
        quantity = 0;
        averageEntryPrice = 0;
      }
    }
  }
  return { quantity, averageEntryPrice, realizedPnl };
}

function sideSnapshot(
  kind: "spot_long" | "perpetual_short",
  ledger: { quantity: number; averageEntryPrice: number; realizedPnl: number },
  markPrice: number,
  notionalUsd: number,
  unrealizedPnlUsd: number,
) {
  return {
    kind,
    quantityXaut: ledger.quantity,
    averageEntryPrice: positiveNumberOrNull(ledger.averageEntryPrice),
    markPrice: positiveNumberOrNull(markPrice),
    notionalUsd,
    realizedPnlUsd: ledger.realizedPnl,
    unrealizedPnlUsd,
  };
}

function commissionUsd(trade: Record<string, unknown>) {
  const commission = Math.abs(number(trade.commission));
  const asset = String(trade.commissionAsset ?? "");
  return asset === "XAUT" ? commission * positiveNumber(trade.price) : commission;
}

function basisBps(spot: number, perpetual: number) {
  return spot > 0 && perpetual > 0 ? (perpetual - spot) / spot * 10_000 : null;
}

function decimal(value: number) {
  return value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spotSpec(row: Record<string, unknown>): BinanceInstrumentSpec & { quantityPrecision: number } {
  const filters = filterMap(row.filters);
  return {
    status: row.status === "TRADING" && boolean(row.isSpotTradingAllowed) ? "Trading" : row.status === "BREAK" ? "Paused" : "Unknown",
    minOrderQty: positiveNumber(filters.LOT_SIZE?.minQty),
    qtyStep: positiveNumber(filters.LOT_SIZE?.stepSize),
    minNotionalUsd: positiveNumber(filters.NOTIONAL?.minNotional ?? filters.MIN_NOTIONAL?.minNotional),
    priceTick: positiveNumber(filters.PRICE_FILTER?.tickSize),
    quantityPrecision: nonNegativeInteger(row.baseAssetPrecision),
  };
}

function perpetualSpec(row: Record<string, unknown>): BinanceInstrumentSpec & { quantityPrecision: number } {
  const filters = filterMap(row.filters);
  return {
    status: row.status === "TRADING" && row.contractType === "PERPETUAL" ? "Trading" : row.status === "PENDING_TRADING" ? "Paused" : "Unknown",
    minOrderQty: positiveNumber(filters.LOT_SIZE?.minQty),
    qtyStep: positiveNumber(filters.LOT_SIZE?.stepSize),
    minNotionalUsd: positiveNumber(filters.MIN_NOTIONAL?.notional),
    priceTick: positiveNumber(filters.PRICE_FILTER?.tickSize),
    quantityPrecision: nonNegativeInteger(row.quantityPrecision),
  };
}

function unavailableSpec(): BinanceInstrumentSpec & { quantityPrecision: number } {
  return {
    status: "Unknown",
    minOrderQty: 0,
    qtyStep: 0,
    minNotionalUsd: 0,
    priceTick: 0,
    quantityPrecision: -1,
  };
}

function filterMap(value: unknown) {
  return Object.fromEntries(list(value).map(record).map((item) => [String(item.filterType ?? ""), item])) as Record<string, Record<string, unknown>>;
}

function depthUsd(value: unknown) {
  const root = record(value);
  const side = (rows: unknown) => list(rows).reduce<number>((sum, level) => {
    const [price, quantity] = Array.isArray(level) ? level : [];
    return sum + positiveNumber(price) * positiveNumber(quantity);
  }, 0);
  return Math.min(side(root.bids), side(root.asks));
}

function snapshotPositiveNumber(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BinanceProviderError("provider_snapshot_invalid", `Binance ${label}无效。`);
  }
  return parsed;
}

function snapshotPositiveInteger(value: unknown, label: string) {
  const parsed = snapshotPositiveNumber(value, label);
  if (!Number.isInteger(parsed)) {
    throw new BinanceProviderError("provider_snapshot_invalid", `Binance ${label}无效。`);
  }
  return parsed;
}

function nullableTimestamp(value: unknown) {
  const parsed = number(value);
  return parsed > 0 ? parsed : null;
}

function positiveNumberOrNull(value: unknown) {
  const parsed = positiveNumber(value);
  return parsed || null;
}

function positiveNumber(value: unknown) {
  const parsed = number(value);
  return parsed > 0 ? parsed : 0;
}

function nonNegativeInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
}

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotFiniteNumber(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BinanceProviderError("provider_snapshot_invalid", `Binance ${label}无效。`);
  }
  return parsed;
}

function snapshotNonNegativeNumber(value: unknown, label: string) {
  const parsed = snapshotFiniteNumber(value, label);
  if (parsed < 0) {
    throw new BinanceProviderError("provider_snapshot_invalid", `Binance ${label}无效。`);
  }
  return parsed;
}

function boolean(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function isAbortError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  return /abort|timeout/i.test(name);
}

function categoryFromHttpStatus(status: number, fallback: string) {
  if (status === 429) return "provider_rate_limited";
  if (status === 451) return "provider_region_restricted";
  if (status === 401 || status === 403) return "provider_permission_error";
  if (status >= 500) return "provider_unavailable";
  return fallback;
}

function categoryFromBinanceFailure(status: number, code: number) {
  if (status === 429 || code === -1003) return "provider_rate_limited";
  if (code === -1021) return "provider_timestamp_error";
  if (code === -1130) return "provider_request_invalid";
  if (code === -2008 || code === -2014 || code === -2015) return "provider_credential_invalid";
  if (code === -2010 || code === -2011 || code === -2018 || code === -2019) return "provider_rejected";
  if (status === 451) return "provider_region_restricted";
  if (status === 401 || status === 403) return "provider_permission_error";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

function humanMessageForBinanceFailure(category: string, code: number) {
  const suffix = Number.isFinite(code) ? `（code=${code}）` : "";
  if (category === "provider_credential_invalid") return `Binance 未接受当前 API 凭证。${suffix}`;
  if (category === "provider_request_invalid") return `Binance 拒绝了当前凭证请求格式。${suffix}`;
  if (category === "provider_permission_error") return `Binance 账户权限或访问限制不满足要求。${suffix}`;
  if (category === "provider_timestamp_error") return `Binance 时间校验失败。${suffix}`;
  if (category === "provider_rate_limited") return `Binance 请求过于频繁。${suffix}`;
  if (category === "provider_region_restricted") return `Binance 当前拒绝了该地区或网络访问。${suffix}`;
  if (category === "provider_rejected") return `Binance 拒绝了本次请求。${suffix}`;
  return httpFailureMessage(0, suffix);
}

function httpFailureMessage(status: number, suffix = "") {
  if (status === 451) return `Binance 当前拒绝了该地区或网络访问。${suffix}`;
  if (status >= 500) return `Binance 私有接口暂不可用。${suffix}`;
  return `Binance 返回了无效或不可解析的响应。${suffix}`;
}
